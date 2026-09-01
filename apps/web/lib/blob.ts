import { put } from "@vercel/blob";

import { slugify } from "@seo/shared";

import { env } from "./env";

/** Guard against a redirect chain or an oversized asset burning the function. */
const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/**
 * A failure that retrying cannot fix.
 *
 * The distinction matters twice over: the worker treats a 502 as transient and
 * retried a misconfigured Blob store three times, and "502 Bad Gateway" told
 * the reader to suspect the network when the answer was a setting.
 */
export class PermanentIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentIngestError";
  }
}

/**
 * Recognises Blob's refusal to accept a public upload into a private store.
 *
 * A store's access mode is fixed when it is created, so this never resolves on
 * its own — and article images have to be publicly readable, since they are
 * embedded in the body, exported, and published on the client's site. A private
 * blob would need a signed URL that expires, which breaks both.
 */
export function describeBlobFailure(message: string): string | null {
  if (/public access on a private store/i.test(message)) {
    return (
      "The Vercel Blob store is private, and article images have to be " +
      "publicly readable — they are embedded in the article, exported, and " +
      "published on the client's site. A store's access mode is fixed when it " +
      "is created, so this needs a new store created with public access, and " +
      "BLOB_READ_WRITE_TOKEN pointed at it."
    );
  }
  if (/unauthorized|invalid token|forbidden/i.test(message)) {
    return "Vercel Blob rejected the token. Check BLOB_READ_WRITE_TOKEN.";
  }
  return null;
}

export type IngestResult = {
  blobUrl: string;
  pathname: string;
  contentType: string;
  sizeBytes: number;
};

/**
 * Copies a remote image into Blob storage.
 *
 * Magnific hands back a temporary URL, so the bytes have to be persisted before
 * the link expires. The copy happens server-side rather than by the worker
 * uploading a body, because Vercel caps request bodies at 4.5 MB and a 2K PNG
 * clears that comfortably.
 */
export async function ingestRemoteImage(
  sourceUrl: string,
  prefix: string,
  filename: string,
): Promise<IngestResult> {
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch image (${response.status} ${response.statusText}) from ${sourceUrl}`,
    );
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (!contentType?.startsWith("image/")) {
    throw new PermanentIngestError(
      `Refusing to ingest non-image content type: ${contentType}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new PermanentIngestError(`Image exceeds ${MAX_BYTES} bytes`);
  }

  const extension = EXTENSION_BY_TYPE[contentType] ?? "png";
  const safeName = slugify(filename.replace(/\.[a-z0-9]+$/i, "")) || "image";
  const pathname = `${prefix.replace(/^\/+|\/+$/g, "")}/${safeName}.${extension}`;

  const blob = await putOrExplain(pathname, buffer, contentType);

  return {
    blobUrl: blob.url,
    pathname: blob.pathname,
    contentType,
    sizeBytes: buffer.byteLength,
  };
}

async function putOrExplain(
  pathname: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ url: string; pathname: string }> {
  try {
    return await put(pathname, buffer, {
      access: "public",
      contentType,
      token: env.blobToken,
      // Article images are regenerated in place; a stable path keeps editor
      // references valid, and `allowOverwrite` makes the rewrite legal.
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const explanation = describeBlobFailure(message);
    if (explanation) throw new PermanentIngestError(explanation);
    throw error;
  }
}
