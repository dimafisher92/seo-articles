import type {
  GeoOptions,
  KeywordMetrics,
  KeywordProvider,
  RankedKeyword,
  SerpEntry,
  SerpResult,
} from "@seo/shared";
import { normaliseDomain } from "@seo/shared";

import { config } from "../config.js";
import { log } from "../log.js";

/**
 * SearchAtlas implementation of the keyword provider.
 *
 * Every volume, difficulty and ranking figure the app displays comes from here.
 * The model is never asked to estimate them — a plausible invented number is
 * worse than a blank cell, because a strategist will act on it.
 *
 * ## Verifying the endpoint paths
 *
 * Authentication (`X-API-Key`, issued from Dashboard → API Settings) is
 * confirmed, and SearchAtlas documents per-service base URLs. The exact paths
 * and response field names below were not readable from the build environment,
 * so they are declared in ENDPOINTS and PATHS as a single block to correct
 * against https://docs.searchatlas.com once the key is in hand. Every override
 * is also available as an environment variable, so a correction needs no
 * redeploy of the worker.
 *
 * `mapMetrics` and friends accept several plausible field spellings for the
 * same value, so a naming difference degrades to a null rather than a crash.
 */

const PATHS = {
  metrics:
    process.env.SEARCHATLAS_PATH_METRICS ?? "/v2/keywords/overview",
  related:
    process.env.SEARCHATLAS_PATH_RELATED ?? "/v2/keywords/related",
  rankedKeywords:
    process.env.SEARCHATLAS_PATH_RANKED ?? "/v2/domains/ranked-keywords",
  serp: process.env.SEARCHATLAS_PATH_SERP ?? "/v2/serp",
} as const;

type Json = Record<string, unknown>;

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reads the first present key — tolerates naming differences across endpoints. */
function pick(row: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

/** Finds the result array wherever the response wraps it. */
function rows(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload as Json[];
  if (payload && typeof payload === "object") {
    const obj = payload as Json;
    for (const key of ["data", "results", "items", "keywords", "tasks"]) {
      const value = obj[key];
      if (Array.isArray(value)) return value as Json[];
      // One more level: { data: { results: [...] } }
      if (value && typeof value === "object") {
        const nested = rows(value);
        if (nested.length > 0) return nested;
      }
    }
  }
  return [];
}

export class SearchAtlasProvider implements KeywordProvider {
  readonly name = "searchatlas";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = config.searchAtlas.baseUrl,
  ) {}

  private async request(path: string, body: Json): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `SearchAtlas ${path} → ${response.status} ${response.statusText}. ` +
          `${text.slice(0, 400)}\n` +
          `If this is a 404, the path is wrong for your plan — override it with ` +
          `SEARCHATLAS_PATH_* and check https://docs.searchatlas.com.`,
      );
    }

    return response.json();
  }

  private mapMetrics(row: Json): KeywordMetrics {
    const keyword = str(pick(row, "keyword", "term", "query", "keyword_text"));
    return {
      keyword: keyword ?? "",
      volume: num(
        pick(row, "volume", "search_volume", "searchVolume", "monthly_searches"),
      ),
      difficulty: num(
        pick(row, "difficulty", "keyword_difficulty", "kd", "keywordDifficulty"),
      ),
      cpc: num(pick(row, "cpc", "cost_per_click", "costPerClick")),
      intent: str(pick(row, "intent", "search_intent", "searchIntent")) ?? null,
    };
  }

  async getMetrics(
    keywords: string[],
    geo: GeoOptions,
  ): Promise<KeywordMetrics[]> {
    if (keywords.length === 0) return [];

    // Chunked so one oversized request cannot fail the whole run.
    const chunks: string[][] = [];
    for (let i = 0; i < keywords.length; i += 200) {
      chunks.push(keywords.slice(i, i + 200));
    }

    const out: KeywordMetrics[] = [];
    for (const chunk of chunks) {
      const payload = await this.request(PATHS.metrics, {
        keywords: chunk,
        country: geo.country,
        location: geo.country,
        language: geo.locale?.split("-")[0] ?? "en",
      });
      out.push(
        ...rows(payload)
          .map((row) => this.mapMetrics(row))
          .filter((m) => m.keyword),
      );
    }
    return out;
  }

  async getRelated(
    seeds: string[],
    geo: GeoOptions,
    limit = 500,
  ): Promise<KeywordMetrics[]> {
    if (seeds.length === 0) return [];

    const perSeed = Math.max(20, Math.ceil(limit / seeds.length));
    const collected = new Map<string, KeywordMetrics>();

    for (const seed of seeds) {
      try {
        const payload = await this.request(PATHS.related, {
          keyword: seed,
          keywords: [seed],
          country: geo.country,
          location: geo.country,
          language: geo.locale?.split("-")[0] ?? "en",
          limit: perSeed,
        });

        for (const row of rows(payload)) {
          const metrics = this.mapMetrics(row);
          if (!metrics.keyword) continue;
          const key = metrics.keyword.toLowerCase();
          // Keep the richest record when a keyword surfaces under two seeds.
          const existing = collected.get(key);
          if (!existing || (existing.volume === null && metrics.volume !== null)) {
            collected.set(key, metrics);
          }
        }
      } catch (error) {
        // One dead seed should not sink a research run that has already
        // gathered hundreds of keywords from the others.
        log.warn(`SearchAtlas related lookup failed for "${seed}"`, error);
      }
    }

    return [...collected.values()].slice(0, limit);
  }

  async getRankedKeywords(
    domain: string,
    geo: GeoOptions,
    limit = 1000,
  ): Promise<RankedKeyword[]> {
    const payload = await this.request(PATHS.rankedKeywords, {
      domain: normaliseDomain(domain),
      target: normaliseDomain(domain),
      country: geo.country,
      location: geo.country,
      language: geo.locale?.split("-")[0] ?? "en",
      limit,
    });

    return rows(payload)
      .map((row): RankedKeyword | null => {
        const keyword = str(pick(row, "keyword", "term", "query"));
        const url = str(pick(row, "url", "page", "landing_page", "ranked_url"));
        const position = num(pick(row, "position", "rank", "pos"));
        if (!keyword || position === null) return null;

        return {
          keyword,
          url: url ?? "",
          position,
          volume: num(pick(row, "volume", "search_volume", "searchVolume")),
          difficulty: num(pick(row, "difficulty", "keyword_difficulty", "kd")),
          ...(str(pick(row, "title", "page_title")) !== undefined
            ? { title: str(pick(row, "title", "page_title")) as string }
            : {}),
        };
      })
      .filter((r): r is RankedKeyword => r !== null);
  }

  async getSerp(keyword: string, geo: GeoOptions): Promise<SerpResult> {
    const payload = await this.request(PATHS.serp, {
      keyword,
      query: keyword,
      country: geo.country,
      location: geo.country,
      language: geo.locale?.split("-")[0] ?? "en",
    });

    const results: SerpEntry[] = rows(payload)
      .map((row): SerpEntry | null => {
        const url = str(pick(row, "url", "link"));
        const position = num(pick(row, "position", "rank", "pos"));
        if (!url || position === null) return null;
        return {
          position,
          url,
          domain: normaliseDomain(url),
          ...(str(pick(row, "title")) !== undefined
            ? { title: str(pick(row, "title")) as string }
            : {}),
          ...(str(pick(row, "snippet", "description")) !== undefined
            ? { snippet: str(pick(row, "snippet", "description")) as string }
            : {}),
        };
      })
      .filter((r): r is SerpEntry => r !== null)
      .sort((a, b) => a.position - b.position);

    const container = (payload ?? {}) as Json;
    const paa = pick(container, "people_also_ask", "peopleAlsoAsk", "questions");
    const related = pick(container, "related_searches", "relatedSearches");

    return {
      keyword,
      results,
      peopleAlsoAsk: Array.isArray(paa)
        ? paa
            .map((q) =>
              typeof q === "string" ? q : str((q as Json)?.question ?? ""),
            )
            .filter((q): q is string => Boolean(q))
        : [],
      relatedSearches: Array.isArray(related)
        ? related
            .map((q) =>
              typeof q === "string" ? q : str((q as Json)?.keyword ?? ""),
            )
            .filter((q): q is string => Boolean(q))
        : [],
    };
  }
}

