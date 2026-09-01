/**
 * Which model runs each stage of article generation.
 *
 * Not one model for the whole pipeline: the stages differ in kind, not only in
 * length. Extracting a SERP into a summary and writing a title tag are
 * mechanical; deciding an article's shape, writing it, and catching a fee
 * percentage that appears nowhere in the Brand Vault are not.
 *
 * Review stays on the strong model deliberately. Its judgement is what decides
 * whether an article ships, so making it cheaper would give back the thing the
 * gate was built for.
 *
 * Pure, and taking its environment as an argument, so tests and tools can read
 * the split without the worker's global config — which demands APP_URL and a
 * database the moment it is imported.
 */

export type Stage =
  | "serpIntel"
  | "outline"
  | "draft"
  | "qa"
  | "revise"
  | "meta"
  | "images";

export type StageModels = Record<Stage, string>;

/**
 * Whether a stage is judgement or mechanics, and the variable that overrides
 * it — because the right split is a call that should not need a release to
 * revisit.
 */
const STAGES: { stage: Stage; variable: string; tier: "strong" | "fast" }[] = [
  // Reads the live SERP and summarises it. Mechanical, and the slowest stage.
  { stage: "serpIntel", variable: "CLAUDE_MODEL_SERP", tier: "fast" },
  // Sets the shape of the whole article — where fourteen sections came from.
  { stage: "outline", variable: "CLAUDE_MODEL_OUTLINE", tier: "strong" },
  // The writing itself.
  { stage: "draft", variable: "CLAUDE_MODEL_DRAFT", tier: "strong" },
  // Catches invented figures and claims the client cannot make.
  { stage: "qa", variable: "CLAUDE_MODEL_QA", tier: "strong" },
  // Rewrites what will be published.
  { stage: "revise", variable: "CLAUDE_MODEL_REVISE", tier: "strong" },
  // Title tag, meta description, slug, FAQ.
  { stage: "meta", variable: "CLAUDE_MODEL_META", tier: "fast" },
  // Image prompts and alt text.
  { stage: "images", variable: "CLAUDE_MODEL_IMAGES", tier: "fast" },
];

export function resolveStageModels(
  env: Record<string, string | undefined>,
  tiers: { strong: string; fast: string },
): StageModels {
  const resolved = {} as StageModels;
  for (const { stage, variable, tier } of STAGES) {
    resolved[stage] = env[variable]?.trim() || tiers[tier];
  }
  return resolved;
}

/** One line for the startup banner, so the split is never a guess. */
export function describeStageModels(models: StageModels): string {
  const byModel = new Map<string, Stage[]>();
  for (const { stage } of STAGES) {
    const model = models[stage];
    byModel.set(model, [...(byModel.get(model) ?? []), stage]);
  }
  return [...byModel.entries()]
    .map(([model, stages]) => `${model}: ${stages.join(", ")}`)
    .join(" · ");
}
