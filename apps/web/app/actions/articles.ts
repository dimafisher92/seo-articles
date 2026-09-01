"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import {
  articleImages,
  articles,
  planItems,
  type Article,
  type ArticleImage,
  type PlanItem,
} from "@seo/db";
import {
  countWords,
  markdownToHtml,
  readingTimeMinutes,
  runSeoChecks,
  stripFrontMatter,
  type ImageMode,
} from "@seo/shared";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/queue";

import type { ActionResult } from "./clients";

async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * An article plus whether its plan row is mid-generation.
 *
 * The list needs that second thing to know if a regenerate button should be
 * live, and it is not on the article: an article keeps its previous text and
 * status for the whole of a re-run.
 */
export type ArticleListing = Article & {
  planStatus: PlanItem["status"] | null;
};

export async function listArticles(
  clientId: string,
): Promise<ArticleListing[]> {
  await requireUser();
  const rows = await db()
    .select({ article: articles, planStatus: planItems.status })
    .from(articles)
    .leftJoin(planItems, eq(planItems.id, articles.planItemId))
    .where(eq(articles.clientId, clientId))
    .orderBy(desc(articles.updatedAt));

  return rows.map((row) => ({ ...row.article, planStatus: row.planStatus }));
}

/** The plan row's status for one article, for the same reason. */
export async function getArticlePlanStatus(
  articleId: string,
): Promise<PlanItem["status"] | null> {
  await requireUser();
  const [row] = await db()
    .select({ status: planItems.status })
    .from(articles)
    .leftJoin(planItems, eq(planItems.id, articles.planItemId))
    .where(eq(articles.id, articleId))
    .limit(1);
  return row?.status ?? null;
}

export async function getArticle(id: string): Promise<Article | null> {
  await requireUser();
  const [article] = await db()
    .select()
    .from(articles)
    .where(eq(articles.id, id))
    .limit(1);
  return article ?? null;
}

export async function listArticleImages(
  articleId: string,
): Promise<ArticleImage[]> {
  await requireUser();
  return db()
    .select()
    .from(articleImages)
    .where(eq(articleImages.articleId, articleId))
    .orderBy(articleImages.position);
}

type CommissionOptions = { imageMode?: ImageMode; inlineImageCount?: number };

/**
 * Queues the write job for a plan row, creating the article the first time.
 *
 * Shared by the plan table and by the article screens, because a regeneration
 * has to be the same operation as the first run — a second implementation is a
 * second set of defaults for image mode and count, and they would drift.
 */
async function commission(
  planItemId: string,
  options: CommissionOptions,
): Promise<{ articleId: string; jobId: string }> {
  const [item] = await db()
    .select()
    .from(planItems)
    .where(eq(planItems.id, planItemId))
    .limit(1);
  if (!item) throw new Error("Plan item not found");

  let articleId = item.articleId;
  if (!articleId) {
    const [created] = await db()
      .insert(articles)
      .values({
        planItemId: item.id,
        clientId: item.clientId,
        title: item.title,
        mainKeyword: item.mainKeyword,
        secondaryKeywords: item.secondaryKeywords,
      })
      .returning({ id: articles.id });
    if (!created) throw new Error("Could not create the article");
    articleId = created.id;

    await db()
      .update(planItems)
      .set({ articleId })
      .where(eq(planItems.id, item.id));
  }

  const job = await enqueue({
    type: "write_article",
    clientId: item.clientId,
    payload: {
      clientId: item.clientId,
      planItemId: item.id,
      articleId,
      imageMode: options.imageMode ?? "mixed",
      inlineImageCount: options.inlineImageCount ?? 3,
    },
  });

  await db()
    .update(planItems)
    .set({ status: "queued" })
    .where(eq(planItems.id, item.id));

  revalidatePath(`/clients/${item.clientId}/plan`);
  revalidatePath(`/clients/${item.clientId}/articles`);
  revalidatePath(`/clients/${item.clientId}/articles/${articleId}`);

  return { articleId, jobId: job.id };
}

/**
 * Commissions one article from a plan row — the per-title button.
 *
 * Re-running against a plan item that already has an article reuses the same
 * article row, so the URL a strategist bookmarked keeps working and the edit
 * history stays in one place.
 */
export async function writeArticle(
  planItemId: string,
  options: CommissionOptions = {},
): Promise<ActionResult<{ articleId: string; jobId: string }>> {
  return guard(async () => {
    await requireUser();
    return commission(planItemId, options);
  });
}

/**
 * The same thing, addressed by article rather than by plan row.
 *
 * The plan is not where a failure is read. A writer opens the article, sees
 * "Stage draft failed" on it, and needs to re-run it from there — routing that
 * through the article's own id is the difference between a button that exists
 * and a button that is found.
 */
export async function regenerateArticle(
  articleId: string,
  options: CommissionOptions = {},
): Promise<ActionResult<{ articleId: string; jobId: string }>> {
  return guard(async () => {
    await requireUser();

    const [article] = await db()
      .select({ planItemId: articles.planItemId })
      .from(articles)
      .where(eq(articles.id, articleId))
      .limit(1);
    if (!article) throw new Error("Article not found");

    // Every article the pipeline makes comes from a plan row, and the brief
    // lives there. An article without one cannot be rewritten, and saying so
    // beats a job that fails ten minutes later.
    if (!article.planItemId) {
      throw new Error(
        "This article is not linked to a plan item, so it cannot be regenerated",
      );
    }

    return commission(article.planItemId, options);
  });
}

