/**
 * Structural types shared by the app, the worker and the database package.
 * Kept free of Drizzle imports so the worker and browser bundles can use them
 * without pulling in the driver.
 */

export type SearchIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational";

export type PageType =
  | "blog"
  | "guide"
  | "comparison"
  | "listicle"
  | "category"
  | "product"
  | "landing";

export type FunnelStage = "tofu" | "mofu" | "bofu";

export type SeoCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
};

export type SeoScore = {
  total: number;
  checks: SeoCheck[];
};

export type OutlineSection = {
  heading: string;
  level: 2 | 3;
  intent?: string;
  talkingPoints?: string[];
  targetWords?: number;
};

export type FaqEntry = { question: string; answer: string };
export type ExternalSource = { title: string; url: string; usedFor?: string };
export type InternalLink = { anchor: string; url: string };
export type CtaTarget = { label: string; url: string; useWhen?: string };

export type AuthorPersona = {
  name?: string;
  title?: string;
  bio?: string;
  credentials?: string[];
};

export type SerpNotes = {
  dominantAngle?: string;
  commonSections?: string[];
  missingAngles?: string[];
  peopleAlsoAsk?: string[];
  competitorUrls?: string[];
};
