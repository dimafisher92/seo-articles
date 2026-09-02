/**
 * Progress reporting, heartbeats and the job deadline.
 *
 * Separate from the worker loop, and taking its sink and its timings by
 * injection, so the two behaviours that are easy to break silently can be
 * tested without a network or a running worker:
 *
 *   - the heartbeat must re-send the stage the job is actually on. Sending a
 *     generic "Working" overwrites the real stage in the UI a minute after it
 *     appears, which makes a slow job indistinguishable from a stuck one.
 *   - a job must have a deadline. The heartbeat is on a timer and knows nothing
 *     about whether work is advancing, so a job wedged inside a provider call
 *     reports itself alive forever: the reaper leaves it alone, and it can
 *     neither be waited out nor cancelled.
 */

import type { StageReporter } from "./pipelines/types.js";

export type Stage = { step: number; totalSteps: number; label: string };

export type ProgressUpdate = Stage & { detail?: string };

/** Returns true when the job has been cancelled and should stop. */
export type ProgressSink = (
  jobId: string,
  update: ProgressUpdate,
) => Promise<boolean | void> | boolean | void;

export type Reporter = {
  report: StageReporter;
  /** The stage now in progress — what the heartbeat re-sends. */
  current: () => Stage;
};

export function makeReporter(
  jobId: string,
  sink: ProgressSink,
  onLog: (line: string) => void = () => {},
): Reporter {
  let latest: Stage = { step: 0, totalSteps: 1, label: "Starting" };

  return {
    current: () => latest,
    report: async (step, totalSteps, label, detail) => {
      latest = { step, totalSteps, label };
      onLog(`  [${step}/${totalSteps}] ${label}${detail ? ` — ${detail}` : ""}`);
      const canceled = await sink(jobId, {
        step,
        totalSteps,
        label,
        ...(detail ? { detail } : {}),
      });
      if (canceled) throw new JobCanceledError();
    },
  };
}

/**
 * @param onCanceled called when the sink reports the job was cancelled — the
 * only moment a running job hears about a Stop pressed in the app.
 */
export function startHeartbeat(
  jobId: string,
  current: () => Stage,
  sink: ProgressSink,
  intervalMs: number,
  onCanceled: () => void = () => {},
): () => void {
  const timer = setInterval(() => {
    void (async () => {
      if (await sink(jobId, { ...current(), detail: "still running" })) {
        onCanceled();
      }
    })();
  }, intervalMs);

  // Do not keep the process alive purely for the heartbeat.
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Raised when the job was stopped from the app.
 *
 * Thrown rather than returned so it unwinds a pipeline from wherever it is,
 * the same way a timeout does. It is not a failure: nothing is reported back,
 * because the app already knows — it is what asked.
 */
export class JobCanceledError extends Error {
  constructor() {
    super("Stopped from the app");
    this.name = "JobCanceledError";
  }
}

/** Raised when a job outlives its deadline, carrying the stage it died on. */
export class JobTimeoutError extends Error {
  constructor(
    readonly minutes: number,
    readonly stage: Stage,
  ) {
    super(
      `Gave up after ${minutes} minutes, stuck on "${stage.label}" ` +
        `(step ${stage.step}/${stage.totalSteps}). ` +
        "The provider call it was waiting on never returned.",
    );
    this.name = "JobTimeoutError";
  }
}

/**
 * Fails a job that stops making progress, naming the stage it stopped on.
 *
 * The stage is read when the deadline fires rather than when it is armed, so
 * the message points at where the job actually wedged.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  current: () => Stage,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new JobTimeoutError(Math.round(timeoutMs / 60_000), current())),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