/**
 * Saves an edited article.
 *
 * The SEO score is recomputed here from the same rubric the worker used, so a
 * human edit that breaks a check shows up immediately rather than at the next
 * generation.
 */
export async function saveArticle(
  id: string,
  input: {
    title?: string;
    titleTag?: string;
    metaDescription?: string;
    slug?: string;
    bodyMdx?: string;
  },
): Promise<ActionResult<{ seoScore: number }>> {
  return guard(async () => {
    await requireUser();

    const [existing] = await db()
      .select()
      .from(articles)
      .where(eq(articles.id, id))
      .limit(1);
    if (!existing) throw new Error("Article not found");

    // A body arriving with YAML front matter is a draft-stage slip, not
    // something a writer meant to keep; it renders as prose above the H1 and
    // drags the opening-sentence check with it.
    const bodyMdx = stripFrontMatter(input.bodyMdx ?? existing.bodyMdx ?? "");
    const images = await listArticleImages(id);

    const merged = {
      title: input.title ?? existing.title,
      titleTag: input.titleTag ?? existing.titleTag,
      metaDescription: input.metaDescription ?? existing.metaDescription,
      slug: input.slug ?? existing.slug,
    };

    const seoScore = runSeoChecks({
      ...merged,
      bodyMdx,
      mainKeyword: existing.mainKeyword,
      secondaryKeywords: existing.secondaryKeywords,
      faqCount: existing.faq.length,
      internalLinkCount: existing.internalLinks.length,
      externalSourceCount: existing.externalSources.length,
      imageCount: images.filter((i) => i.status === "ready").length,
      imagesMissingAlt: images.filter((i) => !i.altText).length,
      targetWordCount: null,
    });

    const wordCount = countWords(bodyMdx);

    await db()
      .update(articles)
      .set({
        ...merged,
        bodyMdx,
        bodyHtml: markdownToHtml(bodyMdx),
        wordCount,
        readingTimeMinutes: readingTimeMinutes(wordCount),
        seoScore,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(articles.id, id));

    revalidatePath(`/clients/${existing.clientId}/articles/${id}`);
    return { seoScore: seoScore.total };
  });
}

export async function setArticleStatus(
  id: string,
  status: "draft" | "approved" | "exported",
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();

    const [article] = await db()
      .update(articles)
      .set({ status, updatedAt: new Date() })
      .where(eq(articles.id, id))
      .returning({ clientId: articles.clientId, planItemId: articles.planItemId });

    if (article?.planItemId) {
      await db()
        .update(planItems)
        .set({ status: status === "draft" ? "drafted" : status })
        .where(eq(planItems.id, article.planItemId));
    }

    if (article) revalidatePath(`/clients/${article.clientId}/articles/${id}`);
  });
}

export async function regenerateImage(
  imageId: string,
  prompt?: string,
): Promise<ActionResult<{ jobId: string }>> {
  return guard(async () => {
    await requireUser();

    const [image] = await db()
      .select()
      .from(articleImages)
      .where(eq(articleImages.id, imageId))
      .limit(1);
    if (!image) throw new Error("Image not found");

    const [article] = await db()
      .select({ clientId: articles.clientId })
      .from(articles)
      .where(eq(articles.id, image.articleId))
      .limit(1);
    if (!article) throw new Error("Article not found");

    const job = await enqueue({
      type: "regenerate_image",
      clientId: article.clientId,
      payload: {
        clientId: article.clientId,
        articleId: image.articleId,
        imageId,
        ...(prompt ? { prompt } : {}),
      },
    });

    revalidatePath(`/clients/${article.clientId}/articles/${image.articleId}`);
    return { jobId: job.id };
  });
}

/** Swaps a generated image for one from the Brand Vault. */
export async function useBrandAssetForImage(
  imageId: string,
  brandAssetId: string,
  blobUrl: string,
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();

    const [image] = await db()
      .select()
      .from(articleImages)
      .where(eq(articleImages.id, imageId))
      .limit(1);
    if (!image) throw new Error("Image not found");

    await db()
      .update(articleImages)
      .set({
        source: "brand_asset",
        brandAssetId,
        blobUrl,
        status: "ready",
        error: null,
      })
      .where(eq(articleImages.id, imageId));

    // Keep the body in step with the swap so the editor and export agree.
    if (image.blobUrl) {
      const [article] = await db()
        .select()
        .from(articles)
        .where(eq(articles.id, image.articleId))
        .limit(1);

      if (article?.bodyMdx) {
        const bodyMdx = article.bodyMdx.split(image.blobUrl).join(blobUrl);
        await db()
          .update(articles)
          .set({
            bodyMdx,
            bodyHtml: markdownToHtml(bodyMdx),
            updatedAt: new Date(),
          })
          .where(eq(articles.id, article.id));
      }
    }

    revalidatePath(`/clients/${image.articleId}`);
  });
}
