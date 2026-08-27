"use client";

import { Check, X } from "lucide-react";

import type { QaReport, SeoScore } from "@seo/db";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Live on-page checks.
 *
 * Runs the same rubric the worker's QA stage used, so an edit that breaks a
 * check shows up while the writer is still in the document rather than at the
 * next generation.
 */
export function SeoPanel({
  score,
  qaReport,
  wordCount,
  readingTime,
}: {
  score: SeoScore | null;
  qaReport: QaReport | null;
  wordCount: number | null;
  readingTime: number | null;
}) {
  const failed = score?.checks.filter((c) => !c.passed) ?? [];
  const passed = score?.checks.filter((c) => c.passed) ?? [];

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">On-page score</h2>
          <span
            className={cn(
              "text-2xl font-semibold tabular-nums",
              (score?.total ?? 0) >= 80
                ? "text-success"
                : (score?.total ?? 0) >= 60
                  ? "text-primary"
                  : "text-destructive",
            )}
          >
            {score?.total ?? 0}
          </span>
        </div>

        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              (score?.total ?? 0) >= 80
                ? "bg-success"
                : (score?.total ?? 0) >= 60
                  ? "bg-primary"
                  : "bg-destructive",
            )}
            style={{ width: `${score?.total ?? 0}%` }}
          />
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          {wordCount ? `${wordCount} words` : "no body yet"}
          {readingTime ? ` · ${readingTime} min read` : ""}
        </p>
      </div>

      {failed.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Needs attention ({failed.length})
          </h3>
          <ul className="space-y-1.5">
            {failed.map((check) => (
              <li key={check.id} className="flex items-start gap-2 text-sm">
                <X className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <span className="min-w-0">
                  {check.label}
                  {check.detail ? (
                    <span className="block text-xs text-muted-foreground">
                      {check.detail}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {passed.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
            Passing ({passed.length})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {passed.map((check) => (
              <li
                key={check.id}
                className="flex items-start gap-2 text-sm text-muted-foreground"
              >
                <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                <span>{check.label}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {qaReport?.issues && qaReport.issues.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Editorial review
          </h3>
          <ul className="space-y-2">
            {qaReport.issues.map((issue, index) => (
              <li key={index} className="text-sm">
                <Badge
                  variant={
                    issue.severity === "high"
                      ? "destructive"
                      : issue.severity === "medium"
                        ? "warning"
                        : "secondary"
                  }
                  className="mb-1"
                >
                  {issue.severity}
                </Badge>
                <p className="text-muted-foreground">{issue.note}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {qaReport?.appliedFixes && qaReport.appliedFixes.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
            Revisions applied ({qaReport.appliedFixes.length})
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {qaReport.appliedFixes.map((fix, index) => (
              <li key={index}>{fix}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Character counters for the two length-capped SERP fields. */
export function LengthMeter({
  value,
  min,
  max,
  label,
}: {
  value: string;
  min?: number;
  max: number;
  label: string;
}) {
  const length = value.length;
  const ok = length <= max && (min === undefined || length >= min);

  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        ok ? "text-muted-foreground" : "text-destructive",
      )}
    >
      {label}: {length}/{max}
      {min !== undefined && length < min ? ` (min ${min})` : ""}
    </span>
  );
}
