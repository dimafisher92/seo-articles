import { eq } from "drizzle-orm";

import {
  articleImages,
  articles,
  planItems,
  type BrandAsset,
} from "@seo/db";
import {
  draftPrompt,
  imagePlanPrompt,
  loadPlaybook,
  metaPrompt,
  outlinePrompt,
  qaPrompt,
  revisePrompt,
  serpIntelPrompt,
  type ArticleBrief,
  type BrandContext,
} from "@seo/playbook";
import {
  countWords,
  imageSpecForRole,
  readingTimeMinutes,
  runSeoChecks,
  slugify,
  truncate,
  TITLE_TAG_MAX,
  META_DESCRIPTION_MAX,
  type ImageMode,
  type ImageProvider,
  buildJsonLd,
  markdownToHtml,
} from "@seo/shared";

import { ingestImage } from "../api.js";
import { RESEARCH_TOOLS, runStageWithRetry } from "../claude.js";
import {
  db,
  loadBrandAssets,
  loadBrandAssetsByIds,
  loadClient,
  toBrandContext,
} from "../data.js";
import { log } from "../log.js";
import { createImageProvider } from "../providers/images.js";
import {
  draftSchema,
  imagePlanSchema,
  metaSchema,
  outlineSchema,
  qaSchema,
  reviseSchema,
  serpIntelSchema,
  type DraftOutput,
  type ImagePlanOutput,
  type MetaOutput,
  type OutlineOutput,
  type QaOutput,
  type ReviseOutput,
  type SerpIntelOutput,
} from "../schemas.js";
import type { StageReporter } from "./types.js";

const TOTAL_STEPS = 8;

export type WriteArticleInput = {
  clientId: string;
  planItemId: string;
  articleId: string;
  imageMode: ImageMode;
  inlineImageCount: number;
};

/**
 * The full article pipeline.
 *
 * Eight discrete stages rather than one long agentic run. Each has a validated
 * output schema, each is separately retryable, and the intermediate artefacts
 * are inspectable afterwards — so a weak draft can be re-run without paying for
 * a fresh SERP crawl, and a QA verdict is auditable rather than buried in a
 * transcript.
 */
