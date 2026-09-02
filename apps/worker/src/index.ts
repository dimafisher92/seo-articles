import {
  parseJobPayload,
  type ClaimedJob,
  type JobType,
} from "@seo/shared";
import { closeDb } from "@seo/db";

import {
  claimJob,
  deferJob,
  reportComplete,
  reportFailure,
  reportProgress,
} from "./api.js";
import {
  ClaudeStageError,
  ClaudeUsageLimitError,
  setJobSignal,
  sleep,
} from "./claude.js";
import { assertClaudeCredentials, config, describeStageModels } from "./config.js";
import { log } from "./log.js";
import { runContentPlan } from "./pipelines/content-plan.js";
import { runCrawlSite } from "./pipelines/crawl-site.js";
import { runKeywordResearch } from "./pipelines/keyword-research.js";
import { runRegenerateImage } from "./pipelines/regenerate-image.js";
import { describeImageProvider } from "./providers/images.js";
import { describeKeywordProvider } from "./providers/keywords.js";
import { runWriteArticle } from "./pipelines/write-article.js";
import type { StageReporter } from "./pipelines/types.js";
import {
  JobCanceledError,
  JobTimeoutError,
  makeReporter,
  startHeartbeat,
  withDeadline,
} from "./progress.js";

/**
 * The worker loop.
 *
 * Jobs run strictly one at a time. Article generation is token-heavy, and a
 * Claude subscription has a shared rate limit — running two in parallel would
 * mean both stalling on backoff rather than one finishing sooner.
 */

let shuttingDown = false;
let currentJobId: string | null = null;

async function executeJob(
  job: ClaimedJob,
  report: StageReporter,
): Promise<Record<string, unknown>> {
  switch (job.type) {
    case "crawl_site": {
      const payload = parseJobPayload("crawl_site", job.payload);
      return runCrawlSite(payload, report);
    }
    case "keyword_research": {
      const payload = parseJobPayload("keyword_research", job.payload);
      return runKeywordResearch(payload, report);
    }
    case "content_plan": {
      const payload = parseJobPayload("content_plan", job.payload);
      return runContentPlan(payload, report);
    }
    case "write_article": {
      const payload = parseJobPayload("write_article", job.payload);
      return runWriteArticle(payload, report);
    }
    case "regenerate_image": {
      const payload = parseJobPayload("regenerate_image", job.payload);
      return runRegenerateImage(payload, report);
    }
    default: {
      const exhaustive: never = job.type;
      throw new Error(`Unknown job type: ${String(exhaustive)}`);
    }
  }
}

/**
 * How long to wait when the subscription is spent and the message did not say.
 *
 * Long enough not to hammer a closed window, short enough that a limit which
 * lifts early is not slept through.
 */
const DEFAULT_LIMIT_WAIT_MINUTES = 15;

type TickResult =
  | { did: "nothing" }
  | { did: "work" }
  /** The subscription is spent; nobody should ask again until it reopens. */
  | { did: "hit-limit"; waitMinutes: number };

