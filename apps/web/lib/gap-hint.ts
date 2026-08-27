import type { KeywordRunSummary } from "@seo/db";

/**
 * What a content-gap count actually means.
 *
 * Zero is three different situations, and the page used to assert the strongest
 * of them for all three — "Competitors rank, this client does not" is a claim
 * about the market, and it was being made when nobody had been asked and when
 * the answer had not arrived yet. A strategist reads that number and decides
 * what to commission, so it has to distinguish "no gap" from "no data".
 */
export function gapHint(summary: KeywordRunSummary | null | undefined): string {
  const requested = summary?.competitorsRequested ?? [];
  const analysed = summary?.competitorsAnalysed ?? [];
  const gaps = summary?.gapKeywords ?? 0;

  if (gaps > 0) return "Competitors rank, this client does not";

  if (requested.length === 0) {
    return "No competitors set — add them to the Brand Vault";
  }

  if (analysed.length === 0) {
    // A Site Explorer project takes 24-48h to populate, so a first run against
    // a domain SearchAtlas has not indexed answers exactly like a domain with
    // nothing to find.
    return `No ranking data for ${requested.join(", ")} yet — a new domain takes a day or two to index`;
  }

  return "Nothing found that these competitors rank for and this client does not";
}
