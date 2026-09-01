import type { PlanItem } from "@seo/db";

/**
 * Whether an article can be re-commissioned right now.
 *
 * A plan item is where "generation is under way" actually lives — `articles`
 * has no such status, and the article row keeps its previous text throughout a
 * re-run. Asking the article would let a writer queue the same job twice.
 */
export function canRegenerate(
  status: PlanItem["status"] | null | undefined,
): boolean {
  return status !== "queued" && status !== "generating";
}

/** What the button says. A failed run is a retry; a finished one is a rewrite. */
export function regenerateLabel(
  status: PlanItem["status"] | null | undefined,
): "Retry" | "Regenerate" {
  return status === "failed" ? "Retry" : "Regenerate";
}

/**
 * Shown before a regeneration overwrites finished work.
 *
 * One string rather than one per button: the plan table and the editor were
 * about to grow their own wording, and two descriptions of the same
 * irreversible action drift.
 */
export const REGENERATE_CONFIRMATION =
  "Regenerate this article? The current text, metadata and images are " +
  "replaced, and generation takes a while.";
