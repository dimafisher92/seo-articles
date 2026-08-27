import { eq, inArray } from "drizzle-orm";

import {
  contentPlans,
  keywords as keywordsTable,
  planItems,
  type NewPlanItem,
} from "@seo/db";
import { contentPlanPrompt } from "@seo/playbook";
import { loadPlaybook } from "@seo/playbook";

import { RESEARCH_TOOLS, runStageWithRetry } from "../claude.js";
import { db, loadClient, toBrandContext } from "../data.js";
import {
  contentPlanSchema,
  type ContentPlanOutput,
} from "../schemas.js";
import type { StageReporter } from "./types.js";

export type ContentPlanInput = {
  clientId: string;
  planId: string;
  keywordIds: string[];
  targetTitles: number;
};

/**
 * Turns selected keywords into a plan of article titles and briefs.
 *
 * This stage deliberately stops at titles. Writing every article up front would
 * burn hours of subscription budget on pieces the strategist may never want;
 * the plan is a review gate, and each article is commissioned individually from
 * its own button.
 */
export async function runContentPlan(
  input: ContentPlanInput,
  report: StageReporter,
): Promise<Record<string, unknown>> {
  const loaded = await loadClient(input.clientId);
  const brand = toBrandContext(loaded);

  await db()
    .update(contentPlans)
    .set({ status: "running", error: null })
    .where(eq(contentPlans.id, input.planId));

  try {
    await report(1, 3, "Loading selected keywords");

    const selected = await db()
      .select()
      .from(keywordsTable)
      .where(inArray(keywordsTable.id, input.keywordIds));

    if (selected.length === 0) {
      throw new Error("No keywords found for the supplied ids");
    }

    await report(
      2,
      3,
      "Designing the content plan",
      `${selected.length} keywords → ${input.targetTitles} articles`,
    );

    const prompt = contentPlanPrompt(
      brand,
      selected
        .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
        .map((k) => ({
          keyword: k.keyword,
          volume: k.volume,
          difficulty: k.difficulty,
          cluster: k.cluster,
          intent: k.intent,
          funnelStage: k.funnelStage,
          isGap: k.isGap,
          competitorUrls: k.competitorUrls.map((c) => ({
            url: c.url,
            position: c.position,
          })),
        })),
      input.targetTitles,
      loadPlaybook(),
    );

    // Titles have to beat the live SERP, so this stage gets web access: the
    // angle is only defensible if it is checked against what actually ranks.
    const result = await runStageWithRetry<ContentPlanOutput>(prompt, {
      schema: contentPlanSchema,
      label: "content-plan",
      tools: RESEARCH_TOOLS,
      maxTurns: 60,
      timeoutMs: 25 * 60_000,
    });

    await report(3, 3, "Saving titles");

    const validKeywords = new Set(
      selected.map((k) => k.keyword.toLowerCase().trim()),
    );

    const rows: NewPlanItem[] = result.items
      // Guard against a hallucinated main keyword that was never on the list.
      .filter((item) => validKeywords.has(item.mainKeyword.toLowerCase().trim()))
      .sort((a, b) => b.priority - a.priority)
      .map((item, index) => ({
        planId: input.planId,
        clientId: input.clientId,
        title: item.title,
        mainKeyword: item.mainKeyword,
        secondaryKeywords: item.secondaryKeywords,
        cluster:
          selected.find(
            (k) =>
              k.keyword.toLowerCase().trim() ===
              item.mainKeyword.toLowerCase().trim(),
          )?.cluster ?? null,
        intent: item.intent,
        pageType: item.pageType,
        funnelStage: item.funnelStage,
        targetWordCount: item.targetWordCount,
        internalLinkTargets: item.internalLinkTargets,
        serpNotes: item.serpNotes,
        rationale: item.rationale,
        priority: item.priority,
        publishOrder: index + 1,
        status: "planned" as const,
      }));

    if (rows.length === 0) {
      throw new Error(
        "The plan contained no titles whose main keyword was in the selection",
      );
    }

    await db().delete(planItems).where(eq(planItems.planId, input.planId));
    await db().insert(planItems).values(rows);

    await db()
      .update(contentPlans)
      .set({ status: "ready", finishedAt: new Date() })
      .where(eq(contentPlans.id, input.planId));

    return {
      titles: rows.length,
      dropped: result.items.length - rows.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db()
      .update(contentPlans)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(contentPlans.id, input.planId));
    throw error;
  }
}
