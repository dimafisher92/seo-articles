import { eq, sql } from "drizzle-orm";

import { brandVaults } from "@seo/db";
import { siteCrawlPrompt } from "@seo/playbook";

import { RESEARCH_TOOLS, runStageWithRetry } from "../claude.js";
import { db } from "../data.js";
import { siteCrawlSchema, type SiteCrawlOutput } from "../schemas.js";
import type { StageReporter } from "./types.js";

export type CrawlSiteInput = {
  clientId: string;
  domain: string;
  maxPages: number;
};

/**
 * Reads the client's own website and fills in the Brand Vault.
 *
 * This is what makes onboarding a client a one-click job rather than a form to
 * fill in by hand. Fields a human has already written are preserved — the crawl
 * only fills blanks, so re-running it never overwrites curated context.
 */
export async function runCrawlSite(
  input: CrawlSiteInput,
  report: StageReporter,
): Promise<Record<string, unknown>> {
  await report(1, 2, "Reading the website", input.domain);

  const result = await runStageWithRetry<SiteCrawlOutput>(
    siteCrawlPrompt(input.domain, input.maxPages),
    {
      schema: siteCrawlSchema,
      label: "crawl-site",
      tools: RESEARCH_TOOLS,
      maxTurns: input.maxPages + 15,
      timeoutMs: 20 * 60_000,
    },
  );

  await report(2, 2, "Saving brand profile");

  const [existing] = await db()
    .select()
    .from(brandVaults)
    .where(eq(brandVaults.clientId, input.clientId))
    .limit(1);

  const filled = {
    businessDescription:
      existing?.businessDescription ?? result.businessDescription,
    productsServices: existing?.productsServices ?? result.productsServices,
    icpAudience: existing?.icpAudience ?? result.icpAudience,
    toneOfVoice: existing?.toneOfVoice ?? result.toneOfVoice,
    usps: existing?.usps?.length ? existing.usps : result.usps,
    brandTerms: existing?.brandTerms?.length
      ? existing.brandTerms
      : result.brandTerms,
    ctaTargets: existing?.ctaTargets?.length
      ? existing.ctaTargets
      : result.ctaTargets,
    // The summary is always refreshed: it is the crawl's own output, not
    // something a human curates.
    siteCrawlSummary: result.summary,
    siteCrawledAt: new Date(),
    updatedAt: new Date(),
  };

  if (existing) {
    await db()
      .update(brandVaults)
      .set(filled)
      .where(eq(brandVaults.clientId, input.clientId));
  } else {
    await db()
      .insert(brandVaults)
      .values({ clientId: input.clientId, ...filled });
  }

  return {
    summaryLength: result.summary.length,
    ctaTargets: result.ctaTargets.length,
    contentThemes: result.contentThemes,
  };
}
