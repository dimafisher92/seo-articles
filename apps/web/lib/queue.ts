import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { jobs, type Job } from "@seo/db";
import { parseJobPayload, type JobType } from "@seo/shared";

import { db } from "./db";

/** How long a running job may go without a heartbeat before it is requeued. */
export const STALE_JOB_MINUTES = 10;

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
