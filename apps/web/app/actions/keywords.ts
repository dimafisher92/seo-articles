"use server";

import { and, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import {
  contentPlans,
  keywordRuns,
  keywords as keywordsTable,
  planItems,
  type ContentPlan,
  type Keyword,
  type KeywordRun,
  type PlanItem,
} from "@seo/db";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/queue";

import type { ActionResult } from "./clients";

async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------------------------------------ keyword runs */

export async function latestKeywordRun(
  clientId: string,
): Promise<KeywordRun | null> {
  await requireUser();
  const [run] = await db()
    .select()
    .from(keywordRuns)
    .where(eq(keywordRuns.clientId, clientId))
    .orderBy(desc(keywordRuns.createdAt))
    .limit(1);
  return run ?? null;
}

export async function listKeywords(runId: string): Promise<Keyword[]> {
  await requireUser();
  return db()
    .select()
    .from(keywordsTable)
    .where(eq(keywordsTable.runId, runId))
    .orderBy(desc(keywordsTable.priorityScore));
}

/**
 * Starts keyword research and content-gap analysis.
 *
 * This is the entry point of the whole workflow — the plan cannot be built
 * until a run has produced keywords to choose from.
 */
export async function startKeywordResearch(
  clientId: string,
  input: { seeds: string[]; competitors: string[]; maxKeywords?: number },
): Promise<ActionResult<{ runId: string; jobId: string }>> {
  return guard(async () => {
    await requireUser();

    const [run] = await db()
      .insert(keywordRuns)
      .values({
        clientId,
        seeds: input.seeds.map((s) => s.trim()).filter(Boolean),
        competitors: input.competitors.map((c) => c.trim()).filter(Boolean),
      })
      .returning({ id: keywordRuns.id });

    if (!run) throw new Error("Could not create the keyword run");

    const job = await enqueue({
      type: "keyword_research",
      clientId,
      payload: {
        clientId,
        runId: run.id,
        seeds: input.seeds,
        competitors: input.competitors,
        maxKeywords: input.maxKeywords ?? 400,
      },
    });

    revalidatePath(`/clients/${clientId}/keywords`);
    return { runId: run.id, jobId: job.id };
  });
}

export async function setKeywordSelection(
  clientId: string,
  keywordIds: string[],
  selected: boolean,
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();
    if (keywordIds.length === 0) return;

    await db()
      .update(keywordsTable)
      .set({ selected })
      .where(
        and(
          eq(keywordsTable.clientId, clientId),
          inArray(keywordsTable.id, keywordIds),
        ),
      );

    revalidatePath(`/clients/${clientId}/keywords`);
  });
}

/* ----------------------------------------------------------- content plans */

export async function latestContentPlan(
  clientId: string,
): Promise<ContentPlan | null> {
  await requireUser();
  const [plan] = await db()
    .select()
    .from(contentPlans)
    .where(eq(contentPlans.clientId, clientId))
    .orderBy(desc(contentPlans.createdAt))
    .limit(1);
  return plan ?? null;
}

export async function listPlanItems(planId: string): Promise<PlanItem[]> {
  await requireUser();
  return db()
    .select()
    .from(planItems)
    .where(eq(planItems.planId, planId))
    .orderBy(planItems.publishOrder);
}

/**
 * Builds the content plan from the ticked keywords.
 *
 * Deliberately a separate action from research: the strategist reviews the
 * keyword table and decides what is worth writing before any planning spend.
 */
export async function startContentPlan(
  clientId: string,
  input: { runId: string; targetTitles?: number },
): Promise<ActionResult<{ planId: string; jobId: string }>> {
  return guard(async () => {
    await requireUser();

    const selected = await db()
      .select({ id: keywordsTable.id })
      .from(keywordsTable)
      .where(
        and(
          eq(keywordsTable.runId, input.runId),
          eq(keywordsTable.selected, true),
        ),
      );

    if (selected.length === 0) {
      throw new Error(
        "Tick at least one keyword before building the content plan",
      );
    }

    const [plan] = await db()
      .insert(contentPlans)
      .values({ clientId, runId: input.runId })
      .returning({ id: contentPlans.id });

    if (!plan) throw new Error("Could not create the content plan");

    const job = await enqueue({
      type: "content_plan",
      clientId,
      payload: {
        clientId,
        planId: plan.id,
        runId: input.runId,
        keywordIds: selected.map((k) => k.id),
        targetTitles: input.targetTitles ?? 12,
      },
    });

    revalidatePath(`/clients/${clientId}/plan`);
    return { planId: plan.id, jobId: job.id };
  });
}
