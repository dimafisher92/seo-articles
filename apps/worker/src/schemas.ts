/**
 * JSON Schemas passed to the Agent SDK's `outputFormat`.
 *
 * The SDK validates the model's response against these and re-prompts on a
 * mismatch, so each stage hands back typed data instead of a string to parse.
 * `additionalProperties: false` everywhere keeps stages from quietly inventing
 * fields that later code would ignore.
 */

type Schema = Record<string, unknown>;

const str = { type: "string" } as const;
const strArray = { type: "array", items: { type: "string" } } as const;

function object(
  properties: Record<string, unknown>,
  required: string[],
): Schema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export const seedKeywordsSchema = object(
  { seeds: strArray, reasoning: str },
  ["seeds", "reasoning"],
);

export const clusterSchema = object(
  {
    clusters: {
      type: "array",
      items: object({ name: str, rationale: str }, ["name", "rationale"]),
    },
    keywords: {
      type: "array",
      items: object(
        {
          keyword: str,
          cluster: str,
          intent: {
            type: "string",
            enum: [
              "informational",
              "commercial",
              "transactional",
              "navigational",
            ],
          },
          pageType: {
            type: "string",
            enum: [
              "blog",
              "guide",
              "comparison",
              "listicle",
              "category",
              "product",
              "landing",
            ],
          },
          funnelStage: { type: "string", enum: ["tofu", "mofu", "bofu"] },
          businessRelevance: { type: "number", minimum: 0, maximum: 1 },
        },
        [
          "keyword",
          "cluster",
          "intent",
          "pageType",
          "funnelStage",
          "businessRelevance",
        ],
      ),
    },
  },
  ["clusters", "keywords"],
);

export const contentPlanSchema = object(
  {
    items: {
      type: "array",
      items: object(
        {
          title: str,
          mainKeyword: str,
          secondaryKeywords: strArray,
          intent: {
            type: "string",
            enum: [
              "informational",
              "commercial",
              "transactional",
              "navigational",
            ],
          },
          pageType: {
            type: "string",
            enum: [
              "blog",
              "guide",
              "comparison",
              "listicle",
              "category",
              "product",
              "landing",
            ],
          },
          funnelStage: { type: "string", enum: ["tofu", "mofu", "bofu"] },
          targetWordCount: { type: "integer", minimum: 400, maximum: 5000 },
          internalLinkTargets: {
            type: "array",
            items: object({ label: str, url: str }, ["label", "url"]),
          },
          serpNotes: object(
            {
              dominantAngle: str,
              missingAngles: strArray,
              commonSections: strArray,
            },
            ["dominantAngle", "missingAngles", "commonSections"],
          ),
          rationale: str,
          priority: { type: "number", minimum: 0, maximum: 100 },
        },
        [
          "title",
          "mainKeyword",
          "secondaryKeywords",
          "intent",
          "pageType",
          "funnelStage",
          "targetWordCount",
          "internalLinkTargets",
          "serpNotes",
          "rationale",
          "priority",
        ],
      ),
    },
  },
  ["items"],
);

export const serpIntelSchema = object(
  {
    topResults: {
      type: "array",
      items: object(
        {
          url: str,
          title: str,
          format: str,
          headings: strArray,
          wordCount: { type: "integer" },
        },
        ["url", "title", "format", "headings"],
      ),
    },
    consensus: strArray,
    entities: strArray,
    peopleAlsoAsk: strArray,
    gaps: strArray,
    angle: str,
    formatVerdict: str,
    sources: {
      type: "array",
      items: object({ title: str, url: str, usedFor: str }, ["title", "url"]),
    },
  },
  [
    "topResults",
    "consensus",
    "entities",
    "peopleAlsoAsk",
    "gaps",
    "angle",
    "formatVerdict",
    "sources",
  ],
);

export const outlineSchema = object(
  {
    title: str,
    titleTag: str,
    leadAnswer: str,
    sections: {
      type: "array",
      items: object(
        {
          heading: str,
          level: { type: "integer", enum: [2, 3] },
          intent: str,
          talkingPoints: strArray,
          targetWords: { type: "integer", minimum: 40 },
        },
        ["heading", "level", "intent", "talkingPoints", "targetWords"],
      ),
    },
    faq: {
      type: "array",
      items: object({ question: str, answer: str }, ["question", "answer"]),
    },
  },
  ["title", "titleTag", "leadAnswer", "sections", "faq"],
);

export const draftSchema = object(
  {
    bodyMdx: str,
    externalSources: {
      type: "array",
      items: object({ title: str, url: str, usedFor: str }, ["title", "url"]),
    },
    internalLinks: {
      type: "array",
      items: object({ anchor: str, url: str }, ["anchor", "url"]),
    },
  },
  ["bodyMdx", "externalSources", "internalLinks"],
);

