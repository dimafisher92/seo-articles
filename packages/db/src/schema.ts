import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const clientStatusEnum = pgEnum("client_status", [
  "active",
  "paused",
  "offboarded",
]);

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "ready",
  "failed",
]);

export const searchIntentEnum = pgEnum("search_intent", [
  "informational",
  "commercial",
  "transactional",
  "navigational",
]);

export const pageTypeEnum = pgEnum("page_type", [
  "blog",
  "guide",
  "comparison",
  "listicle",
  "category",
  "product",
  "landing",
]);

export const funnelStageEnum = pgEnum("funnel_stage", ["tofu", "mofu", "bofu"]);

export const planItemStatusEnum = pgEnum("plan_item_status", [
  "planned",
  "queued",
  "generating",
  "drafted",
  "approved",
  "exported",
  "failed",
]);

export const articleStatusEnum = pgEnum("article_status", [
  /**
   * Generated, reviewed, and something the review flagged as serious is still
   * in the text. Everything is saved — body, metadata, images — but it is not
   * a draft anyone should publish without reading the findings first.
   *
   * Ordered before "draft" so a status comparison reads worst-first.
   */
  "needs_attention",
  "draft",
  "approved",
  "exported",
]);

export const imageRoleEnum = pgEnum("image_role", ["hero", "inline"]);

export const imageSourceEnum = pgEnum("image_source", [
  "generated",
  "brand_asset",
]);

export const imageStatusEnum = pgEnum("image_status", [
  "planned",
  "generating",
  "ready",
  "failed",
]);

export const jobTypeEnum = pgEnum("job_type", [
  "crawl_site",
  "keyword_research",
  "content_plan",
  "write_article",
  "regenerate_image",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
  "canceled",
]);

