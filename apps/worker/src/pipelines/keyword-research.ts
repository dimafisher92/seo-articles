import { eq } from "drizzle-orm";

import {
  keywordRuns,
  keywords as keywordsTable,
  type KeywordRunSummary,
  type NewKeyword,
} from "@seo/db";
import {
  computeContentGap,
  scoreKeyword,
  type GeoOptions,
  type KeywordMetrics,
  type KeywordProvider,
  type RankedKeyword,
} from "@seo/shared";
import { clusterKeywordsPrompt, seedKeywordsPrompt } from "@seo/playbook";

import { config } from "../config.js";
import { runStageWithRetry } from "../claude.js";
import { db, loadClient, toBrandContext } from "../data.js";
import { log } from "../log.js";
import { createKeywordProvider } from "../providers/keywords.js";
import {
  clusterSchema,
  seedKeywordsSchema,
  type ClusterOutput,
  type SeedKeywordsOutput,
} from "../schemas.js";
import type { StageReporter } from "./types.js";

const TOTAL_STEPS = 6;
/** Clustering is mechanical classification; a mid-tier model handles it well. */
const CLUSTER_BATCH = 250;

export type KeywordResearchInput = {
  clientId: string;
  runId: string;
  seeds: string[];
  competitors: string[];
  maxKeywords: number;
};

