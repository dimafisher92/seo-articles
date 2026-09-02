"use client";

import { AlertCircle, Clock, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { stopJob } from "@/app/actions/jobs";
import { jobsToShow, type JobView } from "@/lib/job-banner";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<string, string> = {
  crawl_site: "Site crawl",
  keyword_research: "Keyword research",
  content_plan: "Content plan",
  write_article: "Article",
  regenerate_image: "Image",
};

/**
 * Live status for a running job.
 *
 * A queued job is called out explicitly rather than shown as a generic
 * spinner: with the worker on someone's laptop, "waiting for the worker" is a
 * real and recoverable state, and telling the user that is more useful than an
 * animation that never advances.
 */
export function JobStatus({
  job,
  className,
}: {
  job: JobView;
  className?: string;
}) {
  const label = TYPE_LABEL[job.type] ?? job.type;

  // Waiting out a spent Claude subscription is not a failure and should not
  // look like one: nothing is broken, the queue is intact, and it resumes on
  // its own. The job is back in `queued` with the reason attached.
  if (job.status === "queued" && /subscription limit/i.test(job.error ?? "")) {
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm",
          className,
        )}
      >
        <Clock className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <p className="font-medium">{label} paused</p>
          <p className="mt-0.5 break-words text-xs text-muted-foreground">
            {job.error} — it resumes on its own, nothing is lost.
          </p>
        </div>
        <StopButton jobId={job.id} className="ml-auto" />
      </div>
    );
  }

  if (job.status === "queued") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm",
          className,
        )}
      >
        <Clock className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          {label} queued — waiting for the worker to pick it up.
        </span>
        <StopButton jobId={job.id} className="ml-auto" />
      </div>
    );
  }

  if (job.status === "running") {
    const progress = job.progress;
    const percent =
      progress && progress.totalSteps > 0
        ? Math.round((progress.step / progress.totalSteps) * 100)
        : null;

    return (
      <div
        className={cn(
          "space-y-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5",
          className,
        )}
      >
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          <span className="font-medium">{label}</span>
          <span className="truncate text-muted-foreground">
            {progress?.label ?? "Starting"}
            {progress?.detail && progress.detail !== "heartbeat"
              ? ` — ${progress.detail}`
              : ""}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {progress && progress.step > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {progress.step}/{progress.totalSteps}
              </span>
            ) : null}
            <StopButton jobId={job.id} />
          </span>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-primary/15">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${percent ?? 5}%` }}
          />
        </div>
      </div>
    );
  }

  if (job.status === "failed") {
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm",
          className,
        )}
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="font-medium text-destructive">{label} failed</p>
          {job.error ? (
            <p className="mt-0.5 break-words text-xs text-muted-foreground">
              {job.error}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return null;
}

/**
 * Stops a job that is queued or running.
 *
 * The worker is a separate process on another machine and pulls its work, so
 * this cannot reach in and kill anything. It marks the job cancelled; the
 * worker finds out through the heartbeat it already sends, within a minute.
 * The label says "Stopping…" rather than "Stopped" for exactly that reason.
 *
 * No confirmation dialog: the thing being interrupted is a job that can be
 * started again, and a job worth stopping is usually one that is already
 * misbehaving.
 */
function StopButton({
  jobId,
  className,
}: {
  jobId: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  return (
    <button
      type="button"
      disabled={pending || sent}
      title={error ?? "Stop this job"}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors",
        "hover:border-destructive/40 hover:text-destructive disabled:opacity-60 disabled:hover:border-border disabled:hover:text-muted-foreground",
        error && "border-destructive/40 text-destructive",
        className,
      )}
      onClick={() =>
        startTransition(async () => {
          setError(null);
          const result = await stopJob(jobId);
          if (result.ok) {
            setSent(true);
            router.refresh();
          } else {
            setError(result.error);
          }
        })
      }
    >
      <X className="size-3" />
      {error ? "Could not stop" : sent ? "Stopping…" : "Stop"}
    </button>
  );
}

/** Stacks every job worth showing. The rule itself lives in lib/job-banner. */
export function JobStatusList({
  jobs,
  className,
}: {
  jobs: JobView[];
  className?: string;
}) {
  const shown = jobsToShow(jobs);
  if (shown.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)}>
      {shown.map((job) => (
        <JobStatus key={job.id} job={job} />
      ))}
    </div>
  );
}
