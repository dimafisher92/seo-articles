import {
  parseJobPayload,
  type ClaimedJob,
  type JobType,
} from "@seo/shared";
import { closeDb } from "@seo/db";

import { claimJob, reportComplete, reportFailure, reportProgress } from "./api.js";
import { ClaudeStageError, sleep } from "./claude.js";
import { assertClaudeCredentials, config } from "./config.js";
import { log } from "./log.js";
import { runContentPlan } from "./pipelines/content-plan.js";
import { runCrawlSite } from "./pipelines/crawl-site.js";
import { runKeywordResearch } from "./pipelines/keyword-research.js";
import { runRegenerateImage } from "./pipelines/regenerate-image.js";
import { describeImageProvider } from "./providers/images.js";
import { describeKeywordProvider } from "./providers/keywords.js";
import { runWriteArticle } from "./pipelines/write-article.js";
import type { StageReporter } from "./pipelines/types.js";

/**
 * The worker loop.
 *
 * Jobs run strictly one at a time. Article generation is token-heavy, and a
 * Claude subscription has a shared rate limit — running two in parallel would
 * mean both stalling on backoff rather than one finishing sooner.
 */

let shuttingDown = false;
let currentJobId: string | null = null;

async function executeJob(job: ClaimedJob): Promise<Record<string, unknown>> {
  const report = makeReporter(job.id);

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
 * Progress callback that also serves as the heartbeat.
 *
 * A stage can run for many minutes between calls, so a background timer keeps
 * the heartbeat alive in between — otherwise the app's reaper would decide the
 * worker had died and requeue a job that is in fact running fine.
 */
function makeReporter(jobId: string): StageReporter {
  let latest = { step: 0, totalSteps: 1, label: "Starting" };

  return async (step, totalSteps, label, detail) => {
    latest = { step, totalSteps, label };
    log.info(`  [${step}/${totalSteps}] ${label}${detail ? ` — ${detail}` : ""}`);
    await reportProgress(jobId, {
      step,
      totalSteps,
      label,
      ...(detail ? { detail } : {}),
    });
    void latest;
  };
}

function startHeartbeat(jobId: string): () => void {
  const timer = setInterval(() => {
    void reportProgress(jobId, {
      step: 0,
      totalSteps: 1,
      label: "Working",
      detail: "heartbeat",
    });
  }, config.heartbeatSeconds * 1000);

  // Do not keep the process alive purely for the heartbeat.
  timer.unref?.();
  return () => clearInterval(timer);
}

async function tick(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;

  currentJobId = job.id;
  const started = Date.now();
  log.info(
    `▶ ${job.type} (${job.id.slice(0, 8)}) attempt ${job.attempts}/${job.maxAttempts}`,
  );

  // The heartbeat runs alongside the job, not inside the progress callback,
  // because a single stage can be silent for far longer than the reaper's
  // patience.
  const stopHeartbeat = startHeartbeat(job.id);

  try {
    const result = await executeJob(job);
    await reportComplete(job.id, result);
    log.info(
      `✔ ${job.type} finished in ${Math.round((Date.now() - started) / 1000)}s`,
      result,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable =
      error instanceof ClaudeStageError ? error.retryable : isTransient(message);

    log.error(`✖ ${job.type} failed: ${message}`);
    await reportFailure(job.id, message, retryable).catch((reportError) => {
      log.error("Could not report the failure to the app", reportError);
    });
  } finally {
    stopHeartbeat();
    currentJobId = null;
  }

  return true;
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
    `Claude: ${config.claude.oauthToken ? "subscription (OAuth token)" : "API key"} · ` +
      `model ${config.claude.model}`,
  );

  log.info(describeKeywordProvider());
  log.info(describeImageProvider());

  let idleLogged = false;

  while (!shuttingDown) {
    let didWork = false;
    try {
      didWork = await tick();
      idleLogged = false;
    } catch (error) {
      // Losing the app connection should not kill the worker — the laptop may
      // just have changed networks. Back off and keep trying.
      log.error("Poll failed", error);
      await sleep(Math.min(config.pollIntervalSeconds * 6, 60) * 1000);
      continue;
    }

    if (runOnce) break;

    if (!didWork) {
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