export async function runKeywordResearch(
  input: KeywordResearchInput,
  report: StageReporter,
): Promise<Record<string, unknown>> {
  const loaded = await loadClient(input.clientId);
  const brand = toBrandContext(loaded);
  const geo: GeoOptions = {
    country: loaded.client.country,
    locale: loaded.client.locale,
  };

  await db()
    .update(keywordRuns)
    .set({ status: "running", error: null })
    .where(eq(keywordRuns.id, input.runId));

  try {
    /* 1 — seeds ---------------------------------------------------------- */
    await report(1, TOTAL_STEPS, "Choosing seed keywords");

    const manualSeeds = input.seeds.map((s) => s.trim()).filter(Boolean);
    const generated = await runStageWithRetry<SeedKeywordsOutput>(
      seedKeywordsPrompt(brand),
      { schema: seedKeywordsSchema, label: "seeds", maxTurns: 4 },
    );

    const seeds = dedupe([...manualSeeds, ...generated.seeds]);
    log.info(`Seeds: ${seeds.length}`);

    /* 2 — expansion ------------------------------------------------------ */
    await report(2, TOTAL_STEPS, "Pulling keyword volume", `${seeds.length} seeds`);

    const provider = createKeywordProvider();
    const expanded = provider
      ? await provider.getRelated(seeds, geo, input.maxKeywords)
      : [];

    // Seeds themselves belong in the table even when expansion is unavailable.
    const seedMetrics = provider
      ? await provider.getMetrics(seeds, geo)
      : seeds.map(
          (keyword): KeywordMetrics => ({
            keyword,
            volume: null,
            difficulty: null,
            cpc: null,
          }),
        );

    const metricsByKeyword = new Map<string, KeywordMetrics>();
    for (const metric of [...expanded, ...seedMetrics]) {
      const key = metric.keyword.toLowerCase().trim();
      if (!key) continue;
      const existing = metricsByKeyword.get(key);
      if (!existing || (existing.volume === null && metric.volume !== null)) {
        metricsByKeyword.set(key, metric);
      }
    }

    /* 3 — content gap ---------------------------------------------------- */
    const competitorDomains = dedupe([
      ...input.competitors,
      ...(loaded.vault?.competitors ?? []),
    ]);
    await report(
      3,
      TOTAL_STEPS,
      "Analysing content gap",
      `${competitorDomains.length} competitors`,
    );

    const { gapRows, competitorsAnalysed } = await analyseGap({
      provider,
      clientDomain: loaded.client.domain,
      competitorDomains,
      geo,
    });

    // Gap keywords are the point of the exercise, so they enter the pool even
    // when they never surfaced through seed expansion.
    for (const row of gapRows) {
      const key = row.keyword.toLowerCase().trim();
      if (!metricsByKeyword.has(key)) {
        metricsByKeyword.set(key, {
          keyword: row.keyword,
          volume: row.volume,
          difficulty: row.difficulty,
          cpc: null,
        });
      }
    }

    const gapByKeyword = new Map(
      gapRows.map((row) => [row.keyword.toLowerCase().trim(), row]),
    );

    /* 4 — trim to a reviewable set --------------------------------------- */
    await report(4, TOTAL_STEPS, "Ranking candidates");

    const candidates = [...metricsByKeyword.values()]
      .sort((a, b) => {
        // Gap keywords first, then by volume — this only decides what survives
        // the cap; real priority is scored after clustering.
        const aGap = gapByKeyword.get(a.keyword.toLowerCase())?.isGap ? 1 : 0;
        const bGap = gapByKeyword.get(b.keyword.toLowerCase())?.isGap ? 1 : 0;
        if (aGap !== bGap) return bGap - aGap;
        return (b.volume ?? 0) - (a.volume ?? 0);
      })
      .slice(0, input.maxKeywords);

    /* 5 — clustering ----------------------------------------------------- */
    await report(
      5,
      TOTAL_STEPS,
      "Clustering into topics",
      `${candidates.length} keywords`,
    );

    const classification = await clusterInBatches(
      candidates,
      gapByKeyword,
      brand,
    );

    /* 6 — persist -------------------------------------------------------- */
    await report(6, TOTAL_STEPS, "Saving results");

    const rows: NewKeyword[] = candidates.map((metric) => {
      const key = metric.keyword.toLowerCase().trim();
      const gap = gapByKeyword.get(key);
      const cls = classification.get(key);

      return {
        runId: input.runId,
        clientId: input.clientId,
        keyword: metric.keyword,
        volume: metric.volume,
        difficulty: metric.difficulty,
        cpc: metric.cpc,
        intent: cls?.intent ?? null,
        cluster: cls?.cluster ?? "Unclustered",
        pageType: cls?.pageType ?? null,
        funnelStage: cls?.funnelStage ?? null,
        isGap: gap?.isGap ?? false,
        competitorUrls:
          gap?.competitors.map((c) => ({
            domain: c.domain,
            url: c.url,
            position: c.position,
          })) ?? [],
        clientRank: gap?.clientRank ?? null,
        priorityScore: scoreKeyword({
          volume: metric.volume,
          difficulty: metric.difficulty,
          isGap: gap?.isGap ?? false,
          competitorCount: gap?.competitors.length ?? 0,
          ...(cls ? { businessRelevance: cls.businessRelevance } : {}),
          ...(cls?.funnelStage ? { funnelStage: cls.funnelStage } : {}),
        }),
      };
    });

    // A re-run replaces the previous result set for this run rather than
    // stacking duplicates alongside it.
    await db().delete(keywordsTable).where(eq(keywordsTable.runId, input.runId));
    for (let i = 0; i < rows.length; i += 500) {
      await db().insert(keywordsTable).values(rows.slice(i, i + 500));
    }

    const summary = buildSummary(rows, competitorsAnalysed, Boolean(provider));

    await db()
      .update(keywordRuns)
      .set({
        status: "ready",
        seeds,
        competitors: competitorsAnalysed,
        summary,
        finishedAt: new Date(),
      })
      .where(eq(keywordRuns.id, input.runId));

    return {
      keywords: rows.length,
      gapKeywords: summary.gapKeywords,
      clusters: summary.clusters?.length ?? 0,
      hasVolumeData: Boolean(provider),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db()
      .update(keywordRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(keywordRuns.id, input.runId));
    throw error;
  }
}

/* ------------------------------------------------------------------ helpers */

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

async function analyseGap(params: {
  provider: KeywordProvider | null;
  clientDomain: string | null;
  competitorDomains: string[];
  geo: GeoOptions;
}): Promise<{
  gapRows: ReturnType<typeof computeContentGap>;
  competitorsAnalysed: string[];
}> {
  const { provider, clientDomain, competitorDomains, geo } = params;
  if (!provider || competitorDomains.length === 0) {
    return { gapRows: [], competitorsAnalysed: [] };
  }

  // Prefer the provider's own gap analysis. Deriving it below means pulling
  // every ranking for the client and for each competitor and diffing them
  // here — many more calls, and a worse answer, since the provider can see the
  // keywords that fell outside whatever page size we asked for.
  if (provider.getKeywordGap && clientDomain) {
    try {
      const gapRows = await provider.getKeywordGap(
        clientDomain,
        competitorDomains,
        geo,
      );
      if (gapRows.length > 0) {
        return {
          gapRows,
          competitorsAnalysed: [
            ...new Set(
              gapRows.flatMap((row) => row.competitors.map((c) => c.domain)),
            ),
          ],
        };
      }
      // An empty result is not proof of no gap: a Site Explorer project that
      // has not finished populating answers the same way. Fall through and
      // derive it, which at least reports which competitors had data.
      log.warn("Native gap analysis returned nothing; deriving it instead");
    } catch (error) {
      log.warn("Native gap analysis failed; deriving it instead", error);
    }
  }

  const clientRanked: RankedKeyword[] = clientDomain
    ? await provider
        .getRankedKeywords(clientDomain, geo, 2000)
        .catch((error) => {
          log.warn(`Could not fetch rankings for ${clientDomain}`, error);
          return [];
        })
    : [];

  const competitorRanked = new Map<string, RankedKeyword[]>();
  const analysed: string[] = [];

  for (const domain of competitorDomains) {
    try {
      const ranked = await provider.getRankedKeywords(domain, geo, 1000);
      competitorRanked.set(domain, ranked);
      analysed.push(domain);
    } catch (error) {
      // A competitor the provider has no data for should not abort the run.
      log.warn(`Could not fetch rankings for competitor ${domain}`, error);
    }
  }

  return {
    gapRows: computeContentGap(clientRanked, competitorRanked),
    competitorsAnalysed: analysed,
  };
}

type Classification = ClusterOutput["keywords"][number];

/**
 * Classifies keywords in batches.
 *
 * A single prompt carrying 400 keywords produces noticeably lazier labels than
 * several carrying 250, and one malformed response would cost the whole set.
 */
async function clusterInBatches(
  candidates: KeywordMetrics[],
  gapByKeyword: Map<string, { isGap: boolean }>,
  brand: Parameters<typeof clusterKeywordsPrompt>[0],
): Promise<Map<string, Classification>> {
  const out = new Map<string, Classification>();

  for (let i = 0; i < candidates.length; i += CLUSTER_BATCH) {
    const batch = candidates.slice(i, i + CLUSTER_BATCH);
    const prompt = clusterKeywordsPrompt(
      brand,
      batch.map((k) => ({
        keyword: k.keyword,
        volume: k.volume,
        difficulty: k.difficulty,
        isGap: gapByKeyword.get(k.keyword.toLowerCase())?.isGap ?? false,
      })),
    );

    const result = await runStageWithRetry<ClusterOutput>(prompt, {
      schema: clusterSchema,
      label: `cluster-${i / CLUSTER_BATCH + 1}`,
      model: config.claude.fastModel,
      maxTurns: 4,
      timeoutMs: 10 * 60_000,
    });

    for (const row of result.keywords) {
      out.set(row.keyword.toLowerCase().trim(), row);
    }
  }

  return out;
}

function buildSummary(
  rows: NewKeyword[],
  competitorsAnalysed: string[],
  hasVolumeData: boolean,
): KeywordRunSummary {
  const byCluster = new Map<string, { count: number; volume: number }>();
  for (const row of rows) {
    const name = row.cluster ?? "Unclustered";
    const entry = byCluster.get(name) ?? { count: 0, volume: 0 };
    entry.count += 1;
    entry.volume += row.volume ?? 0;
    byCluster.set(name, entry);
  }

  return {
    totalKeywords: rows.length,
    gapKeywords: rows.filter((r) => r.isGap).length,
    clusters: [...byCluster.entries()]
      .map(([name, v]) => ({
        name,
        keywordCount: v.count,
        totalVolume: v.volume,
      }))
      .sort((a, b) => b.totalVolume - a.totalVolume),
    competitorsAnalysed,
    ...(hasVolumeData
      ? {}
      : {
          notes:
            "No keyword data provider configured — volume and difficulty are blank. " +
            "Set SEARCHATLAS_API_KEY on the worker to populate them.",
        }),
  };
}
