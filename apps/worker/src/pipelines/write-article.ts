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
  type SerpFacts,
} from "@seo/playbook";
import {
  countWords,
  findImagePromptRisks,
  imageRequestFor,
  readingTimeMinutes,
  runSeoChecks,
  gateDraft,
  checksReadyForReview,
  statusAfterReview,
  type QaIssue,
  slugify,
  truncate,
  TITLE_TAG_MAX,
  META_DESCRIPTION_MAX,
  type ImageKind,
  type ImageMode,
  type ImageProvider,
  buildJsonLd,
  markdownToHtml,
  reconcileImages,
  stripAuthoredHtml,
  stripBeforeH1,
  stripFrontMatter,
  type PlacedImage,
} from "@seo/shared";

import { ingestImage } from "../api.js";
import { RESEARCH_TOOLS, runStageWithRetry } from "../claude.js";
import { stageModels } from "../config.js";
import {
  db,
  loadBrandAssets,
  loadBrandAssetsByIds,
  loadClient,
  toBrandContext,
} from "../data.js";
import { log } from "../log.js";
import { createImageProvider } from "../providers/images.js";
import { createKeywordProvider } from "../providers/keywords.js";
import { createTimer, type Timer } from "../timings.js";
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

/** Everything a stage may not put in the body, removed in one place. */
function cleanBody(bodyMdx: string): string {
  return stripBeforeH1(stripAuthoredHtml(stripFrontMatter(bodyMdx)));
}

/**
 * The top of the results page, when the rank tracker can tell us.
 *
 * Never fatal. A provider that is not configured, has no data for this keyword,
 * or simply errors means the SERP stage falls back to crawling the web itself —
 * slower, but the article still gets written. Returning null rather than
 * throwing is what makes that fallback automatic.
 */