export async function runWriteArticle(
  input: WriteArticleInput,
  report: StageReporter,
): Promise<Record<string, unknown>> {
  const loaded = await loadClient(input.clientId);
  const brand = toBrandContext(loaded);
  const playbook = loadPlaybook();

  const [planItem] = await db()
    .select()
    .from(planItems)
    .where(eq(planItems.id, input.planItemId))
    .limit(1);
  if (!planItem) throw new Error(`Plan item ${input.planItemId} not found`);

  const brief: ArticleBrief = {
    title: planItem.title,
    mainKeyword: planItem.mainKeyword,
    secondaryKeywords: planItem.secondaryKeywords,
    intent: planItem.intent,
    pageType: planItem.pageType,
    funnelStage: planItem.funnelStage,
    targetWordCount: planItem.targetWordCount,
    internalLinkTargets: planItem.internalLinkTargets,
    serpNotes: planItem.serpNotes,
  };

  await db()
    .update(planItems)
    .set({ status: "generating" })
    .where(eq(planItems.id, input.planItemId));

  try {
    /* 1 — SERP intelligence ---------------------------------------------- */
    await report(1, TOTAL_STEPS, "Analysing the SERP", planItem.mainKeyword);

    const serpIntel = await runStageWithRetry<SerpIntelOutput>(
      serpIntelPrompt(brand, brief),
      {
        schema: serpIntelSchema,
        label: "serp-intel",
        tools: RESEARCH_TOOLS,
        maxTurns: 45,
        timeoutMs: 20 * 60_000,
      },
    );

    /* 2 — outline --------------------------------------------------------- */
    await report(2, TOTAL_STEPS, "Designing the outline");

    const outline = await runStageWithRetry<OutlineOutput>(
      outlinePrompt(brand, brief, serpIntel, playbook),
      { schema: outlineSchema, label: "outline", maxTurns: 4, timeoutMs: 15 * 60_000 },
    );

    await db()
      .update(articles)
      .set({
        title: outline.title,
        titleTag: truncate(outline.titleTag, TITLE_TAG_MAX),
        outline: outline.sections,
        updatedAt: new Date(),
      })
      .where(eq(articles.id, input.articleId));

    /* 3 — draft ----------------------------------------------------------- */
    await report(
      3,
      TOTAL_STEPS,
      "Writing the draft",
      `${outline.sections.length} sections`,
    );

    const draft = await runStageWithRetry<DraftOutput>(
      draftPrompt(brand, { ...brief, title: outline.title }, outline, serpIntel, playbook),
      { schema: draftSchema, label: "draft", maxTurns: 6, timeoutMs: 25 * 60_000 },
    );

    /* 4 — QA -------------------------------------------------------------- */
    await report(4, TOTAL_STEPS, "Reviewing against the playbook");

    const preChecks = runSeoChecks({
      title: outline.title,
      titleTag: outline.titleTag,
      bodyMdx: draft.bodyMdx,
      mainKeyword: planItem.mainKeyword,
      secondaryKeywords: planItem.secondaryKeywords,
      faqCount: outline.faq.length,
      internalLinkCount: draft.internalLinks.length,
      externalSourceCount: draft.externalSources.length,
      // Images are added after the QA pass; excluded so their checks do not
      // dominate the model's revision instructions.
      imageCount: 3,
      imagesMissingAlt: 0,
      targetWordCount: planItem.targetWordCount,
    });

    const qa = await runStageWithRetry<QaOutput>(
      qaPrompt(
        brand,
        brief,
        draft.bodyMdx,
        preChecks.checks.filter((c) => !c.passed),
        playbook,
      ),
      { schema: qaSchema, label: "qa", maxTurns: 4, timeoutMs: 15 * 60_000 },
    );

    /* 5 — revise ---------------------------------------------------------- */
    let bodyMdx = draft.bodyMdx;
    let appliedFixes: string[] = [];

    if (qa.verdict === "revise" && qa.instructions.length > 0) {
      await report(
        5,
        TOTAL_STEPS,
        "Applying revisions",
        `${qa.instructions.length} instructions`,
      );

      const revised = await runStageWithRetry<ReviseOutput>(
        revisePrompt(brand, draft.bodyMdx, qa.instructions, playbook),
        { schema: reviseSchema, label: "revise", maxTurns: 6, timeoutMs: 25 * 60_000 },
      );
      bodyMdx = revised.bodyMdx;
      appliedFixes = revised.appliedFixes;
    } else {
      await report(5, TOTAL_STEPS, "Draft passed review");
    }

    /* 6 — metadata -------------------------------------------------------- */
    await report(6, TOTAL_STEPS, "Writing metadata and schema");

    const meta = await runStageWithRetry<MetaOutput>(
      metaPrompt(brand, brief, outline.title, bodyMdx),
      { schema: metaSchema, label: "meta", maxTurns: 4, timeoutMs: 10 * 60_000 },
    );

    /* 7 — images ---------------------------------------------------------- */
    await report(7, TOTAL_STEPS, "Planning and generating images");

    const images = await produceImages({
      articleId: input.articleId,
      clientId: input.clientId,
      brand,
      brief: { ...brief, title: outline.title },
      bodyMdx,
      mode: input.imageMode,
      inlineCount: input.inlineImageCount,
      styleReference: loaded.styleReference,
      report,
    });

    /* 8 — assemble -------------------------------------------------------- */
    await report(8, TOTAL_STEPS, "Assembling the article");

    const bodyWithImages = insertImages(bodyMdx, images);
    const wordCount = countWords(bodyWithImages);
    const slug = slugify(meta.slug || outline.title);

    const finalChecks = runSeoChecks({
      title: outline.title,
      titleTag: meta.titleTag,
      metaDescription: meta.metaDescription,
      slug,
      bodyMdx: bodyWithImages,
      mainKeyword: planItem.mainKeyword,
      secondaryKeywords: planItem.secondaryKeywords,
      faqCount: meta.faq.length,
      internalLinkCount: draft.internalLinks.length,
      externalSourceCount: draft.externalSources.length,
      imageCount: images.length,
      imagesMissingAlt: images.filter((i) => !i.altText).length,
      targetWordCount: planItem.targetWordCount,
    });

    const heroUrl = images.find((i) => i.role === "hero")?.blobUrl;

    const jsonLd = buildJsonLd({
      title: outline.title,
      description: meta.metaDescription,
      slug,
      domain: loaded.client.domain,
      author: brand.authorPersona,
      faq: meta.faq,
      ...(heroUrl ? { imageUrl: heroUrl } : {}),
      publisherName: loaded.client.name,
    });

    await db()
      .update(articles)
      .set({
        title: outline.title,
        titleTag: truncate(meta.titleTag, TITLE_TAG_MAX),
        metaDescription: truncate(meta.metaDescription, META_DESCRIPTION_MAX),
        slug,
        mainKeyword: planItem.mainKeyword,
        secondaryKeywords: planItem.secondaryKeywords,
        outline: outline.sections,
        bodyMdx: bodyWithImages,
        bodyHtml: markdownToHtml(bodyWithImages),
        faq: meta.faq,
        jsonLd,
        internalLinks: draft.internalLinks,
        externalSources: draft.externalSources,
        wordCount,
        readingTimeMinutes: readingTimeMinutes(wordCount),
        seoScore: finalChecks,
        qaReport: { issues: qa.issues, appliedFixes },
        status: "draft",
        updatedAt: new Date(),
      })
      .where(eq(articles.id, input.articleId));

    await db()
      .update(planItems)
      .set({ status: "drafted", articleId: input.articleId })
      .where(eq(planItems.id, input.planItemId));

    return {
      wordCount,
      seoScore: finalChecks.total,
      images: images.length,
      failedChecks: finalChecks.checks.filter((c) => !c.passed).map((c) => c.id),
      qaVerdict: qa.verdict,
    };
  } catch (error) {
    await db()
      .update(planItems)
      .set({ status: "failed" })
      .where(eq(planItems.id, input.planItemId));
    throw error;
  }
}