/**
 * Returns the provider, or null when no key is configured.
 *
 * A null provider means the keyword pipeline runs in research-only mode: it
 * still builds clusters and finds gaps from live SERPs, but leaves volume and
 * difficulty blank rather than guessing.
 */
export function createKeywordProvider(): KeywordProvider | null {
  const apiKey = config.searchAtlas.apiKey;
  if (!apiKey) {
    log.warn(
      "SEARCHATLAS_API_KEY is not set — keyword runs will have no volume or " +
        "difficulty data. Clusters and content gaps still work from live SERPs.",
    );
    return null;
  }
  return new SearchAtlasProvider(apiKey);
}

/**
 * One line for the startup banner, matching the image provider's.
 *
 * Without it a missing key is invisible until a keyword run comes back with
 * blank volume columns, which reads as a broken provider rather than an absent
 * one. Overridden paths are named too: they are the setting most likely to be
 * wrong, and the least likely to be remembered.
 */
export function describeKeywordProvider(): string {
  if (!config.searchAtlas.apiKey) {
    return "Keywords: none configured — clusters and gaps only, no volume data";
  }

  // Spelled out rather than derived: the variable for `rankedKeywords` is
  // SEARCHATLAS_PATH_RANKED, so uppercasing the key would silently never match.
  const PATH_ENV_VARS = {
    metrics: "SEARCHATLAS_PATH_METRICS",
    related: "SEARCHATLAS_PATH_RELATED",
    rankedKeywords: "SEARCHATLAS_PATH_RANKED",
    serp: "SEARCHATLAS_PATH_SERP",
  } as const satisfies Record<keyof typeof PATHS, string>;

  const overridden = Object.entries(PATH_ENV_VARS)
    .filter(([, variable]) => process.env[variable])
    .map(([key]) => key);

  const paths =
    overridden.length > 0 ? ` · custom paths: ${overridden.join(", ")}` : "";

  return `Keywords: SearchAtlas · ${config.searchAtlas.baseUrl}${paths}`;
}
