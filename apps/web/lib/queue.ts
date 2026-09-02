import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { jobs, type Job } from "@seo/db";
import { parseJobPayload, type JobType } from "@seo/shared";

import { db } from "./db";

/** How long a running job may go without a heartbeat before it is requeued. */
export const STALE_JOB_MINUTES = 10;

/**
 * How often reaping is worth doing. Workers poll every few seconds, so the
 * sweep is throttled rather than run on every claim; a job abandoned ten
 * minutes ago is not more abandoned for waiting another thirty seconds.
 */
const REAP_INTERVAL_MS = 30_000;

/**
 * Serverless memory is per-instance and vanishes on a cold start, which is
 * exactly the right failure mode here: the worst case is reaping more often
 * than needed, never less.
 */
let lastReapAt = 0;

export type EnqueueInput = {
  type: JobType;
  clientId: string | null;
  payload: unknown;
  maxAttempts?: number;
};

/**
 * Puts a job on the queue. The payload is validated here so a malformed
 * enqueue fails in the request that caused it, rather than in the worker
 * minutes later with no user watching.
 */
export async function enqueue(input: EnqueueInput): Promise<Job> {
  const payload = parseJobPayload(input.type, input.payload);

  const [job] = await db()
    .insert(jobs)
    .values({
      type: input.type,
      clientId: input.clientId,
      payload: payload as Record<string, unknown>,
      ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
    })
    .returning();

  if (!job) throw new Error("Failed to enqueue job");
  return job;
}

/**
 * Atomically hands the oldest queued job to a worker.
 *
 * `FOR UPDATE SKIP LOCKED` inside the sub-select is what makes this safe with
 * more than one worker running: each concurrent claim locks a different row
 * instead of blocking or handing the same job out twice. The whole thing is a
 * single statement, so it is atomic without an explicit transaction.
 */
export async function claimNextJob(workerId: string): Promise<Job | null> {
  const rows = await db().execute<Job>(sql`
    update ${jobs}
       set status = 'running',
           attempts = ${jobs.attempts} + 1,
           claimed_by = ${workerId},
           claimed_at = now(),
           heartbeat_at = now()
     where ${jobs.id} = (
             select ${jobs.id}
               from ${jobs}
              where ${jobs.status} = 'queued'
              order by ${jobs.createdAt}
              limit 1
              for update skip locked
           )
    returning ${jobs.id} as "id",
              ${jobs.type} as "type",
              ${jobs.clientId} as "clientId",
              ${jobs.payload} as "payload",
              ${jobs.attempts} as "attempts",
              ${jobs.maxAttempts} as "maxAttempts"
  `);

  const rowList = rows as unknown as Job[];
  return rowList[0] ?? null;
}

export async function heartbeat(
  jobId: string,
  progress?: { step: number; totalSteps: number; label: string; detail?: string },
): Promise<void> {
  await db()
    .update(jobs)
    .set({
      heartbeatAt: new Date(),
      ...(progress ? { progress } : {}),
    })
    .where(eq(jobs.id, jobId));
}

/**
 * Stops a job on the operator's say-so.
 *
 * Only a job that has not finished: cancelling a done job would rewrite
 * history, and cancelling an already-cancelled one twice is a no-op worth
 * reporting honestly rather than pretending to do again.
 *
 * The worker learns about it through the heartbeat it already sends — it is
 * pull-based and has no inbox — so a running job stops within one heartbeat
 * rather than the instant the button is pressed.
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const [canceled] = await db()
    .update(jobs)
    .set({
      status: "canceled",
      error: "Canceled from the app",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.id, jobId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .returning({ id: jobs.id });

  return Boolean(canceled);
}

/** Whether the worker should drop what it is doing. */
export async function isCanceled(jobId: string): Promise<boolean> {
  const [job] = await db()
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  return job?.status === "canceled";
}

export async function completeJob(
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db()
    .update(jobs)
    .set({
      status: "done",
      result,
      finishedAt: new Date(),
      heartbeatAt: new Date(),
      error: null,
    })
    .where(eq(jobs.id, jobId));
}

/**
 * Records a failure. A retryable failure with attempts left goes back to
 * `queued`; anything else is terminal, so the UI can stop showing a spinner.
 */
export async function failJob(
  jobId: string,
  error: string,
  retryable: boolean,
): Promise<{ requeued: boolean }> {
  const [job] = await db().select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new Error(`Job ${jobId} not found`);

  const canRetry = retryable && job.attempts < job.maxAttempts;

  await db()
    .update(jobs)
    .set({
      status: canRetry ? "queued" : "failed",
      error,
      ...(canRetry ? {} : { finishedAt: new Date() }),
    })
    .where(eq(jobs.id, jobId));

  return { requeued: canRetry };
}

/**
 * Rescues jobs whose worker vanished mid-run — the laptop slept, the process
 * was killed, the network dropped. Without this they would sit in `running`
 * forever and the UI would spin indefinitely.
 */
export async function requeueStaleJobs(): Promise<{ requeued: number; failed: number }> {
  const cutoff = sql`now() - interval '${sql.raw(String(STALE_JOB_MINUTES))} minutes'`;

  const stale = await db()
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "running"),
        sql`coalesce(${jobs.heartbeatAt}, ${jobs.claimedAt}) < ${cutoff}`,
      ),
    );

  const toRequeue = stale.filter((j) => j.attempts < j.maxAttempts).map((j) => j.id);
  const toFail = stale.filter((j) => j.attempts >= j.maxAttempts).map((j) => j.id);

  if (toRequeue.length > 0) {
    await db()
      .update(jobs)
      .set({
        status: "queued",
        error: `Worker stopped responding; requeued after ${STALE_JOB_MINUTES} minutes.`,
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
      })
      .where(inArray(jobs.id, toRequeue));
  }

  if (toFail.length > 0) {
    await db()
      .update(jobs)
      .set({
        status: "failed",
        error: `Worker stopped responding and no attempts remain.`,
        finishedAt: new Date(),
      })
      .where(inArray(jobs.id, toFail));
  }

  return { requeued: toRequeue.length, failed: toFail.length };
}

/**
 * Reaps, but at most once every {@link REAP_INTERVAL_MS}.
 *
 * Recovery used to hang off a Vercel cron, which the Hobby plan caps at one run
 * per day — an abandoned job would sit unrescued for up to twenty-four hours,
 * and a schedule any tighter fails the deployment outright. Hanging it off the
 * claim endpoint instead removes both problems: the sweep runs whenever a
 * worker asks for work, which is precisely when a rescued job can be handed
 * straight back out.
 */
export async function maybeRequeueStaleJobs(): Promise<void> {
  const now = Date.now();
  if (now - lastReapAt < REAP_INTERVAL_MS) return;
  lastReapAt = now;

  try {
    await requeueStaleJobs();
  } catch {
    // Reaping is maintenance. A worker asking for work must still get an
    // answer, so a failure here is never allowed to fail the claim.
  }
}

/** Most recent job of a type for a client — drives the per-tool status badges. */
export async function latestJob(
  clientId: string,
  type: JobType,
): Promise<Job | null> {
  const [job] = await db()
    .select()
    .from(jobs)
    .where(and(eq(jobs.clientId, clientId), eq(jobs.type, type)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return job ?? null;
}

export async function activeJobs(clientId: string): Promise<Job[]> {
  return db()
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.clientId, clientId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(jobs.createdAt));
}
