/**
 * Which jobs the banner should show.
 *
 * Separate from the component so the rule can be tested directly: the previous
 * one looked reasonable and was wrong in a way no type checker would catch, and
 * it took a screenshot of a successful run wearing an hour-old error message to
 * notice.
 */

export type JobView = {
  id: string;
  type: string;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  progress: {
    step: number;
    totalSteps: number;
    label: string;
    detail?: string;
  } | null;
  error: string | null;
  result: Record<string, unknown> | null;
  attempts: number;
  createdAt: string;
  finishedAt: string | null;
};

/**
 * Whatever is running, plus a failure that is still the last word on its kind
 * of work.
 *
 * That qualifier is the point. Scanning for any failed job surfaces one a later
 * successful run has already superseded — a keyword run that failed an hour ago
 * goes on claiming the page has failed through every successful run after it,
 * until twenty newer jobs push it out of the list.
 *
 * `jobs` arrives newest first, so the first entry of a type is its latest, and
 * only that one may report a failure. A failure of one kind of work never hides
 * another kind still running.
 */
export function jobsToShow(jobs: JobView[]): JobView[] {
  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );

  const latestByType = new Map<string, JobView>();
  for (const job of jobs) {
    if (!latestByType.has(job.type)) latestByType.set(job.type, job);
  }

  const activeTypes = new Set(active.map((job) => job.type));
  const failures = [...latestByType.values()].filter(
    (job) => job.status === "failed" && !activeTypes.has(job.type),
  );

  return [...active, ...failures];
}