/* ---------------------------------------------------------------- clients */

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notionPageId: text("notion_page_id"),
    name: text("name").notNull(),
    /** Bare hostname, normalised: "example.com" (no scheme, no trailing slash). */
    domain: text("domain"),
    status: clientStatusEnum("status").notNull().default("active"),
    serviceType: text("service_type"),
    /** BCP-47 tag driving article language, e.g. "en-US". */
    locale: text("locale").notNull().default("en-US"),
    /** ISO-3166-1 alpha-2; sets the geography for SearchAtlas volume. */
    country: text("country").notNull().default("US"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("clients_notion_page_id_key")
      .on(t.notionPageId)
      .where(sql`${t.notionPageId} is not null`),
    index("clients_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------ brand vault */

/** Persona the article is bylined to — feeds E-E-A-T signals. */
export type AuthorPersona = {
  name?: string;
  title?: string;
  bio?: string;
  credentials?: string[];
};

/** A money page we want internal links pointed at. */
export type CtaTarget = {
  label: string;
  url: string;
  /** When to link here, in plain language: "readers comparing pricing". */
  useWhen?: string;
};

export const brandVaults = pgTable("brand_vaults", {
  clientId: uuid("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  businessDescription: text("business_description"),
  productsServices: text("products_services"),
  icpAudience: text("icp_audience"),
  toneOfVoice: text("tone_of_voice"),
  usps: text("usps").array().notNull().default(sql`'{}'::text[]`),
  brandTerms: text("brand_terms").array().notNull().default(sql`'{}'::text[]`),
  bannedWords: text("banned_words").array().notNull().default(sql`'{}'::text[]`),
  competitors: text("competitors").array().notNull().default(sql`'{}'::text[]`),
  ctaTargets: jsonb("cta_targets").$type<CtaTarget[]>().notNull().default([]),
  authorPersona: jsonb("author_persona").$type<AuthorPersona>(),
  /** Claude's digest of the client site, produced by the crawl_site job. */
  siteCrawlSummary: text("site_crawl_summary"),
  siteCrawledAt: timestamp("site_crawled_at", { withTimezone: true }),
  /** Free-form per-client rules; these override the global SEO playbook. */
  contentGuidelines: text("content_guidelines"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const brandAssets = pgTable(
  "brand_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    blobUrl: text("blob_url").notNull(),
    pathname: text("pathname"),
    filename: text("filename"),
    contentType: text("content_type"),
    category: text("category"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    altText: text("alt_text"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: integer("size_bytes"),
    /**
     * Marks the asset Magnific receives as `style_reference`, so generated
     * imagery inherits the brand's visual language. At most one per client.
     */
    isStyleReference: boolean("is_style_reference").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("brand_assets_client_idx").on(t.clientId),
    uniqueIndex("brand_assets_one_style_ref_per_client")
      .on(t.clientId)
      .where(sql`${t.isStyleReference}`),
  ],
);

/* --------------------------------------------------------------- keywords */

export type KeywordRunSummary = {
  totalKeywords?: number;
  gapKeywords?: number;
  clusters?: { name: string; keywordCount: number; totalVolume: number }[];
  /** Competitors the run actually got ranking data for. */
  competitorsAnalysed?: string[];
  /**
   * Competitors the run was asked about.
   *
   * Kept alongside the analysed list because zero gaps means three different
   * things — nobody was asked, they were asked and had no data yet, or they
   * were asked, had data, and the client genuinely competes — and only the
   * third is a fact about the market.
   */
  competitorsRequested?: string[];
  notes?: string;
};

/** A competitor URL ranking for a keyword the client does not rank for. */
export type CompetitorRanking = {
  domain: string;
  url: string;
  position: number;
  title?: string;
};

export const keywordRuns = pgTable(
  "keyword_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    status: runStatusEnum("status").notNull().default("pending"),
    seeds: text("seeds").array().notNull().default(sql`'{}'::text[]`),
    competitors: text("competitors")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    summary: jsonb("summary").$type<KeywordRunSummary>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("keyword_runs_client_idx").on(t.clientId, t.createdAt)],
);

export const keywords = pgTable(
  "keywords",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => keywordRuns.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    /** Monthly searches from SearchAtlas. Null means the provider had no data. */
    volume: integer("volume"),
    difficulty: integer("difficulty"),
    cpc: real("cpc"),
    intent: searchIntentEnum("intent"),
    cluster: text("cluster"),
    pageType: pageTypeEnum("page_type"),
    funnelStage: funnelStageEnum("funnel_stage"),
    /** True when competitors rank for this and the client does not. */
    isGap: boolean("is_gap").notNull().default(false),
    competitorUrls: jsonb("competitor_urls")
      .$type<CompetitorRanking[]>()
      .notNull()
      .default([]),
    clientRank: integer("client_rank"),
    /** 0-100, computed by scoreKeyword() in @seo/shared. */
    priorityScore: real("priority_score"),
    /** Ticked by the user; only selected keywords enter the content plan. */
    selected: boolean("selected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("keywords_run_keyword_key").on(t.runId, t.keyword),
    index("keywords_client_idx").on(t.clientId),
    index("keywords_run_priority_idx").on(t.runId, t.priorityScore),
  ],
);

/* ----------------------------------------------------------- content plan */

/** What the top-10 already covers, and the opening it leaves us. */
export type SerpNotes = {
  dominantAngle?: string;
  commonSections?: string[];
  missingAngles?: string[];
  peopleAlsoAsk?: string[];
  competitorUrls?: string[];
};

export const contentPlans = pgTable(
  "content_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => keywordRuns.id, {
      onDelete: "set null",
    }),
    status: runStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("content_plans_client_idx").on(t.clientId, t.createdAt)],
);

export const planItems = pgTable(
  "plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => contentPlans.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    mainKeyword: text("main_keyword").notNull(),
    secondaryKeywords: text("secondary_keywords")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    cluster: text("cluster"),
    intent: searchIntentEnum("intent"),
    pageType: pageTypeEnum("page_type"),
    funnelStage: funnelStageEnum("funnel_stage"),
    targetWordCount: integer("target_word_count"),
    /** CtaTarget entries this article should link to. */
    internalLinkTargets: jsonb("internal_link_targets")
      .$type<CtaTarget[]>()
      .notNull()
      .default([]),
    serpNotes: jsonb("serp_notes").$type<SerpNotes>(),
    rationale: text("rationale"),
    priority: real("priority"),
    publishOrder: integer("publish_order"),
    status: planItemStatusEnum("status").notNull().default("planned"),
    articleId: uuid("article_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("plan_items_plan_idx").on(t.planId, t.publishOrder),
    index("plan_items_client_idx").on(t.clientId),
  ],
);

/* --------------------------------------------------------------- articles */

export type OutlineSection = {
  heading: string;
  level: 2 | 3;
  /** What this section must deliver — guides the draft stage. */
  intent?: string;
  talkingPoints?: string[];
  targetWords?: number;
};

export type FaqEntry = { question: string; answer: string };

export type ExternalSource = { title: string; url: string; usedFor?: string };

export type InternalLink = { anchor: string; url: string };

/** One rubric line scored by the QA stage. */
export type SeoCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
};

export type SeoScore = {
  /** 0-100 overall. */
  total: number;
  checks: SeoCheck[];
};

export type QaReport = {
  issues: { severity: "high" | "medium" | "low"; note: string }[];
  appliedFixes: string[];
};

export const articles = pgTable(
  "articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planItemId: uuid("plan_item_id").references(() => planItems.id, {
      onDelete: "set null",
    }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    status: articleStatusEnum("status").notNull().default("draft"),
    /** On-page H1. */
    title: text("title").notNull(),
    /** <title> — separate from the H1 because it is length-capped for the SERP. */
    titleTag: text("title_tag"),
    metaDescription: text("meta_description"),
    slug: text("slug"),
    mainKeyword: text("main_keyword"),
    secondaryKeywords: text("secondary_keywords")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    outline: jsonb("outline").$type<OutlineSection[]>(),
    bodyMdx: text("body_mdx"),
    bodyHtml: text("body_html"),
    faq: jsonb("faq").$type<FaqEntry[]>().notNull().default([]),
    jsonLd: jsonb("json_ld").$type<unknown[]>().notNull().default([]),
    internalLinks: jsonb("internal_links")
      .$type<InternalLink[]>()
      .notNull()
      .default([]),
    externalSources: jsonb("external_sources")
      .$type<ExternalSource[]>()
      .notNull()
      .default([]),
    wordCount: integer("word_count"),
    readingTimeMinutes: integer("reading_time_minutes"),
    seoScore: jsonb("seo_score").$type<SeoScore>(),
    qaReport: jsonb("qa_report").$type<QaReport>(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("articles_client_idx").on(t.clientId, t.createdAt),
    index("articles_plan_item_idx").on(t.planItemId),
  ],
);

export const articleImages = pgTable(
  "article_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    role: imageRoleEnum("role").notNull(),
    /** Ordinal within the article; the hero is 0. */
    position: integer("position").notNull().default(0),
    source: imageSourceEnum("source").notNull(),
    status: imageStatusEnum("status").notNull().default("planned"),
    brandAssetId: uuid("brand_asset_id").references(() => brandAssets.id, {
      onDelete: "set null",
    }),
    magnificTaskId: text("magnific_task_id"),
    prompt: text("prompt"),
    aspectRatio: text("aspect_ratio"),
    blobUrl: text("blob_url"),
    altText: text("alt_text"),
    caption: text("caption"),
    /** Placement anchor: the outline heading this image sits under. */
    placementHeading: text("placement_heading"),
    width: integer("width"),
    height: integer("height"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("article_images_article_idx").on(t.articleId, t.position)],
);

/* ------------------------------------------------------------------- jobs */

export type JobProgress = {
  step: number;
  totalSteps: number;
  label: string;
  detail?: string;
};

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: jobTypeEnum("type").notNull(),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "cascade",
    }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    progress: jsonb("progress").$type<JobProgress>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Identifies the worker that claimed the job; helps spot abandoned runs. */
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_queue_idx").on(t.status, t.createdAt),
    index("jobs_client_idx").on(t.clientId, t.createdAt),
    index("jobs_heartbeat_idx").on(t.status, t.heartbeatAt),
  ],
);

