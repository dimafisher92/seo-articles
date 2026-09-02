"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { jobs, planItems } from "@seo/db";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { cancelJob } from "@/lib/queue";

import type { ActionResult } from "./clients";

/**
 * Stops a running or queued job.
 *
 * Needed for more than impatience: the worker is a separate process on another
 * machine, and when it restarts mid-article the job stays `running` in the
 * database with nobody working on it. The stale-job sweep eventually requeues
 * it, but "eventually" is ten minutes of a progress bar that is lying, and
 * there was no way to say so.
 *
 * A write_article job also owns a plan row, which is left saying "Writing…"
 * unless it is put back. It goes to `failed`, which is what the row shows a
 * Retry button for.
 */
export async function stopJob(jobId: string): Promise<ActionResult<null>> {
  try {
    await requireUser();

    const [job] = await db()
      .select({ type: jobs.type, clientId: jobs.clientId, payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (!job) return { ok: false, error: "Job not found" };

    const stopped = await cancelJob(jobId);
    if (!stopped) {
      return { ok: false, error: "That job had already finished" };
    }

    const planItemId = (job.payload as { planItemId?: string } | null)?.planItemId;
    if (job.type === "write_article" && planItemId) {
      await db()
        .update(planItems)
        .set({ status: "failed" })
        .where(eq(planItems.id, planItemId));
    }

    if (job.clientId) {
      revalidatePath(`/clients/${job.clientId}/plan`);
      revalidatePath(`/clients/${job.clientId}/articles`);
    }

    return { ok: true, data: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
