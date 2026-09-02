import { jobProgressSchema } from "@seo/shared";

import { heartbeat, isCanceled } from "@/lib/queue";
import { isWorkerAuthorized, unauthorized } from "@/lib/worker-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isWorkerAuthorized(request)) return unauthorized();

  const { id } = await params;
  const parsed = jobProgressSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  await heartbeat(id, parsed.data);

  // The worker pulls; it has no inbox. This response is the only channel that
  // reaches it while a job runs, so the answer to "should I still be doing
  // this?" rides back on the heartbeat it was already sending.
  return Response.json({ ok: true, canceled: await isCanceled(id) });
}
