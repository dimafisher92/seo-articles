import type {
  ContentGapRow,
  GeoOptions,
  KeywordMetrics,
  KeywordProvider,
  RankedKeyword,
  SerpEntry,
  SerpResult,
} from "@seo/shared";
import { normaliseDomain } from "@seo/shared";

import { log } from "../log.js";
import { McpHttpClient, unwrapToolResult } from "./mcp-http.js";

/**
 * SearchAtlas implementation of the keyword provider.
 *
 * Every volume, difficulty and ranking figure the app displays comes from here.
 * The model is never asked to estimate them — a plausible invented number is
 * worse than a blank cell, because a strategist will act on it.
 *
 * ## Why this talks to one endpoint and not to REST routes
 *
 * Two rounds of guessing REST paths found nothing, and SearchAtlas's own npm
 * bridge explains why: it hard-codes no paths at all, because their whole
 * programmatic surface is a single self-describing endpoint. The tool names
 * below were read from that endpoint's own catalogue with `tools/list`, not
 * inferred. `pnpm searchatlas:probe` prints it.
 *
 * ## The one thing worth knowing about their model
 *
 * Site Explorer is project-based: a domain is analysed by creating a project
 * for it, which SearchAtlas populates over 24-48 hours. `se_analyze_domain`
 * hides the create-or-resolve step, but not the wait — a domain SearchAtlas has
 * never seen returns little or nothing on the first run, and fills in later.
 * That is a property of their index, not a bug here, so it is surfaced as an
 * empty result and a warning rather than an error.
 *
 * ## Response shapes
 *
 * Read from the catalogue's schemas, but the *responses* were never seen from
 * the environment this was written in. So `pick()` accepts several plausible
 * spellings of each field and `rows()` finds the result array wherever it is
 * wrapped: a naming difference degrades to a null in one column rather than
 * taking down a research run.
 */

type Json = Record<string, unknown>;

/**
 * Tool names, overridable without a code change.
 *
 * They came from the live catalogue so they are real, but SearchAtlas ships
 * a new one of these every few weeks — `searchatlas-mcp 1.27.1` at the time of
 * writing — and an env var is a cheaper correction than a release.
 */
export const TOOLS = {
  /** Bulk volume/difficulty/CPC. Computes server-side; `wait` blocks for it. */
  metrics: process.env.SEARCHATLAS_TOOL_METRICS ?? "se_research_keywords",
  /** One keyword, and it returns related terms alongside the metrics. */
  lookup: process.env.SEARCHATLAS_TOOL_LOOKUP ?? "se_lookup_keyword",
  /** Resolves the Site Explorer project for a domain, then reads facets. */
  domain: process.env.SEARCHATLAS_TOOL_DOMAIN ?? "se_analyze_domain",
  /** The gap, natively: one primary against up to four competitors. */
  gapAnalyze: process.env.SEARCHATLAS_TOOL_GAP ?? "se_keyword_gap_analyze",
  gapResults:
    process.env.SEARCHATLAS_TOOL_GAP_RESULTS ?? "se_get_keyword_gap_results",
  /** Keyword-research projects; one of its modes is a SERP overview. */
  serp:
    process.env.SEARCHATLAS_TOOL_SERP ?? "se_keyword_research_projects",
} as const;

/** SearchAtlas takes at most four competitors per gap analysis. */
const MAX_GAP_COMPETITORS = 4;

