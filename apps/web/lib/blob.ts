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
    throw new Error(`Refusing to ingest non-image content type: ${contentType}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`Image exceeds ${MAX_BYTES} bytes`);
  }

  const extension = EXTENSION_BY_TYPE[contentType] ?? "png";
  const safeName = slugify(filename.replace(/\.[a-z0-9]+$/i, "")) || "image";
  const pathname = `${prefix.replace(/^\/+|\/+$/g, "")}/${safeName}.${extension}`;

  const blob = await put(pathname, buffer, {
    access: "public",
    contentType,
    token: env.blobToken,
    // Article images are regenerated in place; a stable path keeps editor
    // references valid, and `allowOverwrite` makes the rewrite legal.
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return {
    blobUrl: blob.url,
    pathname: blob.pathname,
    contentType,
    sizeBytes: buffer.byteLength,
  };
}