/* -------------------------------------------------------------- images */

type ResolvedImage = {
  id: string;
  role: "hero" | "inline";
  position: number;
  blobUrl: string;
  altText: string;
  caption: string | null;
  placementHeading: string | null;
};

async function produceImages(params: {
  articleId: string;
  clientId: string;
  brand: BrandContext;
  brief: ArticleBrief;
  bodyMdx: string;
  mode: ImageMode;
  inlineCount: number;
  styleReference: BrandAsset | null;
  report: StageReporter;
}): Promise<ResolvedImage[]> {
  const assets = await loadBrandAssets(params.clientId);
  const provider = createImageProvider();

  // With no generator configured, generation is not an option regardless of
  // what the user picked — fall back to whatever the client has uploaded.
  const mode: ImageMode =
    !provider && params.mode !== "brand_assets" ? "brand_assets" : params.mode;

  const plan = await runStageWithRetry<ImagePlanOutput>(
    imagePlanPrompt(
      params.brand,
      params.brief,
      params.bodyMdx,
      params.inlineCount,
      assets.map((a) => ({
        id: a.id,
        category: a.category,
        altText: a.altText,
        tags: a.tags,
      })),
      mode,
    ),
    { schema: imagePlanSchema, label: "image-plan", maxTurns: 4, timeoutMs: 10 * 60_000 },
  );

  await db().delete(articleImages).where(eq(articleImages.articleId, params.articleId));

  const assetIds = plan.images
    .map((i) => i.brandAssetId)
    .filter((id): id is string => Boolean(id));
  const assetsById = await loadBrandAssetsByIds(assetIds);

  const resolved: ResolvedImage[] = [];
  const ordered = plan.images.sort((a, b) =>
    a.role === b.role ? a.position - b.position : a.role === "hero" ? -1 : 1,
  );

  for (const [index, spec] of ordered.entries()) {
    await params.report(
      7,
      TOTAL_STEPS,
      "Generating images",
      `${index + 1}/${ordered.length}`,
    );

    const [row] = await db()
      .insert(articleImages)
      .values({
        articleId: params.articleId,
        role: spec.role,
        position: spec.position,
        source: spec.source,
        status: "generating",
        brandAssetId: spec.brandAssetId ?? null,
        prompt: spec.prompt ?? null,
        placementHeading: spec.placementHeading ?? null,
        altText: spec.altText,
        caption: spec.caption ?? null,
      })
      .returning();
    if (!row) continue;

    try {
      const blobUrl =
        spec.source === "brand_asset"
          ? assetsById.get(spec.brandAssetId ?? "")?.blobUrl
          : await generateAndStore({
              provider,
              articleId: params.articleId,
              clientId: params.clientId,
              role: spec.role,
              prompt: spec.prompt ?? "",
              filename: spec.filename,
              styleReferenceUrl: params.styleReference?.blobUrl,
              imageId: row.id,
            });

      if (!blobUrl) {
        throw new Error(
          spec.source === "brand_asset"
            ? `Brand asset ${spec.brandAssetId} not found`
            : "No image URL produced",
        );
      }

      await db()
        .update(articleImages)
        .set({ blobUrl, status: "ready", error: null })
        .where(eq(articleImages.id, row.id));

      resolved.push({
        id: row.id,
        role: spec.role,
        position: spec.position,
        blobUrl,
        altText: spec.altText,
        caption: spec.caption ?? null,
        placementHeading: spec.placementHeading ?? null,
      });
    } catch (error) {
      // One failed image should not lose a finished article — the editor lets a
      // human regenerate or replace it afterwards.
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Image ${row.id} failed: ${message}`);
      await db()
        .update(articleImages)
        .set({ status: "failed", error: message })
        .where(eq(articleImages.id, row.id));
    }
  }

  return resolved;
}

async function generateAndStore(params: {
  provider: ImageProvider | null;
  articleId: string;
  clientId: string;
  role: "hero" | "inline";
  prompt: string;
  filename: string;
  styleReferenceUrl: string | undefined;
  imageId: string;
}): Promise<string> {
  if (!params.provider) throw new Error("No image provider configured");
  if (!params.prompt) throw new Error("No prompt supplied for a generated image");

  const spec = imageSpecForRole(params.role);
  const generated = await params.provider.generate({
    prompt: params.prompt,
    aspectRatio: spec.aspectRatio,
    resolution: spec.resolution,
    ...(params.styleReferenceUrl
      ? { styleReferenceUrl: params.styleReferenceUrl, styleStrength: 0.5 }
      : {}),
  });

  await db()
    .update(articleImages)
    .set({
      magnificTaskId: generated.taskId,
      aspectRatio: spec.aspectRatio,
    })
    .where(eq(articleImages.id, params.imageId));

  // The provider URL expires, so persist the bytes before returning.
  const stored = await ingestImage({
    sourceUrl: generated.url,
    clientId: params.clientId,
    prefix: `articles/${params.articleId}`,
    filename: params.filename,
  });

  return stored.blobUrl;
}

/**
 * Places images into the Markdown: the hero straight after the H1, each inline
 * image immediately before the heading it was planned for. Anything whose
 * heading cannot be matched is appended rather than dropped.
 */
function insertImages(bodyMdx: string, images: ResolvedImage[]): string {
  if (images.length === 0) return bodyMdx;

  const render = (image: ResolvedImage): string => {
    const alt = image.altText.replace(/[[\]]/g, "");
    const figure = `![${alt}](${image.blobUrl})`;
    return image.caption ? `${figure}\n*${image.caption}*` : figure;
  };

  const lines = bodyMdx.split("\n");
  const out: string[] = [];
  const placed = new Set<string>();

  const hero = images.find((i) => i.role === "hero");
  const inline = images.filter((i) => i.role !== "hero");

  let heroPlaced = false;

  for (const line of lines) {
    const headingMatch = /^(#{2,3})\s+(.*\S)\s*$/.exec(line);
    if (headingMatch?.[2]) {
      const heading = headingMatch[2].trim().toLowerCase();
      for (const image of inline) {
        if (placed.has(image.id)) continue;
        if (image.placementHeading?.trim().toLowerCase() === heading) {
          out.push(render(image), "");
          placed.add(image.id);
        }
      }
    }

    out.push(line);

    if (!heroPlaced && hero && /^#\s+/.test(line)) {
      out.push("", render(hero));
      placed.add(hero.id);
      heroPlaced = true;
    }
  }

  // Hero with no H1 to anchor to, or inline images whose heading was renamed
  // during revision: keep them rather than silently losing paid-for renders.
  const orphans = images.filter((i) => !placed.has(i.id));
  if (orphans.length > 0) {
    if (hero && !heroPlaced) {
      out.unshift(render(hero), "");
      placed.add(hero.id);
    }
    for (const image of orphans) {
      if (placed.has(image.id)) continue;
      out.push("", render(image));
    }
  }

  return out.join("\n");
}
