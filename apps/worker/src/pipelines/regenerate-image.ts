import { eq } from "drizzle-orm";

import { articleImages, articles } from "@seo/db";
import {
  imageRequestFor,
  markdownToHtml,
  reconcileImages,
  type PlacedImage,
} from "@seo/shared";

import { ingestImage } from "../api.js";
import { db, loadClient } from "../data.js";
import { createImageProvider } from "../providers/images.js";
import type { StageReporter } from "./types.js";

export type RegenerateImageInput = {
  clientId: string;
  articleId: string;
  imageId: string;
  prompt?: string;
};

/**
 * Re-renders one image from the editor, optionally against a new prompt.
 *
 * The replacement is written to the same Blob path, so the Markdown body and
 * the editor's `<img src>` keep working without a rewrite.
 */
export async function runRegenerateImage(
  input: RegenerateImageInput,
  report: StageReporter,
): Promise<Record<string, unknown>> {
  const provider = createImageProvider();
  if (!provider) {
    throw new Error(
      "MAGNIFIC_API_KEY is not set on the worker, so images cannot be generated.",
    );
  }

  const [image] = await db()
    .select()
    .from(articleImages)
    .where(eq(articleImages.id, input.imageId))
    .limit(1);
  if (!image) throw new Error(`Image ${input.imageId} not found`);

  const prompt = input.prompt ?? image.prompt;
  if (!prompt) {
    throw new Error("This image has no prompt to regenerate from");
  }

  const loaded = await loadClient(input.clientId);

  // Same rules as first generation, from the same function. A row written
  // before the distinction existed has no kind; a photograph is the safer
  // reading, since the diagram rules would forbid text a photo never has.
  const request = imageRequestFor({
    role: image.role,
    kind: image.kind ?? "photo",
    prompt,
  });

  await report(1, 2, "Generating the image");

  await db()
    .update(articleImages)
    .set({ status: "generating", prompt, error: null })
    .where(eq(articleImages.id, image.id));

  const generated = await provider.generate({
    ...request,
    ...(loaded.styleReference
      ? { styleReferenceUrl: loaded.styleReference.blobUrl, styleStrength: 0.5 }
      : {}),
  });

  await report(2, 2, "Storing the image");

  const filename =
    image.blobUrl?.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") ??
    `image-${image.position}`;

  const stored = await ingestImage({
    sourceUrl: generated.url,
    clientId: input.clientId,
    prefix: `articles/${input.articleId}`,
    filename,
  });

  await db()
    .update(articleImages)
    .set({
      blobUrl: stored.blobUrl,
      magnificTaskId: generated.taskId,
      status: "ready",
      source: "generated",
      aspectRatio: request.aspectRatio,
      error: null,
    })
    .where(eq(articleImages.id, image.id));

  /**
   * Make the body agree with the images that now exist.
   *
   * This used to substitute the old URL for the new one, which quietly did
   * nothing in the two cases that matter. When the previous generation failed
   * the row had no URL to substitute, so a successful regeneration never
   * reached the body. And when a Blob store was replaced, the body held URLs
   * from a store that no longer existed — matching nothing, and rendering as
   * broken images with the alt text showing.
   *
   * Reconciling against the table covers both: dead references go, live images
   * are placed, and an image already in the right place is left alone.
   */
  const [article] = await db()
    .select({ bodyMdx: articles.bodyMdx })
    .from(articles)
    .where(eq(articles.id, input.articleId))
    .limit(1);

  if (article?.bodyMdx) {
    const live = await db()
      .select()
      .from(articleImages)
      .where(eq(articleImages.articleId, input.articleId));

    const placed: PlacedImage[] = live
      .filter((row) => row.status === "ready" && row.blobUrl)
      .map((row) => ({
        id: row.id,
        role: row.role,
        position: row.position,
        blobUrl: row.blobUrl!,
        // Alt text is required in the body; a row without it still gets
        // placed, since a missing picture is worse than a missing description.
        altText: row.altText ?? "",
        caption: row.caption,
        placementHeading: row.placementHeading,
      }));

    const bodyMdx = reconcileImages(article.bodyMdx, placed);

    if (bodyMdx !== article.bodyMdx) {
      await db()
        .update(articles)
        .set({
          bodyMdx,
          bodyHtml: markdownToHtml(bodyMdx),
          updatedAt: new Date(),
        })
        .where(eq(articles.id, input.articleId));
    }
  }

  return { blobUrl: stored.blobUrl, taskId: generated.taskId };
}
