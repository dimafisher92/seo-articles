import { jobFailSchema } from "@seo/shared";

import { deferJob, failJob } from "@/lib/queue";
import { isWorkerAuthorized, unauthorized } from "@/lib/worker-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isWorkerAuthorized(request)) return unauthorized();

  const { id } = await params;
  const parsed = jobFailSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  if (parsed.data.deferred) {
    await deferJob(id, parsed.data.error);
    return Response.json({ ok: true, requeued: true, deferred: true });
  }

  const { requeued } = await failJob(id, parsed.data.error, parsed.data.retryable);
  return Response.json({ ok: true, requeued });
}