/* ------------------------------------------------------------------- auth */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* -------------------------------------------------------------- relations */

export const clientsRelations = relations(clients, ({ one, many }) => ({
  brandVault: one(brandVaults, {
    fields: [clients.id],
    references: [brandVaults.clientId],
  }),
  assets: many(brandAssets),
  keywordRuns: many(keywordRuns),
  contentPlans: many(contentPlans),
  articles: many(articles),
}));

export const brandVaultsRelations = relations(brandVaults, ({ one }) => ({
  client: one(clients, {
    fields: [brandVaults.clientId],
    references: [clients.id],
  }),
}));

export const brandAssetsRelations = relations(brandAssets, ({ one }) => ({
  client: one(clients, {
    fields: [brandAssets.clientId],
    references: [clients.id],
  }),
}));

export const keywordRunsRelations = relations(keywordRuns, ({ one, many }) => ({
  client: one(clients, {
    fields: [keywordRuns.clientId],
    references: [clients.id],
  }),
  keywords: many(keywords),
}));

export const keywordsRelations = relations(keywords, ({ one }) => ({
  run: one(keywordRuns, {
    fields: [keywords.runId],
    references: [keywordRuns.id],
  }),
}));

export const contentPlansRelations = relations(
  contentPlans,
  ({ one, many }) => ({
    client: one(clients, {
      fields: [contentPlans.clientId],
      references: [clients.id],
    }),
    run: one(keywordRuns, {
      fields: [contentPlans.runId],
      references: [keywordRuns.id],
    }),
    items: many(planItems),
  }),
);

export const planItemsRelations = relations(planItems, ({ one }) => ({
  plan: one(contentPlans, {
    fields: [planItems.planId],
    references: [contentPlans.id],
  }),
  article: one(articles, {
    fields: [planItems.articleId],
    references: [articles.id],
  }),
}));

export const articlesRelations = relations(articles, ({ one, many }) => ({
  client: one(clients, {
    fields: [articles.clientId],
    references: [clients.id],
  }),
  planItem: one(planItems, {
    fields: [articles.planItemId],
    references: [planItems.id],
  }),
  images: many(articleImages),
}));

export const articleImagesRelations = relations(articleImages, ({ one }) => ({
  article: one(articles, {
    fields: [articleImages.articleId],
    references: [articles.id],
  }),
  brandAsset: one(brandAssets, {
    fields: [articleImages.brandAssetId],
    references: [brandAssets.id],
  }),
}));

/* --------------------------------------------------------- inferred types */

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type BrandVault = typeof brandVaults.$inferSelect;
export type BrandAsset = typeof brandAssets.$inferSelect;
export type KeywordRun = typeof keywordRuns.$inferSelect;
export type Keyword = typeof keywords.$inferSelect;
export type NewKeyword = typeof keywords.$inferInsert;
export type ContentPlan = typeof contentPlans.$inferSelect;
export type PlanItem = typeof planItems.$inferSelect;
export type NewPlanItem = typeof planItems.$inferInsert;
export type Article = typeof articles.$inferSelect;
export type ArticleImage = typeof articleImages.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
