import { requeueStaleJobs } from "@/lib/queue";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Runs the stale-job sweep on demand.
 *
 * Recovery does not depend on this endpoint: `/api/worker/claim` sweeps on its
 * own, so a job abandoned mid-run is rescued the next time a worker polls. This
 * stays for the cases where nobody is polling — a manual nudge while the worker
 * is off, or a scheduled call from a plan whose cron limits allow a useful
 * interval. (Vercel's Hobby plan allows one run per day, and rejects the
 * deployment outright for anything more frequent, which is why the schedule was
 * dropped from `vercel.json`.)
 */
export async function GET(request: Request): Promise<Response> {
  const secret = env.cronSecret;
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not set, so this endpoint is disabled." },
      { status: 401 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await requeueStaleJobs();
  return Response.json(result);
}
