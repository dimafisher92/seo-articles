/**
 * Where an article's minutes went.
 *
 * `runStage` has always measured how long each stage took and written it to
 * `log.debug` — which the default `LOG_LEVEL=info` hides. So the numbers
 * existed, nobody saw them, and every argument about why generation takes
 * forty minutes was made from guesswork. This collects them into the job
 * result, where they are stored per article and can be compared across runs.
 *
 * Pure and taking nothing from the worker's config, so it can be tested
 * without a database or an APP_URL.
 */

export type Timings = Record<string, number>;

export type Timer = {
  /** Runs `work`, recording how long it took under `label`. */
  measure<T>(label: string, work: () => Promise<T>): Promise<T>;
  /** Seconds per label, plus the wall-clock total. */
  summary(): Timings;
};

export function createTimer(now: () => number = Date.now): Timer {
  const started = now();
  const seconds: Timings = {};

  return {
    async measure(label, work) {
      const from = now();
      try {
        return await work();
      } finally {
        // Recorded even when the stage throws: a stage that spent twenty
        // minutes before failing is the most interesting number on the page.
        // Repeats accumulate — three revision passes are one `revise` total,
        // which is the figure worth comparing.
        seconds[label] = round((seconds[label] ?? 0) + (now() - from) / 1000);
      }
    },

    summary() {
      // `total` is wall-clock, so it is smaller than the sum of the parts
      // whenever stages overlap. That gap is the point of overlapping them.
      return { ...seconds, total: round((now() - started) / 1000) };
    },
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
