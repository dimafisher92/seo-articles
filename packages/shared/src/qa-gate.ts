/**
 * Whether a draft may ship, and what to do when it may not.
 *
 * This exists because the pipeline used to ask the model. The review stage
 * returns a `verdict` alongside its findings, and the code trusted it — so an
 * article came back with six findings marked `high` (invented fee percentages,
 * claims about the client's own contract, unsourced attacks on competitors),
 * a verdict of "ship", and was published exactly as written. The system had
 * diagnosed every problem itself and then acted on none of them.
 *
 * The verdict is now a hint. What decides is the findings and the automated
 * checks, neither of which can talk itself into an opinion.
 */

export type QaSeverity = "high" | "medium" | "low";

export type QaIssue = { severity: QaSeverity; note: string };

export type GateInput = {
  /** The review's own opinion. Advisory. */
  verdict?: "ship" | "revise";
  issues: QaIssue[];
  /** Ids of automated checks that did not pass. */
  failedCheckIds: string[];
};

export type GateDecision = {
  mustRevise: boolean;
  /** Findings serious enough to hold an article back on their own. */
  blocking: QaIssue[];
  /**
   * Everything outstanding — blocking findings plus failed writing checks.
   *
   * The number a caller watches to decide whether a revision loop is still
   * converging. Counting only the findings misses a draft whose problems are
   * all failed checks, and would read as "nothing improving" from the start.
   */
  problemCount: number;
  reason: string;
};

/**
 * Checks that are about the writing and must be fixed before shipping.
 *
 * Deliberately not every check: `image-count` fails during review because
 * images are generated afterwards, and holding a revision loop open for it
 * would spend passes rewriting prose over a missing picture.
 */
const BLOCKING_CHECK_IDS = new Set([
  "title-tag-length",
  "title-tag-keyword",
  "meta-description-length",
  "meta-description-keyword",
  "slug-format",
  "answer-first",
  "lead-keyword",
  "paragraph-length",
  "word-count",
  "secondary-coverage",
  "question-headings",
  "single-h1",
  "faq-count",
  "opening-answer",
  "machine-tells",
  "authored-html",
]);

export function gateDraft(input: GateInput): GateDecision {
  const blocking = input.issues.filter((issue) => issue.severity === "high");
  const failed = input.failedCheckIds.filter((id) => BLOCKING_CHECK_IDS.has(id));

  const problemCount = blocking.length + failed.length;

  if (blocking.length > 0) {
    return {
      mustRevise: true,
      blocking,
      problemCount,
      reason:
        `${blocking.length} high-severity finding${blocking.length === 1 ? "" : "s"}` +
        (failed.length > 0 ? `, failed checks: ${failed.join(", ")}` : ""),
    };
  }

  if (failed.length > 0) {
    return {
      mustRevise: true,
      blocking: [],
      problemCount,
      reason: `failed checks: ${failed.join(", ")}`,
    };
  }

  // Only once nothing objective is outstanding does the model's own opinion
  // get to ask for another pass.
  if (input.verdict === "revise") {
    return {
      mustRevise: true,
      blocking: [],
      problemCount,
      reason: "the review asked for a revision",
    };
  }

  return { mustRevise: false, blocking: [], problemCount: 0, reason: "clean" };
}

/**
 * The status an article should carry once the revision loop has run out.
 *
 * "needs_attention" is not a failure — the work is saved in full. It is the
 * refusal to call something a draft when the review is still quoting invented
 * figures back at us.
 */
export function statusAfterReview(blocking: QaIssue[]): "draft" | "needs_attention" {
  return blocking.length > 0 ? "needs_attention" : "draft";
}