/* ------------------------------------------------------------- extraction */

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reads the first present key — tolerates naming differences across tools. */
function pick(row: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

/**
 * Finds the result array wherever the response wraps it.
 *
 * Recursive because these payloads nest — `{ results: { keywords: [...] } }` is
 * as likely as a bare array, and which one it is varies per tool.
 */
function rows(payload: unknown, depth = 0): Json[] {
  if (Array.isArray(payload)) return payload as Json[];
  if (depth > 4 || !payload || typeof payload !== "object") return [];

  const obj = payload as Json;
  for (const key of [
    "data",
    "results",
    "items",
    "keywords",
    "keyword_data",
    "rows",
    "organic",
    "related_keywords",
    "tasks",
  ]) {
    const value = obj[key];
    if (Array.isArray(value)) return value as Json[];
  }

  for (const value of Object.values(obj)) {
    const nested = rows(value, depth + 1);
    if (nested.length > 0) return nested;
  }
  return [];
}

/** Finds a scalar by key at any depth — for ids buried in a wrapper. */
function findScalar(payload: unknown, keys: string[], depth = 0): unknown {
  if (depth > 5 || !payload || typeof payload !== "object") return undefined;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findScalar(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const obj = payload as Json;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  for (const value of Object.values(obj)) {
    const found = findScalar(value, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function mapMetrics(row: Json): KeywordMetrics {
  return {
    keyword: str(pick(row, "keyword", "term", "query", "keyword_text")) ?? "",
    volume: num(
      pick(row, "volume", "search_volume", "searchVolume", "monthly_searches"),
    ),
    difficulty: num(
      pick(
        row,
        "difficulty",
        "keyword_difficulty",
        "kd",
        "keywordDifficulty",
        "competition_index",
      ),
    ),
    cpc: num(pick(row, "cpc", "cost_per_click", "costPerClick")),
    intent: str(pick(row, "intent", "search_intent", "searchIntent")) ?? null,
  };
}

function mapRanked(row: Json): RankedKeyword | null {
  const keyword = str(pick(row, "keyword", "term", "query"));
  const position = num(pick(row, "position", "rank", "pos", "current_position"));
  if (!keyword || position === null) return null;

  const title = str(pick(row, "title", "page_title"));
  return {
    keyword,
    url: str(pick(row, "url", "page", "landing_page", "ranked_url")) ?? "",
    position,
    volume: num(pick(row, "volume", "search_volume", "searchVolume")),
    difficulty: num(pick(row, "difficulty", "keyword_difficulty", "kd")),
    ...(title !== undefined ? { title } : {}),
  };
}

/* --------------------------------------------------------------- provider */

export class SearchAtlasProvider implements KeywordProvider {
  readonly name = "searchatlas";
  private readonly client: McpHttpClient;

  constructor(credential: { apiKey?: string; token?: string }, url: string) {
    // Bearer first, matching SearchAtlas's own bridge; the API key is their
    // documented alternative and the one this project asks for.
    const headers: Record<string, string> = credential.token
      ? { authorization: `Bearer ${credential.token}` }
      : { "x-api-key": credential.apiKey! };

    this.client = new McpHttpClient(url, headers, "seo-articles-worker");
  }

  private async call(tool: string, args: Json): Promise<unknown> {
    const result = await this.client.callTool(tool, args);
    return unwrapToolResult(result);
  }

  /** Their country parameter is an uppercase alpha-2. */
  private geoArgs(geo: GeoOptions): Json {
    return {
      country_code: geo.country.toUpperCase(),
      ...(geo.locale ? { language: geo.locale.split("-")[0] } : {}),
    };
  }

  async getMetrics(
    keywords: string[],
    geo: GeoOptions,
  ): Promise<KeywordMetrics[]> {
    if (keywords.length === 0) return [];

    const out: KeywordMetrics[] = [];

    // Chunked so one oversized request cannot fail the whole run, and because
    // `wait` blocks server-side while these compute.
    for (let i = 0; i < keywords.length; i += 100) {
      const chunk = keywords.slice(i, i + 100);
      try {
        const payload = await this.call(TOOLS.metrics, {
          keywords: chunk,
          name: `seo-articles ${new Date().toISOString().slice(0, 10)}`,
          wait: true,
          ...this.geoArgs(geo),
        });

        out.push(
          ...rows(payload)
            .map(mapMetrics)
            .filter((metric) => metric.keyword),
        );
      } catch (error) {
        log.warn(
          `SearchAtlas metrics failed for ${chunk.length} keywords`,
          error,
        );
      }
    }

    return out;
  }

  async getRelated(
    seeds: string[],
    geo: GeoOptions,
    limit = 500,
  ): Promise<KeywordMetrics[]> {
    if (seeds.length === 0) return [];

    const collected = new Map<string, KeywordMetrics>();

    for (const seed of seeds) {
      try {
        // One call gets the seed's own metrics and its related terms, so the
        // seed is recorded too rather than needing a second lookup.
        const payload = await this.call(TOOLS.lookup, {
          keyword: seed,
          ...this.geoArgs(geo),
        });

        const candidates = [
          ...(payload && typeof payload === "object"
            ? [payload as Json]
            : []),
          ...rows(payload),
        ];

        for (const row of candidates) {
          const metrics = mapMetrics(row);
          if (!metrics.keyword) continue;

          const key = metrics.keyword.toLowerCase();
          const existing = collected.get(key);
          // Keep the richest record when a keyword surfaces under two seeds.
          if (!existing || (existing.volume === null && metrics.volume !== null)) {
            collected.set(key, metrics);
          }
        }
      } catch (error) {
        // One dead seed should not sink a run that has already gathered
        // hundreds of keywords from the others.
        log.warn(`SearchAtlas lookup failed for "${seed}"`, error);
      }
    }

    return [...collected.values()].slice(0, limit);
  }

  async getRankedKeywords(
    domain: string,
    geo: GeoOptions,
    limit = 1000,
  ): Promise<RankedKeyword[]> {
    const clean = normaliseDomain(domain);

    const payload = await this.call(TOOLS.domain, {
      domain: clean,
      facets: ["organic"],
      // Get-or-create: without this a domain SearchAtlas has not indexed yet
      // returns nothing and never starts being indexed.
      create_project: true,
      page_size: Math.min(limit, 1000),
      ...this.geoArgs(geo),
    });

    const ranked = rows(payload)
      .map(mapRanked)
      .filter((row): row is RankedKeyword => row !== null);

    if (ranked.length === 0) {
      log.warn(
        `No organic keywords for ${clean}. A newly created Site Explorer ` +
          "project takes 24-48h to populate — this fills in on a later run.",
      );
    }

    return ranked.slice(0, limit);
  }

  async getSerp(keyword: string, geo: GeoOptions): Promise<SerpResult> {
    const payload = await this.call(TOOLS.serp, {
      mode: process.env.SEARCHATLAS_SERP_MODE ?? "serp_overview",
      keyword,
      ...this.geoArgs(geo),
    });

    const results: SerpEntry[] = rows(payload)
      .map((row): SerpEntry | null => {
        const url = str(pick(row, "url", "link", "result_url"));
        const position = num(pick(row, "position", "rank", "pos"));
        if (!url || position === null) return null;

        const title = str(pick(row, "title"));
        const snippet = str(pick(row, "snippet", "description"));
        return {
          position,
          url,
          domain: normaliseDomain(url),
          ...(title !== undefined ? { title } : {}),
          ...(snippet !== undefined ? { snippet } : {}),
        };
      })
      .filter((entry): entry is SerpEntry => entry !== null)
      .sort((a, b) => a.position - b.position);

    const container = (payload ?? {}) as Json;
    const paa = pick(container, "people_also_ask", "peopleAlsoAsk", "questions");
    const related = pick(container, "related_searches", "relatedSearches");

    const strings = (value: unknown, key: string): string[] =>
      Array.isArray(value)
        ? value
            .map((item) =>
              typeof item === "string" ? item : str((item as Json)?.[key]),
            )
            .filter((item): item is string => Boolean(item))
        : [];

    return {
      keyword,
      results,
      peopleAlsoAsk: strings(paa, "question"),
      relatedSearches: strings(related, "keyword"),
    };
  }

  /**
   * The gap, computed by SearchAtlas rather than derived here.
   *
   * Their analysis is asynchronous; `wait` blocks server-side for it, and the
   * results are then read by `analysis_id`. Only the first four competitors are
   * sent because that is their documented ceiling — the rest are dropped
   * loudly rather than silently truncated, since a missing competitor changes
   * which keywords look like gaps.
   */
  async getKeywordGap(
    clientDomain: string,
    competitorDomains: string[],
    geo: GeoOptions,
    limit = 1000,
  ): Promise<ContentGapRow[]> {
    const primary = normaliseDomain(clientDomain);
    const competitors = competitorDomains
      .map(normaliseDomain)
      .filter((domain) => domain && domain !== primary);

    if (!primary || competitors.length === 0) return [];

    const used = competitors.slice(0, MAX_GAP_COMPETITORS);
    if (competitors.length > used.length) {
      log.warn(
        `SearchAtlas accepts ${MAX_GAP_COMPETITORS} competitors per gap ` +
          `analysis; ignoring ${competitors.slice(MAX_GAP_COMPETITORS).join(", ")}`,
      );
    }

    const created = await this.call(TOOLS.gapAnalyze, {
      primary_website: primary,
      competitor_websites: used,
      scope: process.env.SEARCHATLAS_GAP_SCOPE ?? "root_domain",
      wait: true,
      ...this.geoArgs(geo),
    });

    const analysisId = findScalar(created, [
      "analysis_id",
      "analysisId",
      "id",
      "uuid",
    ]);

    // Some tools return the rows straight from the create call when waiting.
    const inlineRows = rows(created);
    const payload =
      inlineRows.length > 0
        ? created
        : analysisId !== undefined
          ? await this.call(TOOLS.gapResults, {
              analysis_id: analysisId,
              mode: "get",
              page_size: Math.min(limit, 1000),
            })
          : null;

    if (!payload) {
      log.warn(
        "SearchAtlas gap analysis returned neither rows nor an analysis id",
      );
      return [];
    }

    return rows(payload)
      .map((row): ContentGapRow | null => {
        const keyword = str(pick(row, "keyword", "term", "query"));
        if (!keyword) return null;

        const clientRank = num(
          pick(
            row,
            "primary_position",
            "primary_rank",
            "client_position",
            "your_position",
            "position",
          ),
        );

        const competitorEntries = used
          .map((domain) => {
            // Competitor positions arrive keyed by domain, by index, or as a
            // nested list; all three spellings are tried before giving up.
            const byDomain = pick(row, domain, domain.replace(/\./g, "_"));
            const position = num(
              typeof byDomain === "object" && byDomain
                ? pick(byDomain as Json, "position", "rank")
                : byDomain,
            );
            if (position === null) return null;
            return {
              domain,
              url:
                str(
                  typeof byDomain === "object" && byDomain
                    ? pick(byDomain as Json, "url", "page")
                    : undefined,
                ) ?? "",
              position,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((a, b) => a.position - b.position);

        const nested = rows(pick(row, "competitors", "competitor_positions"));
        for (const entry of nested) {
          const position = num(pick(entry, "position", "rank"));
          const domain = str(pick(entry, "domain", "website", "url"));
          if (position === null || !domain) continue;
          competitorEntries.push({
            domain: normaliseDomain(domain),
            url: str(pick(entry, "url", "page")) ?? "",
            position,
          });
        }

        return {
          keyword,
          volume: num(pick(row, "volume", "search_volume")),
          difficulty: num(pick(row, "difficulty", "keyword_difficulty", "kd")),
          clientRank,
          competitors: competitorEntries,
          // Trust the provider's own verdict when it ships one; otherwise fall
          // back to the same rule computeContentGap uses.
          isGap:
            (pick(row, "is_gap", "isGap", "missing") as boolean | undefined) ??
            (clientRank === null || clientRank > 20),
        };
      })
      .filter((row): row is ContentGapRow => row !== null)
      .slice(0, limit);
  }
}
