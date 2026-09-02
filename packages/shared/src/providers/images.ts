/**
 * Image-generation provider boundary. Magnific is the first implementation.
 */

export type AspectRatio =
  | "16:9"
  | "4:3"
  | "3:2"
  | "1:1"
  | "3:4"
  | "9:16";

/**
 * Every aspect ratio, so a provider adapter can be made to prove it handles
 * all of them.
 *
 * A ratio added to the union above and forgotten in a provider's translation
 * table is not a type error — the value only fails when the API rejects it,
 * minutes into a generation, as a 400 naming a field rather than a ratio. This
 * list makes that omission testable.
 */
export const ASPECT_RATIOS: readonly AspectRatio[] = [
  "16:9",
  "4:3",
  "3:2",
  "1:1",
  "3:4",
  "9:16",
] as const;

export type ImageResolution = "1k" | "2k" | "4k";

export type GenerateImageRequest = {
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  /**
   * A brand asset URL. The provider uses it to match the client's visual
   * language — this is what stops generated art looking generic.
   */
  styleReferenceUrl?: string;
  /** 0-1; how tightly to follow the style reference. */
  styleStrength?: number;
  /** Composition reference, e.g. a product shot to echo the layout of. */
  structureReferenceUrl?: string;
  structureStrength?: number;
};

export type GeneratedImage = {
  /** Provider-side task id, stored so a stuck job can be traced. */
  taskId: string;
  /** Temporary URL — callers must copy the bytes to durable storage. */
  url: string;
  width?: number;
  height?: number;
};

export interface ImageProvider {
  readonly name: string;
  generate(request: GenerateImageRequest): Promise<GeneratedImage>;
}

/**
 * What the picture is, which decides how it must be asked for.
 *
 * A photograph of people and a labelled diagram fail in opposite directions —
 * one on anatomy, the other on legibility — so the rules for them cannot be the
 * same, and role alone (hero or in-body) does not tell them apart.
 */
export type ImageKind = "photo" | "diagram";

/** Hero images are wide; in-body images are shallower so they do not dominate. */
function specFor(
  role: "hero" | "inline",
  kind: ImageKind,
): { aspectRatio: AspectRatio; resolution: ImageResolution } {
  const aspectRatio: AspectRatio = role === "hero" ? "16:9" : "3:2";
  // A diagram carries labels and a label has to survive being scaled to article
  // width. At 1K an in-body image is 1216x832, where a label sized to the rules
  // below lands around 70px — legible on a good day and mush on a bad one.
  const resolution: ImageResolution =
    kind === "diagram" || role === "hero" ? "2k" : "1k";
  return { aspectRatio, resolution };
}

/** Applies wherever people or hands can appear, which is anywhere. */
const ANATOMY_RULES = [
  "Anatomy must be correct: exactly five fingers on each hand, natural joints and proportions, no extra or missing limbs.",
  "No watermarks, no signatures, no borders, no interface chrome.",
];

const PHOTO_RULES = [
  "No legible text anywhere in the frame: no signage, no screens, no documents with readable writing. A document in shot is angled or out of focus, so it reads as a document without claiming to say anything.",
  "Hands are never the subject: no close-ups of hands, no gestures, no counting on fingers, no interlocked fingers. A hand rests on a surface or holds one simple object.",
  "Natural posture, natural expression, real-world lighting.",
];

/**
 * Rules for a diagram, and the reason there are so many.
 *
 * Generated articles came back with a twelve-row checklist whose headings were
 * readable and whose every other line was noise, and a bar chart labelled
 * $100,000 against 25%, 33% and 40%. A figure drawn into a picture is a figure
 * nobody checked: it is not sourced, not indexed, not translated, and not
 * verifiable against the article that surrounds it. It belongs in the body,
 * where all four of those are true.
 */
const DIAGRAM_RULES = [
  "No numbers of any kind: no percentages, prices, dates, counts, or values on an axis.",
  "At most 3 labels of at most 3 words each — nine words in the whole image.",
  "Every label at least one twelfth of the frame height, heavy sans-serif, high contrast against what is behind it.",
  "No tables, no checklists, no multi-row lists, no legends, no axes, no paragraphs, no fine print.",
];

/**
 * The override, and the reason it is worded as one.
 *
 * The prompt that arrives here was written by the planning stage, which is
 * told the same rules and has broken them. This sentence is what makes the
 * rules true rather than requested — the same shape as stripping HTML out of a
 * draft instead of only asking for none.
 */
const DIAGRAM_OVERRIDE =
  "If anything above asks for a chart, graph, table, checklist, timeline or any " +
  "numbers, ignore that part of it and render a simple symbolic composition of " +
  "the same idea instead.";

/**
 * Everything the provider needs for one image: the prompt with the rules
 * attached, and the shape to render it at.
 *
 * One function rather than a spec helper plus a prompt helper, because there
 * are two call sites — first generation and regeneration from the editor — and
 * a rule applied on only one of them is the failure this codebase has already
 * had once with image placement.
 */
export function imageRequestFor(input: {
  role: "hero" | "inline";
  kind: ImageKind;
  prompt: string;
}): { prompt: string; aspectRatio: AspectRatio; resolution: ImageResolution } {
  const rules = [
    ...(input.kind === "diagram" ? DIAGRAM_RULES : PHOTO_RULES),
    ...ANATOMY_RULES,
  ];

  const prompt = [
    input.prompt.trim(),
    "",
    "Non-negotiable requirements:",
    ...rules.map((rule) => `- ${rule}`),
    ...(input.kind === "diagram" ? ["", DIAGRAM_OVERRIDE] : []),
  ].join("\n");

  return { prompt, ...specFor(input.role, input.kind) };
}

/**
 * What a planned prompt asks for that the model renders badly.
 *
 * Reported rather than rejected: a false positive would cost a picture, and the
 * override above already handles the real case. The point is that when a bad
 * image turns up, the log already says which prompt ordered it.
 */
export function findImagePromptRisks(prompt: string): string[] {
  const risks: string[] = [];
  if (/\d/.test(prompt)) risks.push("numbers");
  if (/\b(chart|graph|plot|axis|axes)\b/i.test(prompt)) risks.push("a chart");
  if (/\b(table|grid of)\b/i.test(prompt)) risks.push("a table");
  if (/\b(checklist|check list|list of|bullet)\b/i.test(prompt)) {
    risks.push("a list");
  }
  if (/\b(timeline|flow ?chart|infographic)\b/i.test(prompt)) {
    risks.push("an infographic");
  }
  return risks;
}