async function tick(): Promise<TickResult> {
  const job = await claimJob();
  if (!job) return { did: "nothing" };

  currentJobId = job.id;
  const started = Date.now();
  log.info(
    `▶ ${job.type} (${job.id.slice(0, 8)}) attempt ${job.attempts}/${job.maxAttempts}`,
  );

  // The heartbeat runs alongside the job, not inside the progress callback,
  // because a single stage can be silent for far longer than the reaper's
  // patience. It reports the stage the job is actually on, so "slow" and
  // "stuck" stay distinguishable from the outside.
  const { report, current } = makeReporter(job.id, reportProgress, (line) =>
    log.info(line),
  );

  // Stop, pressed in the app, arrives on the heartbeat's response. Aborting
  // here reaches the stage that is running right now instead of waiting for it
  // to finish — a draft has twenty-five minutes of rope.
  const cancel = new AbortController();
  setJobSignal(cancel.signal);

  const stopHeartbeat = startHeartbeat(
    job.id,
    current,
    reportProgress,
    config.heartbeatSeconds * 1000,
    () => {
      log.warn(`Job ${job.id.slice(0, 8)} was stopped from the app`);
      cancel.abort();
    },
  );

  try {
    const result = await withDeadline(
      executeJob(job, report),
      current,
      config.jobTimeoutMinutes * 60_000,
    );
    await reportComplete(job.id, result);
    log.info(
      `✔ ${job.type} finished in ${Math.round((Date.now() - started) / 1000)}s`,
      result,
    );
  } catch (error) {
    // Cancelled is neither done nor failed. The app set the status when it
    // asked, so reporting anything here would overwrite the operator's own
    // decision with our account of it.
    if (error instanceof JobCanceledError || cancel.signal.aborted) {
      log.info(`■ ${job.type} stopped after ${Math.round((Date.now() - started) / 1000)}s`);
      stopHeartbeat();
      setJobSignal(undefined);
      currentJobId = null;
      return { did: "work" };
    }

    // Nothing is wrong with this job and there is nothing to fix. Hand it back
    // without spending its attempt, and stop asking for work until the window
    // reopens — otherwise the worker takes it straight back and walks into the
    // same wall, three times in ten minutes.
    if (error instanceof ClaudeUsageLimitError) {
      const waitMinutes = error.resetMinutes ?? DEFAULT_LIMIT_WAIT_MINUTES;
      log.warn(
        `${error.message}. Putting ${job.type} back and pausing for ${waitMinutes} min.`,
      );
      await deferJob(job.id, error.message).catch((deferError) => {
        log.error("Could not hand the job back", deferError);
      });
      stopHeartbeat();
      setJobSignal(undefined);
      currentJobId = null;
      return { did: "hit-limit", waitMinutes };
    }

    const message = error instanceof Error ? error.message : String(error);
    // A timeout is not a blip. The job ran for the whole deadline and would
    // spend it again to reach the same place: three attempts at 45 minutes is
    // over two hours of subscription tokens for a result already known. What
    // it wrote is saved; retrying it is not.
    const retryable =
      error instanceof JobTimeoutError
        ? false
        : error instanceof ClaudeStageError
          ? error.retryable
          : isTransient(message);

    log.error(`✖ ${job.type} failed: ${message}`);
    await reportFailure(job.id, message, retryable).catch((reportError) => {
      log.error("Could not report the failure to the app", reportError);
    });
  } finally {
    stopHeartbeat();
    setJobSignal(undefined);
    currentJobId = null;
  }

  return { did: "work" };
}

/** Network blips and provider hiccups deserve a retry; bad data does not. */
function isTransient(message: string): boolean {
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|502|503|504|timeout/i.test(
    message,
  );
}

async function main(): Promise<void> {
  const runOnce = process.argv.includes("--once");

  assertClaudeCredentials();
  log.info(`Worker ${config.workerId} polling ${config.appUrl}`);
  log.info(
    `Claude: ${config.claude.oauthToken ? "subscription (OAuth token)" : "API key"}`,
  );
  log.info(`  ${describeStageModels()}`);

  log.info(describeKeywordProvider());
  log.info(describeImageProvider());

  let idleLogged = false;

  while (!shuttingDown) {
    let result: TickResult = { did: "nothing" };
    try {
      result = await tick();
      idleLogged = false;
    } catch (error) {
      // Losing the app connection should not kill the worker — the laptop may
      // just have changed networks. Back off and keep trying.
      log.error("Poll failed", error);
      await sleep(Math.min(config.pollIntervalSeconds * 6, 60) * 1000);
      continue;
    }

    if (runOnce) break;

    if (result.did === "hit-limit") {
      const until = new Date(Date.now() + result.waitMinutes * 60_000);
      log.info(
        `Paused until ${until.toISOString().slice(11, 16)} UTC — ` +
          "the queue keeps filling, nothing is lost",
      );
      // In small steps so a shutdown does not have to wait out the whole pause.
      const deadline = Date.now() + result.waitMinutes * 60_000;
      while (!shuttingDown && Date.now() < deadline) {
        await sleep(Math.min(30_000, deadline - Date.now()));
      }
      continue;
    }

    if (result.did === "nothing") {
      if (!idleLogged) {
        log.info("Queue empty — waiting for work");
        idleLogged = true;
      }
      await sleep(config.pollIntervalSeconds * 1000);
    }
  }

  await closeDb();
  log.info("Worker stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info(
      currentJobId
        ? `${signal} received — finishing the current job, press again to force quit`
        : `${signal} received — stopping`,
    );
  });
}

main().catch((error) => {
  log.error("Worker crashed", error);
  process.exit(1);
});
