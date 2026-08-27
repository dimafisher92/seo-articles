"use client";

import { AlertCircle, Clock, Loader2 } from "lucide-react";

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
          {progress && progress.step > 0 ? (
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
              {progress.step}/{progress.totalSteps}
            </span>
          ) : null}
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
