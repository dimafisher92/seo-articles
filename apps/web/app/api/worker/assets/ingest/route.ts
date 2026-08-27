import { assetIngestSchema } from "@seo/shared";

import { ingestRemoteImage } from "@/lib/blob";
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
    return Response.json({ error: message }, { status: 502 });
  }
}
