import { assetIngestSchema } from "@seo/shared";

import { ingestRemoteImage, PermanentIngestError } from "@/lib/blob";
import { isWorkerAuthorized, unauthorized } from "@/lib/worker-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Downloading a 4K render and pushing it to Blob can outrun the default. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  if (!isWorkerAuthorized(request)) return unauthorized();

  const parsed = assetIngestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const { sourceUrl, prefix, filename } = parsed.data;
  try {
    const result = await ingestRemoteImage(sourceUrl, prefix, filename);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // 502 says "the upstream had a moment", and the worker believes it: it
    // treats a 502 as transient and retries. A private Blob store is not a
    // moment — it retried that three times before giving up. A permanent
    // failure gets a 4xx so the retry does not happen and the message is the
    // first thing read, not the status.
    const status = error instanceof PermanentIngestError ? 422 : 502;
    return Response.json({ error: message }, { status });
  }
}
