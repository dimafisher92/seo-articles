import {
  findAuthoredHtml,
  stripFrontMatter,
} from "./render/markdown.js";
import type { SeoCheck, SeoScore } from "./types.js";

/**
 * Deterministic on-page checks.
 *
 * These are the rubric lines a machine can settle on its own — lengths, counts,
 * presence of structure. They run in two places: the worker's QA stage (so the
 * model gets told exactly what it broke) and the editor's live sidebar (so a
 * human editing the draft sees the same verdict). Judgement calls — is the
 * angle actually differentiated, does the intro really answer the query — stay
 * with the model and land in `qaReport`, not here.
 */

export type CheckInput = {
  title: string;
  titleTag?: string | null;
  metaDescription?: string | null;
  slug?: string | null;
  bodyMdx: string;
  mainKeyword?: string | null;
  secondaryKeywords?: string[];
  faqCount?: number;
  internalLinkCount?: number;
  externalSourceCount?: number;
  imageCount?: number;
  imagesMissingAlt?: number;
  targetWordCount?: number | null;
  /** @type values of the JSON-LD the article ships with. */
  schemaTypes?: string[];
};

/**
 * The tells from playbook §11, as patterns.
 *
 * A review found five instances of the same "nobody tells you this" move in one
 * article and called it out in prose, where nothing acted on it. Counted here,
 * it is a failing check the revision loop has to clear.
 *
 * Kept to constructions with no innocent reading: the point is to catch a habit
 * repeated across an article, not to ban a turn of phrase used once.
 */
const MACHINE_TELLS: { label: string; pattern: RegExp }[] = [
  {
    label: "nobody-tells-you",
    // "the part almost nobody reads", "what no advert explains"
    pattern:
      /\b(?:que|lo que|the part|the bit)?\s*(?:casi\s+)?(?:nadie|ningún|ninguna|no one|nobody|no ad|ningun)\b[^.!?\n]{0,60}\b(?:lee|explica|menciona|cuenta|muestra|tells|explains|mentions|shows)\b/gi,
  },
  {
    label: "negative-parallelism",
    // "not a lapse: it is the clause", "no es X, es Y"
    pattern:
      /\b(?:no es|not a|not an|it is not|isn['’]t|no son)\b[^.:;!?\n]{3,60}[:,]\s*(?:es|it is|it['’]s|son|sino)\b/gi,
  },
  {
    label: "inflated-significance",
    pattern:
      /\b(?:la parte|el detalle|el hueco|the one thing|the detail)\b[^.!?\n]{0,40}\b(?:que casi nadie|que nadie|almost nobody|nobody)\b/gi,
  },
];

/** Counts each tell, so the detail names the habit rather than a total. */
export function findMachineTells(markdown: string): { label: string; count: number }[] {
  return MACHINE_TELLS.map(({ label, pattern }) => ({
    label,
    count: (markdown.match(pattern) ?? []).length,
  })).filter((tell) => tell.count > 0);
}

/** Google truncates around 580px; ~60 characters is the workable proxy. */
export const TITLE_TAG_MAX = 60;
export const META_DESCRIPTION_MIN = 110;
export const META_DESCRIPTION_MAX = 155;

export function countWords(markdown: string): number {
  const prose = markdown
    // fenced code
    .replace(/```[\s\S]*?```/g, " ")
    // images then links — images first, so the ![...] form is not left behind
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]/g, " ");
  const matches = prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches ? matches.length : 0;
}

export function readingTimeMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 225));
}

export function extractHeadings(
  markdown: string,
): { level: number; text: string }[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  const out: { level: number; text: string }[] = [];
  for (const line of withoutCode.split("\n")) {
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (match?.[1] && match[2]) {
      out.push({ level: match[1].length, text: match[2].trim() });
    }
  }
  return out;
}

