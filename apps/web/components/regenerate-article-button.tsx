"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { PlanItem } from "@seo/db";

import { regenerateArticle } from "@/app/actions/articles";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import {
  canRegenerate,
  regenerateLabel,
  REGENERATE_CONFIRMATION,
} from "@/lib/regenerate";

/**
 * Re-runs the whole pipeline for one article, from the article itself.
 *
 * The plan table has had this for a while and it was not enough: a failed run
 * announces itself on the article page, which is where someone goes to look at
 * it, and there was nothing to press there.
 */
export function RegenerateArticleButton({
  articleId,
  planStatus,
  variant = "outline",
  className,
}: {
  articleId: string;
  planStatus: PlanItem["status"] | null;
  variant?: "outline" | "ghost" | "default";
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const busy = !canRegenerate(planStatus);

  return (
    <div className={className}>
      <Button
        variant={variant}
        size="sm"
        className="w-full"
        disabled={pending || busy}
        onClick={(event) => {
          // These buttons sit inside a row that links to the article.
          event.preventDefault();
          event.stopPropagation();

          if (!window.confirm(REGENERATE_CONFIRMATION)) return;

          startTransition(async () => {
            setError(null);
            const result = await regenerateArticle(articleId);
            if (result.ok) router.refresh();
            else setError(result.error);
          });
        }}
      >
        {pending || busy ? <Spinner /> : <RefreshCw />}
        {busy ? "Writing…" : regenerateLabel(planStatus)}
      </Button>
      {error ? (
        <p className="mt-1 text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
