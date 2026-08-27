import { jobCompleteSchema } from "@seo/shared";

import { completeJob } from "@/lib/queue";
import { isWorkerAuthorized, unauthorized } from "@/lib/worker-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isWorkerAuthorized(request)) return unauthorized();

  const { id } = await params;
  const parsed = jobCompleteSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  await completeJob(id, parsed.data.result);
  return Response.json({ ok: true });
}