/** Prose before the first heading — the passage AI Overviews tends to lift. */
export function leadParagraph(markdown: string): string {
  const body = stripFrontMatter(markdown);
  const beforeHeading = body.split(/\n#{2,6}\s/)[0] ?? body;
  return beforeHeading
    .replace(/^#\s+.*$/m, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .trim();
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
}

/** Loose containment: every word of the keyword appears, order-independent. */
export function containsKeyword(haystack: string, keyword: string): boolean {
  const hay = normalise(haystack);
  const parts = normalise(keyword).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => hay.includes(part));
}

export function runSeoChecks(input: CheckInput): SeoScore {
  const checks: SeoCheck[] = [];
  const add = (
    id: string,
    label: string,
    passed: boolean,
    detail?: string,
  ): void => {
    checks.push({ id, label, passed, ...(detail ? { detail } : {}) });
  };

  const wordCount = countWords(input.bodyMdx);
  const headings = extractHeadings(input.bodyMdx);
  const h2s = headings.filter((h) => h.level === 2);
  const lead = leadParagraph(input.bodyMdx);
  const keyword = input.mainKeyword ?? "";

  /* --- metadata --------------------------------------------------------- */

  const titleTag = input.titleTag ?? input.title;
  add(
    "title-tag-length",
    `Title tag ≤ ${TITLE_TAG_MAX} characters`,
    titleTag.length > 0 && titleTag.length <= TITLE_TAG_MAX,
    `${titleTag.length} characters`,
  );

  add(
    "title-tag-keyword",
    "Main keyword appears in the title tag",
    keyword ? containsKeyword(titleTag, keyword) : false,
    keyword ? undefined : "No main keyword set",
  );

  const meta = input.metaDescription ?? "";
  add(
    "meta-description-length",
    `Meta description ${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX} characters`,
    meta.length >= META_DESCRIPTION_MIN && meta.length <= META_DESCRIPTION_MAX,
    `${meta.length} characters`,
  );

  add(
    "meta-description-keyword",
    "Main keyword appears in the meta description",
    keyword ? containsKeyword(meta, keyword) : false,
  );

  const slug = input.slug ?? "";
  add(
    "slug-format",
    "Slug is lowercase, hyphenated, ≤ 75 characters",
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 75,
    slug || "No slug set",
  );

  /* --- answer-first / AEO ----------------------------------------------- */

  const leadWords = countWords(lead);
  add(
    "answer-first",
    "Opens with a direct answer in the first 150 words",
    leadWords >= 40 && leadWords <= 200,
    `${leadWords} words before the first H2`,
  );

  add(
    "lead-keyword",
    "Main keyword appears in the opening paragraph",
    keyword ? containsKeyword(lead, keyword) : false,
  );

  // An AI Overview lifts a sentence, not a paragraph. One article packed six
  // claims and three statute references into its first sentence and was
  // unliftable — the check that would have caught it did not exist.
  const firstSentence = (lead.split(/(?<=[.!?])\s/)[0] ?? "").trim();
  const firstSentenceWords = countWords(firstSentence);
  add(
    "opening-answer",
    "Opens with an answer short enough to be quoted (≤40 words)",
    firstSentenceWords > 0 && firstSentenceWords <= 40,
    `${firstSentenceWords} words in the first sentence`,
  );

  /* --- structure -------------------------------------------------------- */

  add(
    "h2-count",
    "At least 4 H2 sections",
    h2s.length >= 4,
    `${h2s.length} H2 headings`,
  );

  // The house rule is that an H2 is a question answered by the sentence under
  // it. Requiring only one let five plain headings through in a seven-heading
  // article; 70% leaves room for a closing section without licensing prose
  // headings throughout.
  const questionH2s = h2s.filter((h) => h.text.includes("?")).length;
  add(
    "question-headings",
    "Most H2s are questions, each answered in the sentence below",
    h2s.length === 0 || questionH2s / h2s.length >= 0.7,
    `${questionH2s}/${h2s.length} are questions`,
  );

  const singleH1 = headings.filter((h) => h.level === 1).length <= 1;
  add("single-h1", "No more than one H1 in the body", singleH1);

  // Wall-of-text detection: paragraphs over ~120 words resist extraction.
  const paragraphs = input.bodyMdx
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#") && !p.startsWith("|"));
  const longParagraphs = paragraphs.filter((p) => countWords(p) > 120).length;
  add(
    "paragraph-length",
    "No paragraph runs past 120 words",
    longParagraphs === 0,
    longParagraphs > 0 ? `${longParagraphs} over-long paragraphs` : undefined,
  );

  const hasList = /^\s*(?:[-*+]|\d+\.)\s+/m.test(input.bodyMdx);
  const hasTable = /^\s*\|.+\|\s*$/m.test(input.bodyMdx);
  add(
    "scannability",
    "Includes a list or a table",
    hasList || hasTable,
  );

  /* --- coverage --------------------------------------------------------- */

  const target = input.targetWordCount ?? 0;
  add(
    "word-count",
    target ? `Within 20% of the ${target}-word target` : "At least 800 words",
    target ? Math.abs(wordCount - target) / target <= 0.2 : wordCount >= 800,
    `${wordCount} words`,
  );

  const secondaries = input.secondaryKeywords ?? [];
  const covered = secondaries.filter((k) =>
    containsKeyword(input.bodyMdx, k),
  ).length;
  add(
    "secondary-coverage",
    "At least 70% of secondary keywords covered",
    secondaries.length === 0 || covered / secondaries.length >= 0.7,
    secondaries.length ? `${covered}/${secondaries.length}` : "None set",
  );

  /* --- links, media, schema --------------------------------------------- */

  add(
    "internal-links",
    "At least 2 internal links to client pages",
    (input.internalLinkCount ?? 0) >= 2,
    `${input.internalLinkCount ?? 0} internal links`,
  );

  add(
    "external-sources",
    "Cites at least 2 external sources",
    (input.externalSourceCount ?? 0) >= 2,
    `${input.externalSourceCount ?? 0} sources`,
  );

  const faqCount = input.faqCount ?? 0;
  add(
    "faq-present",
    "Has an FAQ block for FAQPage schema",
    faqCount >= 3,
    `${faqCount} questions`,
  );

  // Seven FAQs on a 1,700-word piece duplicated the body almost verbatim.
  // An FAQ that restates a section is not extra coverage, it is the same page
  // twice.
  add(
    "faq-count",
    "No more than 5 FAQ entries",
    faqCount <= 5,
    faqCount > 5 ? `${faqCount} — trim to the ones the body does not answer` : undefined,
  );

  add(
    "image-count",
    "Hero plus at least 2 in-body images",
    (input.imageCount ?? 0) >= 3,
    `${input.imageCount ?? 0} images`,
  );

  const tells = findMachineTells(input.bodyMdx);
  const tellCount = tells.reduce((sum, tell) => sum + tell.count, 0);
  add(
    "machine-tells",
    "No repeated machine tells from the playbook",
    tellCount === 0,
    tells.length > 0
      ? tells.map((tell) => `${tell.label} ×${tell.count}`).join(", ")
      : undefined,
  );

  // The JSON-LD is built and stored; nothing checked it was built, so an
  // article could ship with none and pass every structural check.
  const schemaTypes = input.schemaTypes;
  if (schemaTypes !== undefined) {
    const required = ["BlogPosting", "BreadcrumbList"];
    const missing = required.filter((type) => !schemaTypes.includes(type));
    add(
      "structured-data",
      "Ships BlogPosting and BreadcrumbList schema",
      missing.length === 0,
      missing.length > 0 ? `missing ${missing.join(", ")}` : schemaTypes.join(", "),
    );
  }

  // The pipeline strips this before anything measures it, so here the check is
  // for the bodies that never went through it: articles generated before the
  // strip existed, and anything typed into the editor. Reporting beats hiding —
  // an `<img>` the pipeline did not place points at a file that does not exist.
  const authoredHtml = findAuthoredHtml(input.bodyMdx);
  add(
    "authored-html",
    "No raw HTML in the body",
    authoredHtml.length === 0,
    authoredHtml.length > 0
      ? `${authoredHtml.join(", ")} — images, metadata and schema are produced by the pipeline`
      : undefined,
  );

  add(
    "image-alt",
    "Every image has alt text",
    (input.imagesMissingAlt ?? 0) === 0,
    (input.imagesMissingAlt ?? 0) > 0
      ? `${input.imagesMissingAlt} missing alt text`
      : undefined,
  );

  const passed = checks.filter((c) => c.passed).length;
  const total = checks.length === 0 ? 0 : Math.round((passed / checks.length) * 100);

  return { total, checks };
}
