import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { currentUser } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Mints a scoped token so the browser can upload straight to Blob storage.
 *
 * Routing the bytes through a serverless function would cap uploads at 4.5 MB,
 * which a product photo clears easily. The token is minted only for a
 * signed-in user and only for image content types.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      token: env.blobToken,

      onBeforeGenerateToken: async (pathname) => {
        const user = await currentUser();
        if (!user) throw new Error("Not signed in");

        if (!pathname.startsWith("brand-assets/")) {
          throw new Error("Uploads are only allowed under brand-assets/");
        }

        return {
          allowedContentTypes: [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/avif",
          ],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ uploadedBy: user.email }),
        };
      },

      // The client records the asset row itself once the upload resolves; this
      // callback does not fire against a local dev tunnel, so it stays a no-op.
      onUploadCompleted: async () => {},
    });

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }
}