export const imagePlanSchema = object(
  {
    images: {
      type: "array",
      items: object(
        {
          role: { type: "string", enum: ["hero", "inline"] },
          kind: { type: "string", enum: ["photo", "diagram"] },
          position: { type: "integer", minimum: 0 },
          source: { type: "string", enum: ["generated", "brand_asset"] },
          brandAssetId: { type: ["string", "null"] },
          prompt: { type: ["string", "null"] },
          placementHeading: { type: ["string", "null"] },
          altText: str,
          caption: { type: ["string", "null"] },
          filename: str,
        },
        ["role", "kind", "position", "source", "altText", "filename"],
      ),
    },
  },
  ["images"],
);

export const qaSchema = object(
  {
    verdict: { type: "string", enum: ["ship", "revise"] },
    issues: {
      type: "array",
      items: object(
        {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          note: str,
        },
        ["severity", "note"],
      ),
    },
    instructions: strArray,
  },
  ["verdict", "issues", "instructions"],
);

export const reviseSchema = object(
  { bodyMdx: str, appliedFixes: strArray },
  ["bodyMdx", "appliedFixes"],
);

export const metaSchema = object(
  {
    titleTag: str,
    metaDescription: str,
    slug: str,
    excerpt: str,
    faq: {
      type: "array",
      items: object({ question: str, answer: str }, ["question", "answer"]),
    },
  },
  ["titleTag", "metaDescription", "slug", "excerpt", "faq"],
);

export const siteCrawlSchema = object(
  {
    businessDescription: str,
    productsServices: str,
    icpAudience: str,
    toneOfVoice: str,
    usps: strArray,
    brandTerms: strArray,
    ctaTargets: {
      type: "array",
      items: object({ label: str, url: str, useWhen: str }, ["label", "url"]),
    },
    contentThemes: strArray,
    summary: str,
  },
  [
    "businessDescription",
    "productsServices",
    "icpAudience",
    "toneOfVoice",
    "usps",
    "brandTerms",
    "ctaTargets",
    "contentThemes",
    "summary",
  ],
);

/* ------------------------------------------------------- inferred shapes */

export type SeedKeywordsOutput = { seeds: string[]; reasoning: string };

export type ClusterOutput = {
  clusters: { name: string; rationale: string }[];
  keywords: {
    keyword: string;
    cluster: string;
    intent: "informational" | "commercial" | "transactional" | "navigational";
    pageType:
      | "blog"
      | "guide"
      | "comparison"
      | "listicle"
      | "category"
      | "product"
      | "landing";
    funnelStage: "tofu" | "mofu" | "bofu";
    businessRelevance: number;
  }[];
};

export type ContentPlanOutput = {
  items: {
    title: string;
    mainKeyword: string;
    secondaryKeywords: string[];
    intent: "informational" | "commercial" | "transactional" | "navigational";
    pageType:
      | "blog"
      | "guide"
      | "comparison"
      | "listicle"
      | "category"
      | "product"
      | "landing";
    funnelStage: "tofu" | "mofu" | "bofu";
    targetWordCount: number;
    internalLinkTargets: { label: string; url: string }[];
    serpNotes: {
      dominantAngle: string;
      missingAngles: string[];
      commonSections: string[];
    };
    rationale: string;
    priority: number;
  }[];
};

export type SerpIntelOutput = {
  topResults: {
    url: string;
    title: string;
    format: string;
    headings: string[];
    wordCount?: number;
  }[];
  consensus: string[];
  entities: string[];
  peopleAlsoAsk: string[];
  gaps: string[];
  angle: string;
  formatVerdict: string;
  sources: { title: string; url: string; usedFor?: string }[];
};

export type OutlineOutput = {
  title: string;
  titleTag: string;
  leadAnswer: string;
  sections: {
    heading: string;
    level: 2 | 3;
    intent: string;
    talkingPoints: string[];
    targetWords: number;
  }[];
  faq: { question: string; answer: string }[];
};

export type DraftOutput = {
  bodyMdx: string;
  externalSources: { title: string; url: string; usedFor?: string }[];
  internalLinks: { anchor: string; url: string }[];
};

export type ImagePlanOutput = {
  images: {
    role: "hero" | "inline";
    kind: "photo" | "diagram";
    position: number;
    source: "generated" | "brand_asset";
    brandAssetId?: string | null;
    prompt?: string | null;
    placementHeading?: string | null;
    altText: string;
    caption?: string | null;
    filename: string;
  }[];
};

export type QaOutput = {
  verdict: "ship" | "revise";
  issues: { severity: "high" | "medium" | "low"; note: string }[];
  instructions: string[];
};

export type ReviseOutput = { bodyMdx: string; appliedFixes: string[] };

export type MetaOutput = {
  titleTag: string;
  metaDescription: string;
  slug: string;
  excerpt: string;
  faq: { question: string; answer: string }[];
};

export type SiteCrawlOutput = {
  businessDescription: string;
  productsServices: string;
  icpAudience: string;
  toneOfVoice: string;
  usps: string[];
  brandTerms: string[];
  ctaTargets: { label: string; url: string; useWhen?: string }[];
  contentThemes: string[];
  summary: string;
};
