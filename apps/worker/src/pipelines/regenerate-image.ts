import { eq } from "drizzle-orm";

import { articleImages, articles } from "@seo/db";
import { imageSpecForRole, markdownToHtml } from "@seo/shared";

import { ingestImage } from "../api.js";
import { db, loadClient } from "../data.js";
import { createImageProvider } from "../providers/magnific.js";
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
  const spec = imageSpecForRole(image.role);

  await report(1, 2, "Generating the image");

  await db()
    .update(articleImages)
    .set({ status: "generating", prompt, error: null })
    .where(eq(articleImages.id, image.id));

  const generated = await provider.generate({
    prompt,
    aspectRatio: spec.aspectRatio,
    resolution: spec.resolution,
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
      aspectRatio: spec.aspectRatio,
      error: null,
    })
    .where(eq(articleImages.id, image.id));

  // A new Blob URL means the body's image reference has to follow it.
  if (image.blobUrl && image.blobUrl !== stored.blobUrl) {
    const [article] = await db()
      .select({ bodyMdx: articles.bodyMdx })
      .from(articles)
      .where(eq(articles.id, input.articleId))
      .limit(1);

    if (article?.bodyMdx) {
      const bodyMdx = article.bodyMdx.split(image.blobUrl).join(stored.blobUrl);
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
