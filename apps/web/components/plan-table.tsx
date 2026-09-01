"use client";

import {
  ChevronDown,
  FileText,
  PenLine,
  Settings2,
  Target,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { PlanItem } from "@seo/db";
import type { ImageMode } from "@seo/shared";

import { writeArticle } from "@/app/actions/articles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { canRegenerate, REGENERATE_CONFIRMATION } from "@/lib/regenerate";
import { cn } from "@/lib/utils";

const STATUS: Record<
  PlanItem["status"],
  { label: string; variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline" }
> = {
  planned: { label: "Not written", variant: "outline" },
  queued: { label: "Queued", variant: "warning" },
  generating: { label: "Writing…", variant: "warning" },
  drafted: { label: "Draft ready", variant: "success" },
  approved: { label: "Approved", variant: "success" },
  exported: { label: "Exported", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
};

/**
 * The content plan: titles only, with a write button on every row.
 *
 * Commissioning one article at a time is the point of this screen — a batch
 * button would spend hours of subscription budget on pieces nobody has read the
 * brief for.
 */
export function PlanTable({
  clientId,
  items,
}: {
  clientId: string;
  items: PlanItem[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [imageMode, setImageMode] = useState<ImageMode>("mixed");
  const [inlineImages, setInlineImages] = useState(3);
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {items.length} article{items.length === 1 ? "" : "s"} planned
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowSettings((v) => !v)}
        >
          <Settings2 />
          Image settings
        </Button>
      </div>

      {showSettings ? (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <label className="flex items-center gap-2">
            Images
            <select
              value={imageMode}
              onChange={(e) => setImageMode(e.target.value as ImageMode)}
              className="h-8 rounded-md border border-input bg-card px-2"
            >
              <option value="mixed">Brand photos where they fit, else generate</option>
              <option value="generate">Always generate</option>
              <option value="brand_assets">Only the client&apos;s own photos</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            In-body images
            <input
              type="number"
              min={0}
              max={6}
              value={inlineImages}
              onChange={(e) => setInlineImages(Number(e.target.value))}
              className="h-8 w-16 rounded-md border border-input bg-card px-2"
            />
            <span className="text-muted-foreground">plus a hero</span>
          </label>
        </div>
      ) : null}

      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {items.map((item) => {
          const isOpen = expanded === item.id;
          const status = STATUS[item.status];

          return (
            <li key={item.id} className="bg-card">
              <div className="flex flex-wrap items-start gap-3 px-4 py-3">
                <button
                  onClick={() => setExpanded(isOpen ? null : item.id)}
                  className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={isOpen ? "Collapse brief" : "Expand brief"}
                >
                  <ChevronDown
                    className={cn(
                      "size-4 transition-transform",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>

                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-snug">{item.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Target className="size-3" />
                      {item.mainKeyword}
                    </span>
                    {item.cluster ? <span>{item.cluster}</span> : null}
                    {item.intent ? <span>{item.intent}</span> : null}
                    {item.targetWordCount ? (
                      <span>{item.targetWordCount} words</span>
                    ) : null}
                  </div>
                </div>

                <Badge variant={status.variant} className="mt-1 shrink-0">
                  {status.label}
                </Badge>

                {/*
                  Both actions, not one instead of the other. `articleId` is set
                  the moment generation starts and never cleared, so keying the
                  choice on it meant a row that had ever been generated showed
                  only "Open article" — the retry inside WriteButton could not
                  render even for a failed item.
                */}
                <div className="flex shrink-0 items-start gap-2">
                  {item.articleId ? (
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/clients/${clientId}/articles/${item.articleId}`}>
                        <FileText />
                        Open article
                      </Link>
                    </Button>
                  ) : null}

                  <WriteButton
                    planItemId={item.id}
                    status={item.status}
                    hasArticle={Boolean(item.articleId)}
                    imageMode={imageMode}
                    inlineImageCount={inlineImages}
                  />
                </div>
              </div>

              {isOpen ? (
                <div className="space-y-3 border-t border-border/60 bg-muted/25 px-4 py-4 text-sm">
                  {item.rationale ? (
                    <p className="text-muted-foreground">{item.rationale}</p>
                  ) : null}

                  {item.secondaryKeywords.length > 0 ? (
                    <Detail label="Also covers">
                      <div className="flex flex-wrap gap-1.5">
                        {item.secondaryKeywords.map((keyword) => (
                          <Badge key={keyword} variant="secondary">
                            {keyword}
                          </Badge>
                        ))}
                      </div>
                    </Detail>
                  ) : null}

                  {item.serpNotes?.dominantAngle ? (
                    <Detail label="What the top 10 does">
                      <p className="text-muted-foreground">
                        {item.serpNotes.dominantAngle}
                      </p>
                    </Detail>
                  ) : null}

                  {item.serpNotes?.missingAngles?.length ? (
                    <Detail label="Where the opening is">
                      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                        {item.serpNotes.missingAngles.map((angle) => (
                          <li key={angle}>{angle}</li>
                        ))}
                      </ul>
                    </Detail>
                  ) : null}

                  {item.internalLinkTargets.length > 0 ? (
                    <Detail label="Links to">
                      <ul className="space-y-0.5 text-muted-foreground">
                        {item.internalLinkTargets.map((target) => (
                          <li key={target.url}>
                            {target.label} — {target.url}
                          </li>
                        ))}
                      </ul>
                    </Detail>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function WriteButton({
  planItemId,
  status,
  hasArticle,
  imageMode,
  inlineImageCount,
}: {
  planItemId: string;
  status: PlanItem["status"];
  hasArticle: boolean;
  imageMode: ImageMode;
  inlineImageCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const busy = !canRegenerate(status);
  const label = status === "failed" ? "Retry" : hasArticle ? "Regenerate" : "Write article";

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant={hasArticle && status !== "failed" ? "ghost" : "default"}
        disabled={pending || busy}
        onClick={() =>
          startTransition(async () => {
            // Regeneration overwrites an article that took the better part of
            // an hour to produce, so it asks first. A retry has nothing to
            // lose and does not.
            if (
              hasArticle &&
              status !== "failed" &&
              !window.confirm(REGENERATE_CONFIRMATION)
            ) {
              return;
            }

            setError(null);
            const result = await writeArticle(planItemId, {
              imageMode,
              inlineImageCount,
            });
            if (result.ok) router.refresh();
            else setError(result.error);
          })
        }
      >
        {pending || busy ? <Spinner /> : <PenLine />}
        {label}
      </Button>
      {error ? (
        <p className="max-w-[220px] text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
