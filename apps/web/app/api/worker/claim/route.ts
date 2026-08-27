import { claimNextJob } from "@/lib/queue";
import { isWorkerAuthorized, unauthorized } from "@/lib/worker-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Pull-based dispatch: the worker asks for work rather than the app pushing it.
 * That keeps the worker behind NAT with no inbound ports, and means jobs simply
 * queue up while the machine is off.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isWorkerAuthorized(request)) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { workerId?: string };
  const workerId = body.workerId ?? "unknown";

  const job = await claimNextJob(workerId);
  return Response.json({ job });
}
