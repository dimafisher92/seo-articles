/**
 * Keyword-data provider boundary.
 *
 * Every number the app shows for volume / difficulty / CPC must come through
 * here — the language model is never asked to invent them. SearchAtlas is the
 * first implementation; the interface keeps the rest of the codebase free of
 * its request shapes so a swap stays a one-file change.
 */

export type KeywordMetrics = {
  keyword: string;
  /** Average monthly searches. Null when the provider has no data. */
  volume: number | null;
  /** 0-100. Null when unavailable. */
  difficulty: number | null;
  cpc: number | null;
  /** Provider's own intent label, if it ships one. */
  intent?: string | null;
  /** Month-over-month volume series, newest last. */
  trend?: number[];
};

export type RankedKeyword = {
  keyword: string;
  url: string;
  position: number;
  volume: number | null;
  difficulty: number | null;
  title?: string;
};

export type SerpEntry = {
  position: number;
  url: string;
  domain: string;
  title?: string;
  snippet?: string;
};

export type SerpResult = {
  keyword: string;
  results: SerpEntry[];
  peopleAlsoAsk: string[];
  relatedSearches: string[];
};

export type GeoOptions = {
  /** ISO-3166-1 alpha-2. */
  country: string;
  /** BCP-47 or provider language code. */
  locale?: string;
};

export interface KeywordProvider {
  readonly name: string;

  /** Volume / difficulty / CPC for an exact keyword list. */
  getMetrics(
    keywords: string[],
    geo: GeoOptions,
  ): Promise<KeywordMetrics[]>;

  /** Expansion around seed terms. */
  getRelated(
    seeds: string[],
    geo: GeoOptions,
    limit?: number,
  ): Promise<KeywordMetrics[]>;

  /** Keywords a domain already ranks for — the client's own footprint. */
  getRankedKeywords(
    domain: string,
    geo: GeoOptions,
    limit?: number,
  ): Promise<RankedKeyword[]>;

  /** Top organic results for a keyword, plus PAA. Used for SERP intel. */
  getSerp(keyword: string, geo: GeoOptions): Promise<SerpResult>;
}

/* ------------------------------------------------------------- gap logic */

export type ContentGapRow = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  /** Best position the client holds, or null when absent from the top 100. */
  clientRank: number | null;
  competitors: { domain: string; url: string; position: number }[];
  isGap: boolean;
};

/**
 * A gap is a keyword competitors rank for and the client does not — or ranks
 * far enough back to be invisible. `gapThreshold` is the position past which
 * we treat the client as absent; 20 keeps page-two rankings in scope, since
 * those are usually cheaper to lift than net-new pages.
 */
export function computeContentGap(
  clientRanked: RankedKeyword[],
  competitorRanked: Map<string, RankedKeyword[]>,
  gapThreshold = 20,
): ContentGapRow[] {
  const clientBest = new Map<string, number>();
  for (const row of clientRanked) {
    const key = row.keyword.toLowerCase();
    const current = clientBest.get(key);
    if (current === undefined || row.position < current) {
      clientBest.set(key, row.position);
    }
  }

  const byKeyword = new Map<string, ContentGapRow>();

  for (const [domain, rows] of competitorRanked) {
    for (const row of rows) {
      const key = row.keyword.toLowerCase();
      let entry = byKeyword.get(key);
      if (!entry) {
        const clientRank = clientBest.get(key) ?? null;
        entry = {
          keyword: row.keyword,
          volume: row.volume,
          difficulty: row.difficulty,
          clientRank,
          competitors: [],
          isGap: clientRank === null || clientRank > gapThreshold,
        };
        byKeyword.set(key, entry);
      }
      entry.competitors.push({
        domain,
        url: row.url,
        position: row.position,
      });
      // Keep the richest metrics we have seen for this keyword.
      entry.volume ??= row.volume;
      entry.difficulty ??= row.difficulty;
    }
  }

  for (const entry of byKeyword.values()) {
    entry.competitors.sort((a, b) => a.position - b.position);
  }

  return [...byKeyword.values()];
}

/* --------------------------------------------------------------- scoring */

export type ScoreInput = {
  volume: number | null;
  difficulty: number | null;
  isGap: boolean;
  /** How many tracked competitors rank for it. */
  competitorCount: number;
  /**
   * 0-1, how close the keyword sits to what the client actually sells.
   * Assigned by the clustering stage, not by the provider.
   */
  businessRelevance?: number;
  funnelStage?: "tofu" | "mofu" | "bofu";
};

const FUNNEL_WEIGHT: Record<string, number> = {
  bofu: 1.15,
  mofu: 1.05,
  tofu: 0.95,
};

/**
 * Blends demand, attainability and commercial fit into a single 0-100 sort
 * key for the keyword table.
 *
 * Volume is compressed logarithmically so a 50k-a-month head term does not
 * bury a 900-a-month term the client can realistically win and actually
 * monetise. Difficulty is inverted, gaps get a boost (competitors have already
 * proven the demand converts in this niche), and business relevance is the
 * strongest single multiplier — high-volume traffic that never buys is the
 * classic way these plans go wrong.
 */
export function scoreKeyword(input: ScoreInput): number {
  const volume = input.volume ?? 0;
  // log10(1 + v) / log10(100001) → 0 at zero volume, 1 at ~100k.
  const demand = Math.min(1, Math.log10(1 + volume) / Math.log10(100_001));

  const difficulty = input.difficulty ?? 50;
  const attainability = 1 - Math.min(100, Math.max(0, difficulty)) / 100;

  const relevance = input.businessRelevance ?? 0.6;

  const gapBoost = input.isGap ? 1.2 : 1;
  const proofBoost = 1 + Math.min(input.competitorCount, 5) * 0.03;
  const funnelBoost = FUNNEL_WEIGHT[input.funnelStage ?? "mofu"] ?? 1;

  const base =
    demand * 0.35 + attainability * 0.25 + relevance * 0.4;

  const score = base * gapBoost * proofBoost * funnelBoost * 100;
  return Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
}
