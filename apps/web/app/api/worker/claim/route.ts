import { claimNextJob, maybeRequeueStaleJobs } from "@/lib/queue";
import { isWorkerAuthorized, unauthorized } from "@/lib/worker-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Pull-based dispatch: the worker asks for work rather than the app pushing it.
 * That keeps the worker behind NAT with no inbound ports, and means jobs simply
 * queue up while the machine is off.
 *
 * Reaping rides along on the same request. A job abandoned by a worker that
 * died mid-run has to be requeued by someone, and the only moment that matters
 * is when a worker is asking for work — so the sweep happens here (throttled),
 * and the rescued job is handed out in this very response.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isWorkerAuthorized(request)) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { workerId?: string };
  const workerId = body.workerId ?? "unknown";

  await maybeRequeueStaleJobs();

  const job = await claimNextJob(workerId);
  return Response.json({ job });
}
