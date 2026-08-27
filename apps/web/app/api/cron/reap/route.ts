import { requeueStaleJobs } from "@/lib/queue";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Vercel cron entry point. Rescues jobs abandoned by a worker that went away
 * mid-run — without this the UI would spin on a job nobody is executing.
 */
export async function GET(request: Request): Promise<Response> {
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${env.cronSecret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await requeueStaleJobs();
  return Response.json(result);
}
