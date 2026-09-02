import { z } from "zod";

/**
 * Wire contracts between the Vercel app (which enqueues) and the local worker
 * (which executes). Both sides parse with these schemas, so a payload shape
 * change fails loudly at the boundary instead of deep inside a pipeline.
 */

export const jobTypeSchema = z.enum([
  "crawl_site",
  "keyword_research",
  "content_plan",
  "write_article",
  "regenerate_image",
]);
export type JobType = z.infer<typeof jobTypeSchema>;

/* ---------------------------------------------------------------- payloads */

export const crawlSitePayloadSchema = z.object({
  clientId: z.string().uuid(),
  domain: z.string().min(1),
  maxPages: z.number().int().min(1).max(40).default(20),
});

export const keywordResearchPayloadSchema = z.object({
  clientId: z.string().uuid(),
  runId: z.string().uuid(),
  /** Extra seeds typed by the strategist; Claude adds more from the vault. */
  seeds: z.array(z.string()).default([]),
  /** Competitor domains; falls back to the brand vault list when empty. */
  competitors: z.array(z.string()).default([]),
  /** Cap on keywords persisted, to keep the table reviewable. */
  maxKeywords: z.number().int().min(20).max(2000).default(400),
});

export const contentPlanPayloadSchema = z.object({
  clientId: z.string().uuid(),
  planId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  /** Keyword rows the user ticked. */
  keywordIds: z.array(z.string().uuid()).min(1),
  /** How many titles to produce. */
  targetTitles: z.number().int().min(1).max(60).default(12),
});

export const imageModeSchema = z.enum([
  /** Every image comes from Magnific. */
  "generate",
  /** Every image comes from the client's uploaded assets. */
  "brand_assets",
  /** Prefer brand assets, generate whatever they cannot cover. */
  "mixed",
]);
export type ImageMode = z.infer<typeof imageModeSchema>;

export const writeArticlePayloadSchema = z.object({
  clientId: z.string().uuid(),
  planItemId: z.string().uuid(),
  articleId: z.string().uuid(),
  imageMode: imageModeSchema.default("mixed"),
  /** Hero plus this many in-body images. */
  inlineImageCount: z.number().int().min(0).max(6).default(3),
});

export const regenerateImagePayloadSchema = z.object({
  clientId: z.string().uuid(),
  articleId: z.string().uuid(),
  imageId: z.string().uuid(),
  /** Overrides the stored prompt when the editor supplies a new one. */
  prompt: z.string().optional(),
});

export const jobPayloadSchemas = {
  crawl_site: crawlSitePayloadSchema,
  keyword_research: keywordResearchPayloadSchema,
  content_plan: contentPlanPayloadSchema,
  write_article: writeArticlePayloadSchema,
  regenerate_image: regenerateImagePayloadSchema,
} as const;

export type CrawlSitePayload = z.infer<typeof crawlSitePayloadSchema>;
export type KeywordResearchPayload = z.infer<
  typeof keywordResearchPayloadSchema
>;
export type ContentPlanPayload = z.infer<typeof contentPlanPayloadSchema>;
export type WriteArticlePayload = z.infer<typeof writeArticlePayloadSchema>;
export type RegenerateImagePayload = z.infer<
  typeof regenerateImagePayloadSchema
>;

/** Parses a payload against the schema for its job type. */
export function parseJobPayload<T extends JobType>(
  type: T,
  payload: unknown,
): z.infer<(typeof jobPayloadSchemas)[T]> {
  return jobPayloadSchemas[type].parse(payload) as z.infer<
    (typeof jobPayloadSchemas)[T]
  >;
}

/* -------------------------------------------------- worker <-> app traffic */

export const claimedJobSchema = z.object({
  id: z.string().uuid(),
  type: jobTypeSchema,
  clientId: z.string().uuid().nullable(),
  payload: z.record(z.unknown()),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
});
export type ClaimedJob = z.infer<typeof claimedJobSchema>;

export const claimResponseSchema = z.object({
  job: claimedJobSchema.nullable(),
});

export const jobProgressSchema = z.object({
  step: z.number().int().min(0),
  totalSteps: z.number().int().min(1),
  label: z.string(),
  detail: z.string().optional(),
});
export type JobProgressInput = z.infer<typeof jobProgressSchema>;

export const jobCompleteSchema = z.object({
  result: z.record(z.unknown()).default({}),
});

export const jobFailSchema = z.object({
  error: z.string(),
  /** False marks the failure terminal, skipping the remaining attempts. */
  retryable: z.boolean().default(true),
  /**
   * Put the job back without holding this attempt against it.
   *
   * For a stop that is nothing to do with the job: a spent Claude
   * subscription, where the same article passes unchanged once the window
   * resets. Counting those as failures burned three attempts in ten minutes
   * against a limit that opened ninety minutes later.
   */
  deferred: z.boolean().default(false),
});

export const assetIngestSchema = z.object({
  /** Remote URL to pull down — Magnific links expire, so we copy to Blob. */
  sourceUrl: z.string().url(),
  clientId: z.string().uuid(),
  /** Blob path prefix, e.g. "articles/<articleId>". */
  prefix: z.string().min(1),
  filename: z.string().min(1),
});

export const assetIngestResponseSchema = z.object({
  blobUrl: z.string().url(),
  pathname: z.string(),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().optional(),
});