async function fetchSerpFacts(
  keyword: string,
  country: string,
): Promise<SerpFacts | null> {
  const provider = createKeywordProvider();
  if (!provider) return null;

  try {
    const serp = await provider.getSerp(keyword, { country });
    if (serp.results.length === 0) {
      // An empty answer, not a refused one — those now throw, and are reported
      // below with the server's own words. Saying the same sentence for both
      // is what let a rejected `mode` argument masquerade as an account with
      // no data for three rounds.
      log.warn(
        `${provider.name} has no SERP for "${keyword}" — ` +
          "the SERP stage will read the web itself instead",
      );
      return null;
    }

    return {
      results: serp.results.slice(0, 10).map((entry) => ({
        position: entry.position,
        url: entry.url,
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        ...(entry.snippet !== undefined ? { snippet: entry.snippet } : {}),
      })),
      peopleAlsoAsk: serp.peopleAlsoAsk,
      relatedSearches: serp.relatedSearches,
    };
  } catch (error) {
    log.warn(
      `SERP lookup failed for "${keyword}": ` +
        `${error instanceof Error ? error.message : String(error)} — ` +
        "falling back to reading the web",
    );
    return null;
  }
}

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

  const timer = createTimer();

  try {
    /* 1 — SERP intelligence ---------------------------------------------- */
    await report(1, TOTAL_STEPS, "Analysing the SERP", planItem.mainKeyword);

    // The rank tracker already knows what is on this results page, and we pay
    // for it. Fetching it turns the slowest stage in the pipeline from a crawl
    // of ten pages into one pass of judgement over data already in hand.
    const serpFacts = await timer.measure("serp-fetch", () =>
      fetchSerpFacts(planItem.mainKeyword, brand.country),
    );

    const serpIntel = await timer.measure("serp-intel", () =>
      runStageWithRetry<SerpIntelOutput>(
        serpIntelPrompt(brand, brief, serpFacts),
        serpFacts
          ? {
              schema: serpIntelSchema,
              label: "serp-intel",
              model: stageModels.serpIntel,
              // No tools at all. Every turn this stage used to spend was a
              // page fetch; with the results in the prompt there is nothing
              // left to fetch.
              maxTurns: 3,
              timeoutMs: 10 * 60_000,
            }
          : {
              schema: serpIntelSchema,
              label: "serp-intel",
              model: stageModels.serpIntel,
              tools: RESEARCH_TOOLS,
              maxTurns: 45,
              timeoutMs: 20 * 60_000,
            },
      ),
    );

    /* 2 — outline --------------------------------------------------------- */
    await report(2, TOTAL_STEPS, "Designing the outline");

    const outline = await timer.measure("outline", () =>
      runStageWithRetry<OutlineOutput>(
        outlinePrompt(brand, brief, serpIntel, playbook),
        {
          schema: outlineSchema,
          label: "outline",
          model: stageModels.outline,
          maxTurns: 4,
          timeoutMs: 15 * 60_000,
        },
      ),
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

    /* 3 — draft, with the images being made alongside it ------------------ */

    /**
     * Images are planned from the outline and rendered while the article is
     * written and reviewed.
     *
     * They used to run last, and they are the one part of the pipeline whose
     * time is not ours: three or four renders at 30-60 seconds each, plus
     * polling, spent watching Magnific work. The outline is settled by now and
     * the revise stage is told to preserve the heading structure, so the
     * placement anchors this plans against still exist at the end — and
     * `reconcileImages` handles the one that does not.
     *
     * Deliberately not awaited here. The catch is attached immediately so a
     * failure cannot surface as an unhandled rejection while the draft runs.
     */
    const imagesInFlight = timer
      .measure("images", () =>
        produceImages({
          articleId: input.articleId,
          clientId: input.clientId,
          brand,
          brief: { ...brief, title: outline.title },
          outline,
          mode: input.imageMode,
          inlineCount: input.inlineImageCount,
          styleReference: loaded.styleReference,
          playbook,
        }),
      )
      .catch((error: unknown) => {
        // One failed picture never loses a finished article; neither does the
        // whole image stage failing.
        log.warn(
          `Images failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [] as PlacedImage[];
      });

    await report(
      3,
      TOTAL_STEPS,
      "Writing the draft",
      `${outline.sections.length} sections`,
    );

    const draft = await timer.measure("draft", () =>
      runStageWithRetry<DraftOutput>(
        draftPrompt(brand, { ...brief, title: outline.title }, outline, serpIntel, playbook),
        {
          schema: draftSchema,
          label: "draft",
          model: stageModels.draft,
          // The SDK spends a turn on every rejected structured-output attempt,
          // and its own retry budget is five. At six turns the stage ran out of
          // room for a single malformed response and died on an expensive draft.
          maxTurns: 12,
          timeoutMs: 25 * 60_000,
        },
      ),
    );

    /* 4-5 — review and revise, until it is actually clean ----------------- */

    /**
     * The loop this replaces asked the model whether to revise and believed
     * the answer. One article came back with six findings marked `high` —
     * invented fee percentages, claims about the client's own contract,
     * unsourced attacks on competitors — a verdict of "ship", and was
     * published verbatim. Nothing re-checked the result of a revision either,
     * so even a revised draft shipped unverified.
     *
     * Three passes: enough for a draft with real problems to converge, few
     * enough that a hopeless one does not burn tokens indefinitely.
     */
    const MAX_REVIEW_PASSES = 3;

    // Two things the prompt forbids and a draft delivered anyway: YAML front
    // matter above the H1, and a whole HTML apparatus — `<img>` tags at
    // invented paths, an on-page-mechanics comment, a JSON-LD `<script>`. Each
    // is something a later stage produces for real, so it is dropped here,
    // before anything measures or renders it.
    let bodyMdx = cleanBody(draft.bodyMdx);
    let appliedFixes: string[] = [];
    let issues: QaIssue[] = [];
    let blocking: QaIssue[] = [];
    let previousProblems = Number.POSITIVE_INFINITY;

    for (let pass = 1; pass <= MAX_REVIEW_PASSES; pass++) {
      await report(
        4,
        TOTAL_STEPS,
        "Reviewing against the playbook",
        `pass ${pass} of ${MAX_REVIEW_PASSES}`,
      );

      const checks = runSeoChecks({
        title: outline.title,
        titleTag: outline.titleTag,
        bodyMdx,
        mainKeyword: planItem.mainKeyword,
        secondaryKeywords: planItem.secondaryKeywords,
        faqCount: outline.faq.length,
        internalLinkCount: draft.internalLinks.length,
        externalSourceCount: draft.externalSources.length,
        imageCount: 0,
        imagesMissingAlt: 0,
        targetWordCount: planItem.targetWordCount,
      });

      // Only what the review can actually fix. The metadata stage has not run
      // yet, so its checks fail here by construction — and handing the review
      // "no meta description, no slug" is what taught it to write metadata
      // into the body.
      const failed = checks.checks.filter(
        (check) =>
          !check.passed &&
          checksReadyForReview([check.id]).length > 0,
      );

      const qa = await timer.measure("qa", () =>
        runStageWithRetry<QaOutput>(
          qaPrompt(brand, brief, bodyMdx, failed, playbook),
          {
            schema: qaSchema,
            label: `qa-${pass}`,
            model: stageModels.qa,
            maxTurns: 4,
            timeoutMs: 15 * 60_000,
          },
        ),
      );

      issues = qa.issues;

      const gate = gateDraft({
        verdict: qa.verdict,
        issues: qa.issues,
        failedCheckIds: failed.map((check) => check.id),
      });
      blocking = gate.blocking;

      if (!gate.mustRevise) {
        log.info(`Review pass ${pass}: clean`);
        break;
      }

      log.info(`Review pass ${pass}: ${gate.reason}`);

      // 7 findings then 4 is progress worth another pass; 4 then 4 is a pass
      // spent rewriting an article the review will object to identically. The
      // run that hit the deadline was on its third revision of a draft that
      // had stopped improving.
      if (pass > 1 && gate.problemCount >= previousProblems) {
        log.warn(
          `Review is no longer converging (${previousProblems} → ${gate.problemCount} ` +
            "outstanding); stopping rather than spending another pass",
        );
        break;
      }
      previousProblems = gate.problemCount;

      if (pass === MAX_REVIEW_PASSES) {
        // Out of passes. The article is kept in full — status says what it is.
        log.warn(
          `Still not clean after ${MAX_REVIEW_PASSES} passes: ${gate.reason}`,
        );
        break;
      }

      if (qa.instructions.length === 0) {
        log.warn("Review demanded a revision but gave no instructions");
        break;
      }

      await report(
        5,
        TOTAL_STEPS,
        "Applying revisions",
        `${qa.instructions.length} instructions, pass ${pass}`,
      );

      /**
       * A revision that fails is a revision that did not happen — not a lost
       * article.
       *
       * It used to throw out of this loop and kill the job. One run lost a
       * finished draft and four already-rendered, already-paid-for images
       * because `revise-1` came back `error_max_turns` twelve seconds in.
       * Everything needed to ship was in hand: the draft, and a review saying
       * what was wrong with it — which is what `needs_attention` is for. The
       * loop already leaves this way when the review demands a revision
       * without giving instructions.
       */
      let revised: ReviseOutput;
      try {
        revised = await timer.measure("revise", () =>
          runStageWithRetry<ReviseOutput>(
            revisePrompt(brand, bodyMdx, qa.instructions, playbook),
            {
              schema: reviseSchema,
              label: `revise-${pass}`,
              model: stageModels.revise,
              maxTurns: 12,
              timeoutMs: 25 * 60_000,
            },
          ),
        );
      } catch (error) {
        log.warn(
          `Revision pass ${pass} failed, keeping the draft as it stands: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }

      bodyMdx = cleanBody(revised.bodyMdx);
      appliedFixes = [...appliedFixes, ...revised.appliedFixes];
    }

    /* 6-7 — metadata, and whatever the image renders still owe us --------- */
    await report(6, TOTAL_STEPS, "Writing metadata and schema");

    // Metadata depends only on the finished body, and the images depend on
    // nothing that is still running. Waiting for one and then the other was
    // wall-clock given away for free.
    const [meta, images] = await Promise.all([
      timer.measure("meta", () =>
        runStageWithRetry<MetaOutput>(
          metaPrompt(brand, brief, outline.title, bodyMdx),
          {
            schema: metaSchema,
            label: "meta",
            model: stageModels.meta,
            maxTurns: 4,
            timeoutMs: 10 * 60_000,
          },
        ),
      ),
      imagesInFlight,
    ]);

    await report(7, TOTAL_STEPS, "Images ready", `${images.length}`);

    /* 8 — assemble -------------------------------------------------------- */
    await report(8, TOTAL_STEPS, "Assembling the article");

    // Reconcile rather than only place: a draft that invents `![alt](url)` as
    // well would otherwise ship a Markdown image pointing nowhere. This is the
    // same operation regeneration performs, which is why it is shared.
    const bodyWithImages = reconcileImages(bodyMdx, images);
    const wordCount = countWords(bodyWithImages);
    const slug = slugify(meta.slug || outline.title);

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
      // Built just above; checked rather than assumed, because it is stored
      // whatever it contains and nothing else looks at it.
      schemaTypes: jsonLd.map((block) => (block as { "@type": string })["@type"]),
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
        qaReport: { issues, appliedFixes },
        status: statusAfterReview(blocking),
        updatedAt: new Date(),
      })
      .where(eq(articles.id, input.articleId));

    await db()
      .update(planItems)
      .set({ status: "drafted", articleId: input.articleId })
      .where(eq(planItems.id, input.planItemId));

    const timings = timer.summary();
    log.info(
      `Timings (s): ${Object.entries(timings)
        .map(([stage, seconds]) => `${stage} ${seconds}`)
        .join(" · ")}`,
    );

    return {
      wordCount,
      seoScore: finalChecks.total,
      // Seconds per stage, stored with the job. Overlapping stages make the
      // parts add up to more than `total` — that difference is the saving.
      timings,
      images: images.length,
      failedChecks: finalChecks.checks.filter((c) => !c.passed).map((c) => c.id),
      // What the review still objects to, if anything — the job result is
      // where a caller looks to know whether the article needs reading.
      blockingIssues: blocking.length,
      status: statusAfterReview(blocking),
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

/**
 * The outline as the image plan needs to see it: the H1, then each heading with
 * what it is meant to cover. Enough to choose a subject and an anchor, without
 * waiting for prose that does not change either.
 */
function outlineForImages(outline: OutlineOutput): string {
  const sections = outline.sections
    .map((section) => {
      const heading = "#".repeat(section.level ?? 2) + ` ${section.heading}`;
      return section.intent ? `${heading}\n${section.intent}` : heading;
    })
    .join("\n\n");

  return `# ${outline.title}\n\n${sections}`;
}

async function produceImages(params: {
  articleId: string;
  clientId: string;
  brand: BrandContext;
  brief: ArticleBrief;
  /**
   * The outline, not the finished body.
   *
   * Planning from the outline is what lets rendering start before the article
   * is written. The plan needs headings to anchor an image to and a sense of
   * what each section covers, and the outline has both — a finished draft adds
   * prose the image plan was never reading anyway.
   */
  outline: OutlineOutput;
  mode: ImageMode;
  inlineCount: number;
  styleReference: BrandAsset | null;
  playbook: string;
}): Promise<PlacedImage[]> {
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
      outlineForImages(params.outline),
      params.inlineCount,
      assets.map((a) => ({
        id: a.id,
        category: a.category,
        altText: a.altText,
        tags: a.tags,
      })),
      mode,
      params.playbook,
    ),
    {
      schema: imagePlanSchema,
      label: "image-plan",
      model: stageModels.images,
      maxTurns: 4,
      timeoutMs: 10 * 60_000,
    },
  );

  // Reported, not rejected: the generation rules override a bad request on the
  // way to the provider, but when a picture comes back wrong the log should
  // already say which prompt ordered it.
  for (const spec of plan.images) {
    const risks = findImagePromptRisks(spec.prompt ?? "");
    if (risks.length > 0) {
      log.warn(
        `Image plan "${spec.filename}" asks for ${risks.join(", ")} — ` +
          "the generation rules will override that",
      );
    }
  }

  await db().delete(articleImages).where(eq(articleImages.articleId, params.articleId));

  const assetIds = plan.images
    .map((i) => i.brandAssetId)
    .filter((id): id is string => Boolean(id));
  const assetsById = await loadBrandAssetsByIds(assetIds);

  const ordered = [...plan.images].sort((a, b) =>
    a.role === b.role ? a.position - b.position : a.role === "hero" ? -1 : 1,
  );

  // Rows first, in order, so positions are stable regardless of which image
  // finishes first.
  const rows = await db()
    .insert(articleImages)
    .values(
      ordered.map((spec) => ({
        articleId: params.articleId,
        role: spec.role,
        kind: spec.kind,
        position: spec.position,
        source: spec.source,
        status: "generating" as const,
        brandAssetId: spec.brandAssetId ?? null,
        prompt: spec.prompt ?? null,
        placementHeading: spec.placementHeading ?? null,
        altText: spec.altText,
        caption: spec.caption ?? null,
      })),
    )
    .returning();

  /**
   * Generated in parallel, a few at a time.
   *
   * These are independent, and each takes 10-40 seconds plus polling — done one
   * after another that is minutes of an article's wall-clock spent waiting on a
   * queue of its own making. Bounded rather than unbounded because Magnific
   * rate-limits: hitting a 429 after waiting is worse than waiting a little
   * longer.
   */
  const CONCURRENCY = 3;

  let done = 0;
  const settled = new Array<PlacedImage | null>(ordered.length).fill(null);

  async function renderAt(index: number): Promise<void> {
    const spec = ordered[index];
    const row = rows[index];
    if (!spec || !row) return;

    try {
      const blobUrl =
        spec.source === "brand_asset"
          ? assetsById.get(spec.brandAssetId ?? "")?.blobUrl
          : await generateAndStore({
              provider,
              articleId: params.articleId,
              clientId: params.clientId,
              role: spec.role,
              kind: spec.kind,
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

      settled[index] = {
        id: row.id,
        role: spec.role,
        position: spec.position,
        blobUrl,
        altText: spec.altText,
        caption: spec.caption ?? null,
        placementHeading: spec.placementHeading ?? null,
      };
    } catch (error) {
      // One failed image should not lose a finished article — the editor lets a
      // human regenerate or replace it afterwards.
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Image ${row.id} failed: ${message}`);
      await db()
        .update(articleImages)
        .set({ status: "failed", error: message })
        .where(eq(articleImages.id, row.id));
    } finally {
      // No progress report from here any more: this runs alongside the draft
      // and the review loop, and reporting step 7 from it would drag the
      // progress bar backwards while the article is still being written.
      done += 1;
      log.info(`Images: ${done}/${ordered.length}`);
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ordered.length) }, async () => {
      for (let index = next++; index < ordered.length; index = next++) {
        await renderAt(index);
      }
    }),
  );

  // Order is the plan's, not whichever finished first.
  const resolved = settled.filter((image): image is PlacedImage => image !== null);

  return resolved;
}

async function generateAndStore(params: {
  provider: ImageProvider | null;
  articleId: string;
  clientId: string;
  role: "hero" | "inline";
  kind: ImageKind;
  prompt: string;
  filename: string;
  styleReferenceUrl: string | undefined;
  imageId: string;
}): Promise<string> {
  if (!params.provider) throw new Error("No image provider configured");
  if (!params.prompt) throw new Error("No prompt supplied for a generated image");

  // The rules travel with the prompt rather than living in the planning stage
  // alone: the plan is what asked for a twelve-row checklist in the first place.
  const request = imageRequestFor({
    role: params.role,
    kind: params.kind,
    prompt: params.prompt,
  });

  const generated = await params.provider.generate({
    ...request,
    ...(params.styleReferenceUrl
      ? { styleReferenceUrl: params.styleReferenceUrl, styleStrength: 0.5 }
      : {}),
  });

  await db()
    .update(articleImages)
    .set({
      magnificTaskId: generated.taskId,
      aspectRatio: request.aspectRatio,
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
