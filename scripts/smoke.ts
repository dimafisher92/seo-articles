/**
 * End-to-end smoke test against a real Postgres.
 *
 * Covers the parts that only break in a database: the atomic job claim (the
 * one query multiple workers race on), the partial unique index guarding the
 * style reference, and the stale-job reaper. The pure functions are exercised
 * here too so a single command tells you whether the core is sound.
 *
 *   DATABASE_URL=postgres://... pnpm tsx scripts/smoke.ts
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  articles,
  brandAssets,
  brandVaults,
  clients,
  closeDb,
  contentPlans,
  getDb,
  jobs,
  keywordRuns,
  keywords as keywordsTable,
  planItems,
  sanitizeConnectionString,
} from "@seo/db";
import {
  buildJsonLd,
  computeContentGap,
  countWords,
  extractImageUrls,
  markdownToHtml,
  normaliseDomain,
  runSeoChecks,
  reconcileImages,
  stripAuthoredHtml,
  stripBeforeH1,
  findAuthoredHtml,
  stripFrontMatter,
  stripUnknownImages,
  type PlacedImage,
  findMachineTells,
  gateDraft,
  checksReadyForReview,
  statusAfterReview,
  ASPECT_RATIOS,
  imageRequestFor,
  findImagePromptRisks,
  scoreKeyword,
  slugify,
  truncate,
  type RankedKeyword,
} from "@seo/shared";
import { and, eq, sql } from "drizzle-orm";

import {
  authHeaderFor,
  DEFAULT_MODEL,
  MODELS,
  resolveModel,
  aspectRatioName,
} from "../apps/worker/src/providers/magnific.js";
import { unwrapToolResult } from "../apps/worker/src/providers/mcp-http.js";
import { describeBlobFailure } from "../apps/web/lib/blob.js";
import { gapHint } from "../apps/web/lib/gap-hint.js";
import { jobsToShow, type JobView } from "../apps/web/lib/job-banner.js";
import {
  canRegenerate,
  regenerateLabel,
} from "../apps/web/lib/regenerate.js";
import {
  describeStageModels,
  resolveStageModels,
} from "../apps/worker/src/stage-models.js";
import { createTimer } from "../apps/worker/src/timings.js";
import { isRetryableFailure } from "../apps/worker/src/retry.js";
import { serpIntelPrompt } from "@seo/playbook";
import {
  JobTimeoutError,
  makeReporter,
  startHeartbeat,
  withDeadline,
  type ProgressUpdate,
} from "../apps/worker/src/progress.js";
import { SearchAtlasProvider } from "../apps/worker/src/providers/searchatlas.js";
// The shipping implementations, not copies: the claim query and the reaper are
// the two places where a subtle change would pass typecheck and still lose or
// duplicate work, so the test has to exercise the real ones.
import {
  claimNextJob,
  requeueStaleJobs,
  STALE_JOB_MINUTES,
} from "../apps/web/lib/queue.js";
import { renderEnvFiles } from "./setup.js";

const db = getDb;

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`  ✖ ${name}\n      ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/**
 * Asserts a query fails on a uniqueness constraint.
 *
 * Drizzle wraps driver errors, so the Postgres "duplicate key" text lives on
 * `error.cause` rather than the message it surfaces. Walking the chain is what
 * makes the assertion actually test the constraint instead of the wrapper.
 */
async function assertUniqueViolation(
  operation: Promise<unknown>,
  what: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      const code = (current as { code?: string }).code;
      if (code === "23505" || /duplicate key|unique constraint/i.test(current.message)) {
        return;
      }
      current = current.cause;
    }
    throw new Error(
      `${what} failed, but not on a uniqueness constraint: ${String(error)}`,
    );
  }
  throw new Error(`${what} was allowed — the constraint is missing`);
}

/* ----------------------------------------------------------- pure helpers */

async function pureTests(): Promise<void> {
  section("Text helpers");

  await test("slugify strips accents and punctuation", () => {
    assert.equal(slugify("Café Décor: 10 Ideas!"), "cafe-decor-10-ideas");
  });

  await test("slugify cuts on a word boundary", () => {
    const slug = slugify("the complete guide to industrial fastener selection", 30);
    assert.ok(slug.length <= 30);
    assert.ok(!slug.endsWith("-"));
    assert.equal(slug, "the-complete-guide-to");
  });

  await test("normaliseDomain strips scheme, www, path and port", () => {
    assert.equal(normaliseDomain("https://www.Example.com:443/blog/x"), "example.com");
  });

  await test("truncate cuts on a word boundary", () => {
    assert.equal(truncate("one two three four", 12), "one two…");
  });

  section("Word counting");

  await test("countWords ignores code fences, images and link URLs", () => {
    const markdown = [
      "# Title",
      "",
      "Some real words here.",
      "",
      "![a very long alt description](https://example.com/some/long/path.png)",
      "",
      "[anchor text](https://example.com/another/long/path)",
      "",
      "```",
      "const ignored = 'not prose at all';",
      "```",
    ].join("\n");

    // "Title" (1) + "Some real words here" (4) + "anchor text" (2) = 7
    assert.equal(countWords(markdown), 7);
  });

  await test("extractImageUrls finds every body image", () => {
    const found = extractImageUrls(
      "![hero](https://a.test/1.png)\n\ntext\n\n![two](https://a.test/2.webp)",
    );
    assert.deepEqual(
      found.map((f) => f.url),
      ["https://a.test/1.png", "https://a.test/2.webp"],
    );
    assert.equal(found[0]?.alt, "hero");
  });

  section("Content gap");

  await test("flags keywords competitors rank for and the client does not", () => {
    const clientRanked: RankedKeyword[] = [
      { keyword: "torque chart", url: "https://c.test/a", position: 4, volume: 900, difficulty: 20 },
      { keyword: "bolt sizes", url: "https://c.test/b", position: 45, volume: 500, difficulty: 15 },
    ];
    const competitors = new Map<string, RankedKeyword[]>([
      [
        "rival.com",
        [
          { keyword: "torque chart", url: "https://rival.com/1", position: 2, volume: 900, difficulty: 20 },
          { keyword: "bolt sizes", url: "https://rival.com/2", position: 3, volume: 500, difficulty: 15 },
          { keyword: "fastener grades", url: "https://rival.com/3", position: 1, volume: 1200, difficulty: 30 },
        ],
      ],
    ]);

    const rows = computeContentGap(clientRanked, competitors);
    const byKeyword = new Map(rows.map((r) => [r.keyword, r]));

    // Client ranks #4 — well inside the threshold, so not a gap.
    assert.equal(byKeyword.get("torque chart")?.isGap, false);
    // Client ranks #45 — past page two, effectively invisible.
    assert.equal(byKeyword.get("bolt sizes")?.isGap, true);
    // Client does not rank at all.
    assert.equal(byKeyword.get("fastener grades")?.isGap, true);
    assert.equal(byKeyword.get("fastener grades")?.clientRank, null);
  });

  await test("merges the same keyword across competitors, best position first", () => {
    const competitors = new Map<string, RankedKeyword[]>([
      ["a.com", [{ keyword: "kw", url: "https://a.com/x", position: 7, volume: null, difficulty: null }]],
      ["b.com", [{ keyword: "kw", url: "https://b.com/y", position: 2, volume: 400, difficulty: 10 }]],
    ]);

    const rows = computeContentGap([], competitors);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.competitors.length, 2);
    assert.equal(rows[0]?.competitors[0]?.position, 2);
    // Metrics are backfilled from whichever competitor row carried them.
    assert.equal(rows[0]?.volume, 400);
  });

  section("Keyword scoring");

  await test("business relevance outweighs raw volume", () => {
    const highVolumeIrrelevant = scoreKeyword({
      volume: 90_000,
      difficulty: 40,
      isGap: false,
      competitorCount: 0,
      businessRelevance: 0.1,
    });
    const modestButRelevant = scoreKeyword({
      volume: 800,
      difficulty: 25,
      isGap: true,
      competitorCount: 3,
      businessRelevance: 0.95,
      funnelStage: "bofu",
    });

    assert.ok(
      modestButRelevant > highVolumeIrrelevant,
      `expected relevant term (${modestButRelevant}) to beat vanity term (${highVolumeIrrelevant})`,
    );
  });

  await test("scores stay within 0-100", () => {
    const max = scoreKeyword({
      volume: 1_000_000,
      difficulty: 0,
      isGap: true,
      competitorCount: 50,
      businessRelevance: 1,
      funnelStage: "bofu",
    });
    const min = scoreKeyword({
      volume: null,
      difficulty: 100,
      isGap: false,
      competitorCount: 0,
      businessRelevance: 0,
    });
    assert.ok(max <= 100 && max >= 0, `max out of range: ${max}`);
    assert.ok(min <= 100 && min >= 0, `min out of range: ${min}`);
  });

  section("SEO checks");

  await test("a compliant article scores highly", () => {
    const body = [
      "# How to Choose Industrial Fasteners",
      "",
      "Choosing a fastener comes down to three things: the load it carries, the material it joins, and the environment it sits in. Get those right and grade selection follows. This guide walks each decision in order, with the torque figures we use on our own line.",
      "",
      "## What determines fastener grade?",
      "",
      "Grade is set by tensile strength. A grade 8 bolt handles roughly 150,000 psi.",
      "",
      "| Grade | Tensile |",
      "| --- | --- |",
      "| 5 | 120,000 psi |",
      "| 8 | 150,000 psi |",
      "",
      "## How do you calculate torque?",
      "",
      "Torque is the clamp load times the diameter times a friction factor.",
      "",
      "- Dry threads: 0.20",
      "- Lubricated: 0.15",
      "",
      "## When does corrosion matter?",
      "",
      "Anywhere the joint sees moisture. See our [fastener catalogue](https://acme.test/catalogue) and the [coatings guide](https://acme.test/coatings).",
      "",
      "Reference the [ASTM F568 standard](https://astm.org/f568) and [ISO 898](https://iso.org/898).",
      "",
      "## Frequently Asked Questions",
      "",
      "### Can I reuse a bolt?",
      "",
      "Not once it has yielded.",
    ].join("\n");

    const result = runSeoChecks({
      title: "How to Choose Industrial Fasteners",
      titleTag: "How to Choose Industrial Fasteners",
      metaDescription:
        "Choosing industrial fasteners comes down to load, material and environment. Here is the grade and torque decision path we use in the field.",
      slug: "how-to-choose-industrial-fasteners",
      bodyMdx: body,
      mainKeyword: "industrial fasteners",
      secondaryKeywords: ["fastener grade", "bolt torque"],
      faqCount: 3,
      internalLinkCount: 2,
      externalSourceCount: 2,
      imageCount: 3,
      imagesMissingAlt: 0,
      targetWordCount: null,
    });

    const failed = result.checks.filter((c) => !c.passed).map((c) => c.id);
    assert.ok(
      result.total >= 80,
      `scored ${result.total}, failing: ${failed.join(", ")}`,
    );
  });

  await test("catches an over-long title tag and a short meta description", () => {
    const result = runSeoChecks({
      title: "T",
      titleTag: "A".repeat(90),
      metaDescription: "Too short.",
      slug: "Not A Slug",
      bodyMdx: "# T\n\nWords.",
      mainKeyword: "fasteners",
    });

    const failed = new Set(
      result.checks.filter((c) => !c.passed).map((c) => c.id),
    );
    assert.ok(failed.has("title-tag-length"), "title length not flagged");
    assert.ok(failed.has("meta-description-length"), "meta length not flagged");
    assert.ok(failed.has("slug-format"), "slug format not flagged");
  });

  await test("flags a wall-of-text paragraph", () => {
    const wall = Array.from({ length: 140 }, (_, i) => `word${i}`).join(" ");
    const result = runSeoChecks({
      title: "T",
      bodyMdx: `# T\n\n${wall}`,
      mainKeyword: "t",
    });
    const check = result.checks.find((c) => c.id === "paragraph-length");
    assert.equal(check?.passed, false);
  });

  section("New on-page checks");

  const bodyWith = (extra: string): string =>
    `# T\n\nEl contrato decide su cheque. Pregunte el porcentaje antes de firmar.\n\n${extra}`;

  await test("an opening sentence too long to quote fails", () => {
    const packed =
      "El contrato de cuota de contingencia fija un porcentaje que sube al " +
      "entrar en litigio, y además el gravamen hospitalario, la sección 55.004 " +
      "del Código de Propiedad, la sección 82.065 y la Regla 1.04(d) cambian " +
      "por completo la cantidad neta que usted recibe al final del proceso.";
    const checks = runSeoChecks({ title: "T", bodyMdx: `# T\n\n${packed}` });
    const check = checks.checks.find((c) => c.id === "opening-answer");
    assert.equal(check?.passed, false, "a 50-word opening should fail");
  });

  await test("a short answer-first opening passes", () => {
    const checks = runSeoChecks({ title: "T", bodyMdx: bodyWith("") });
    assert.equal(
      checks.checks.find((c) => c.id === "opening-answer")?.passed,
      true,
    );
  });

  await test("mostly non-question H2s fail the house rule", () => {
    // One question in seven used to pass; the rule is that H2s are questions.
    const headings = [
      "## Un acuerdo de $90,000",
      "## Las 9 preguntas",
      "## Lo que sí es igual",
      "## Cómo verificar al bufete",
      "## ¿Cuánto cobra un abogado?",
    ].join("\n\nTexto.\n\n");
    const checks = runSeoChecks({ title: "T", bodyMdx: bodyWith(headings) });
    const check = checks.checks.find((c) => c.id === "question-headings");
    assert.equal(check?.passed, false);
    assert.match(check?.detail ?? "", /1\/5/);
  });

  await test("seven FAQ entries is over-servicing", () => {
    const checks = runSeoChecks({ title: "T", bodyMdx: bodyWith(""), faqCount: 7 });
    assert.equal(checks.checks.find((c) => c.id === "faq-count")?.passed, false);
    assert.equal(checks.checks.find((c) => c.id === "faq-present")?.passed, true);
  });

  await test("missing structured data is caught", () => {
    const withNone = runSeoChecks({
      title: "T",
      bodyMdx: bodyWith(""),
      schemaTypes: [],
    });
    assert.equal(
      withNone.checks.find((c) => c.id === "structured-data")?.passed,
      false,
    );

    const withBoth = runSeoChecks({
      title: "T",
      bodyMdx: bodyWith(""),
      schemaTypes: ["BlogPosting", "FAQPage", "BreadcrumbList"],
    });
    assert.equal(
      withBoth.checks.find((c) => c.id === "structured-data")?.passed,
      true,
    );
  });

  await test("machine tells surface as a failing check", () => {
    const checks = runSeoChecks({
      title: "T",
      bodyMdx: bodyWith("Es la parte que casi nadie lee."),
    });
    assert.equal(checks.checks.find((c) => c.id === "machine-tells")?.passed, false);
  });

  section("Images in the body");

  const image = (over: Partial<PlacedImage> = {}): PlacedImage => ({
    id: "img-1",
    role: "inline",
    position: 1,
    blobUrl: "https://new.test/a.png",
    altText: "a chart",
    caption: null,
    placementHeading: "How much does it cost?",
    ...over,
  });

  const body = [
    "# Title",
    "",
    "Opening line.",
    "",
    "## How much does it cost?",
    "",
    "Body text.",
  ].join("\n");

  await test("a regenerated image that was never in the body is placed", () => {
    // The case the old substitution missed entirely: the previous generation
    // failed, so there was no old URL to swap, and the body never got it.
    const out = reconcileImages(body, [image()]);
    assert.match(out, /!\[a chart\]\(https:\/\/new\.test\/a\.png\)/);
    // Under its heading, not appended at the end.
    assert.ok(
      out.indexOf("a chart") < out.indexOf("Body text."),
      "the image should sit under its heading",
    );
  });

  await test("references to a replaced store are removed", () => {
    // A Blob store was swapped; every URL from the old one renders broken.
    const stale = [
      "# Title",
      "",
      "![old hero](https://old-private.test/hero.png)",
      "*A caption that went with it*",
      "",
      "Opening line.",
    ].join("\n");

    const out = reconcileImages(stale, []);
    assert.ok(!out.includes("old-private.test"), "the dead URL should be gone");
    assert.ok(!out.includes("A caption"), "its caption should go with it");
    assert.match(out, /Opening line\./);
  });

  await test("the hero goes under the H1", () => {
    const out = reconcileImages(body, [
      image({ id: "h", role: "hero", placementHeading: null, blobUrl: "https://new.test/h.png" }),
    ]);
    const lines = out.split("\n").filter((line) => line.trim());
    assert.match(lines[0] ?? "", /^# Title/);
    assert.match(lines[1] ?? "", /h\.png/);
  });

  await test("reconciling twice changes nothing", () => {
    // Regeneration runs this on a body it has already reconciled; a second
    // pass must not duplicate the figure.
    const once = reconcileImages(body, [image()]);
    assert.equal(reconcileImages(once, [image()]), once);
    assert.equal((once.match(/a\.png/g) ?? []).length, 1);
  });

  await test("an image whose heading was renamed is kept, not dropped", () => {
    // It was paid for. A human can move it; silently losing it is worse.
    const out = reconcileImages(body, [
      image({ placementHeading: "A heading that no longer exists" }),
    ]);
    assert.match(out, /a\.png/);
  });

  await test("stripping leaves images that are still live", () => {
    const withImage = reconcileImages(body, [image()]);
    assert.equal(
      stripUnknownImages(withImage, new Set(["https://new.test/a.png"])),
      withImage,
    );
  });

  section("Image storage failures");

  await test("a private store is explained, not reported as a bad gateway", () => {
    // Verbatim from the live failure. The worker retried it three times
    // because the route wrapped it in a 502 and 502 reads as transient.
    const explanation = describeBlobFailure(
      'Vercel Blob: Cannot use public access on a private store. ' +
        'The store is configured with private access.',
    );
    assert.ok(explanation, "the failure should be recognised");
    assert.match(explanation, /publicly readable/);
    assert.match(explanation, /new store/);
    assert.match(explanation, /BLOB_READ_WRITE_TOKEN/);
  });

  await test("a rejected token is told apart from a rejected store", () => {
    assert.match(
      describeBlobFailure("Vercel Blob: Unauthorized") ?? "",
      /Check BLOB_READ_WRITE_TOKEN/,
    );
  });

  await test("an unrecognised failure stays retryable", () => {
    // Anything that might be a passing upstream problem must not be recast as
    // permanent — that would turn a blip into a lost article.
    assert.equal(describeBlobFailure("socket hang up"), null);
    assert.equal(describeBlobFailure("503 Service Unavailable"), null);
  });

  section("Stage models");

  const tiers = { strong: "claude-opus-5", fast: "claude-sonnet-5" };

  await test("mechanical stages run cheaper, judgement stages do not", () => {
    // Review decides whether an article ships; making it cheaper would give
    // back the thing the gate exists for.
    const models = resolveStageModels({}, tiers);
    for (const stage of ["outline", "draft", "qa", "revise"] as const) {
      assert.equal(models[stage], tiers.strong, `${stage} should be strong`);
    }
    for (const stage of ["serpIntel", "meta", "images"] as const) {
      assert.equal(models[stage], tiers.fast, `${stage} should be fast`);
    }
  });

  await test("any stage can be moved without a release", () => {
    const models = resolveStageModels({ CLAUDE_MODEL_QA: "claude-fable-5" }, tiers);
    assert.equal(models.qa, "claude-fable-5");
    assert.equal(models.draft, tiers.strong, "other stages are unaffected");
  });

  await test("a blank override falls back rather than emptying the model", () => {
    // An env var set to "" is how a half-edited .env reaches the worker.
    assert.equal(
      resolveStageModels({ CLAUDE_MODEL_DRAFT: "   " }, tiers).draft,
      tiers.strong,
    );
  });

  await test("the banner groups stages by model", () => {
    const line = describeStageModels(resolveStageModels({}, tiers));
    assert.match(line, /claude-opus-5: /);
    assert.match(line, /claude-sonnet-5: /);
    assert.match(line, /qa/);
  });

  section("QA gate");

  await test("a high finding forces a revision even on a ship verdict", () => {
    // Exactly what happened: six high findings, verdict "ship", published.
    const decision = gateDraft({
      verdict: "ship",
      issues: [
        { severity: "high", note: "invented fee ladder: 33⅓% / 40% / 45%" },
        { severity: "low", note: "register slips in one place" },
      ],
      failedCheckIds: [],
    });
    assert.equal(decision.mustRevise, true);
    assert.equal(decision.blocking.length, 1);
    assert.match(decision.reason, /1 high-severity finding/);
  });

  await test("a failed writing check forces a revision on its own", () => {
    const decision = gateDraft({
      verdict: "ship",
      issues: [],
      failedCheckIds: ["word-count", "question-headings"],
    });
    assert.equal(decision.mustRevise, true);
    assert.match(decision.reason, /word-count/);
  });

  await test("a missing image does not hold prose hostage", () => {
    // Images are generated after review, so image-count always fails there.
    // Looping on it would spend passes rewriting text over a missing picture.
    const decision = gateDraft({
      verdict: "ship",
      issues: [{ severity: "medium", note: "could be tighter" }],
      failedCheckIds: ["image-count", "image-alt"],
    });
    assert.equal(decision.mustRevise, false);
  });

  await test("the review may still ask for a pass when nothing objective failed", () => {
    assert.equal(
      gateDraft({ verdict: "revise", issues: [], failedCheckIds: [] }).mustRevise,
      true,
    );
  });

  await test("outstanding work counts findings and failed checks together", () => {
    // What the revision loop watches to decide it is still converging. Counting
    // only the findings reads as "nothing improving" for a draft whose problems
    // are all failed checks, and stops the loop on its second pass.
    assert.equal(
      gateDraft({
        verdict: "ship",
        issues: [{ severity: "high", note: "invented figure" }],
        failedCheckIds: ["word-count", "image-count"],
      }).problemCount,
      2,
      "one finding plus one blocking check; image-count does not block",
    );
    assert.equal(
      gateDraft({ verdict: "ship", issues: [], failedCheckIds: [] }).problemCount,
      0,
    );
  });

  await test("unresolved high findings change the article's status", () => {
    assert.equal(statusAfterReview([{ severity: "high", note: "x" }]), "needs_attention");
    assert.equal(statusAfterReview([]), "draft");
  });

  section("Machine tells");

  await test("the repeated 'nobody tells you' move is counted", () => {
    // Five instances of one trope in a single article, quoted by the review
    // and acted on by nothing.
    const body = [
      "Es la parte que casi nadie lee.",
      "La resta que ningún anuncio le muestra.",
      "Un riesgo que nadie explica.",
    ].join("\n\n");
    const tells = findMachineTells(body);
    const total = tells.reduce((sum, tell) => sum + tell.count, 0);
    assert.ok(total >= 3, `expected at least 3 tells, found ${total}`);
  });

  await test("negative parallelism is counted", () => {
    const tells = findMachineTells(
      "No es un descuido menor: es la cláusula que decide su cheque.",
    );
    assert.ok(tells.some((tell) => tell.label === "negative-parallelism"));
  });

  await test("ordinary prose is not flagged", () => {
    assert.deepEqual(
      findMachineTells(
        "El contrato fija el porcentaje antes de presentar la demanda. " +
          "Pregunte cuál aplica en su caso.",
      ),
      [],
    );
  });

  section("Aspect ratios");

  await test("every aspect ratio has a Magnific name", () => {
    // Magnific rejects "16:9" and lists its own vocabulary in the 400 — after
    // the request is queued. These are those values, verbatim from that error.
    const accepted = new Set([
      "square_1_1",
      "classic_4_3",
      "traditional_3_4",
      "widescreen_16_9",
      "social_story_9_16",
      "standard_3_2",
      "portrait_2_3",
      "horizontal_2_1",
      "vertical_1_2",
      "social_post_4_5",
    ]);

    for (const ratio of ASPECT_RATIOS) {
      const name = aspectRatioName(ratio);
      assert.ok(
        accepted.has(name),
        `${ratio} maps to "${name}", which Magnific does not accept`,
      );
    }
  });

  await test("the ratios the article pipeline asks for translate", () => {
    assert.equal(
      aspectRatioName(
        imageRequestFor({ role: "hero", kind: "photo", prompt: "x" }).aspectRatio,
      ),
      "widescreen_16_9",
    );
    assert.equal(
      aspectRatioName(
        imageRequestFor({ role: "inline", kind: "photo", prompt: "x" }).aspectRatio,
      ),
      "standard_3_2",
    );
  });

  await test("an unmapped ratio fails here, not at the API", () => {
    assert.throws(
      () => aspectRatioName("21:9" as (typeof ASPECT_RATIOS)[number]),
      /No Magnific name for aspect ratio/,
    );
  });

  section("Image models");

  await test("the default model is Nano Banana 2", () => {
    assert.equal(DEFAULT_MODEL, "nano-banana-pro-flash");
    assert.equal(resolveModel(undefined).path, MODELS[DEFAULT_MODEL]?.path);
    assert.equal(resolveModel("").path, MODELS[DEFAULT_MODEL]?.path);
  });

  await test("every model has its own endpoint path", () => {
    const paths = Object.values(MODELS).map((m) => m.path);
    assert.equal(new Set(paths).size, paths.length, "two models share a path");
    for (const [slug, model] of Object.entries(MODELS)) {
      assert.ok(model.path.startsWith("/v1/ai/"), `${slug}: unexpected path`);
      assert.ok(model.label, `${slug}: no label`);
      assert.ok(model.costNote, `${slug}: no cost note`);
    }
  });

  await test("an unknown model names the ones that exist", () => {
    assert.throws(
      () => resolveModel("nano-banana-2"),
      (error: Error) =>
        /Unknown MAGNIFIC_IMAGE_MODEL/.test(error.message) &&
        error.message.includes("nano-banana-pro-flash"),
    );
  });

  await test("each model carries the style reference its own way", () => {
    const request = {
      prompt: "a banana",
      aspectRatio: "3:2" as const,
      resolution: "1k" as const,
      styleReferenceUrl: "https://blob.test/brand.jpg",
    };

    // This is the reason for a per-model registry rather than a path swap:
    // sending Mystic's shape to Nano Banana would leave the style reference
    // silently ignored, and brand consistency is what it exists for.
    const nano = MODELS["nano-banana-pro-flash"]?.buildBody(request) as {
      reference_images?: { image: string; text: string; mime_type: string }[];
      style_reference?: unknown;
    };
    assert.ok(nano.reference_images, "Nano Banana lost the style reference");
    assert.equal(nano.reference_images?.[0]?.image, request.styleReferenceUrl);
    assert.equal(nano.reference_images?.[0]?.mime_type, "image/jpeg");
    assert.equal(nano.style_reference, undefined, "wrong field for this model");

    const mystic = MODELS["mystic"]?.buildBody(request) as {
      style_reference?: string;
      adherence?: number;
      reference_images?: unknown;
    };
    assert.equal(mystic.style_reference, request.styleReferenceUrl);
    assert.equal(typeof mystic.adherence, "number");
    assert.equal(mystic.reference_images, undefined, "wrong field for this model");
  });

  await test("the request body speaks Magnific's vocabulary", () => {
    const body = MODELS[DEFAULT_MODEL]?.buildBody({
      prompt: "x",
      aspectRatio: "16:9",
      resolution: "2k",
    }) as { resolution?: string; aspect_ratio?: string };
    assert.equal(body.resolution, "2K");
    // This assertion used to expect "16:9", which is what Magnific rejects —
    // the test was holding the bug in place.
    assert.equal(body.aspect_ratio, "widescreen_16_9");
  });

  await test("the auth header follows the host", () => {
    // Magnific is the rebranded Freepik; one key, two hosts, two header names.
    assert.equal(authHeaderFor("https://api.magnific.com"), "x-magnific-api-key");
    assert.equal(authHeaderFor("https://api.freepik.com"), "x-freepik-api-key");
  });

  section("Setup");

  await test("both env files receive the same WORKER_SECRET", () => {
    // A mismatch here surfaces much later as an opaque 401 when the worker
    // tries to claim a job, so it is the one thing worth asserting.
    const { web, worker } = renderEnvFiles({
      databaseUrl: "postgres://u:p@host-pooler/db",
      databaseUrlUnpooled: "postgres://u:p@host/db",
      claudeToken: "sk-ant-oat01-x",
      blobToken: "vercel_blob_rw_x",
      searchAtlasKey: "sa-x",
      magnificKey: "MS-x",
      appUrl: "http://localhost:3000",
    });

    const read = (text: string, key: string): string | undefined =>
      new RegExp(`^${key}="([^"]*)"`, "m").exec(text)?.[1];

    const webSecret = read(web, "WORKER_SECRET");
    assert.ok(webSecret, "web file has no WORKER_SECRET");
    assert.equal(read(worker, "WORKER_SECRET"), webSecret);
    assert.ok(webSecret.length >= 32, "secret is too short to be worth having");
  });

  await test("the other generated secrets are all distinct", () => {
    const { web } = renderEnvFiles({
      databaseUrl: "postgres://u:p@host-pooler/db",
      databaseUrlUnpooled: "postgres://u:p@host/db",
      claudeToken: "",
      blobToken: "",
      searchAtlasKey: "",
      magnificKey: "",
      appUrl: "http://localhost:3000",
    });

    const secrets = ["WORKER_SECRET", "CRON_SECRET", "AUTH_SECRET"].map(
      (key) => new RegExp(`^${key}="([^"]*)"`, "m").exec(web)?.[1],
    );
    assert.ok(secrets.every(Boolean), "a secret is missing");
    assert.equal(new Set(secrets).size, 3, "secrets were reused");
  });

  await test("migrations get the direct string, the runtime the pooled one", () => {
    const { worker } = renderEnvFiles({
      databaseUrl: "postgres://u:p@host-pooler/db",
      databaseUrlUnpooled: "postgres://u:p@host/db",
      claudeToken: "",
      blobToken: "",
      searchAtlasKey: "",
      magnificKey: "",
      appUrl: "http://localhost:3000",
    });

    const read = (key: string): string | undefined =>
      new RegExp(`^${key}="([^"]*)"`, "m").exec(worker)?.[1];

    // Schema tools need session state, which PgBouncer in transaction mode
    // does not have; running them pooled fails without ever naming pooling.
    assert.ok(read("DATABASE_URL")?.includes("-pooler"));
    assert.ok(!read("DATABASE_URL_UNPOOLED")?.includes("-pooler"));
  });

  await test("the direct string falls back to the pooled one when absent", () => {
    const { worker } = renderEnvFiles({
      databaseUrl: "postgres://u:p@host-pooler/db",
      databaseUrlUnpooled: "",
      claudeToken: "",
      blobToken: "",
      searchAtlasKey: "",
      magnificKey: "",
      appUrl: "http://localhost:3000",
    });
    // Better a warning at migration time than an empty connection string.
    assert.ok(
      /^DATABASE_URL_UNPOOLED="postgres:\/\/u:p@host-pooler\/db"$/m.test(worker),
    );
  });

  await test("answers land in the file that needs them", () => {
    const { web, worker } = renderEnvFiles({
      databaseUrl: "postgres://u:p@host-pooler/db",
      databaseUrlUnpooled: "postgres://u:p@host/db",
      claudeToken: "sk-ant-oat01-token",
      blobToken: "vercel_blob_rw_token",
      searchAtlasKey: "sa-key",
      magnificKey: "MS-magnific-key",
      appUrl: "https://example.vercel.app",
    });

    // The Claude subscription token must never reach the app's environment.
    assert.ok(worker.includes("sk-ant-oat01-token"));
    assert.ok(!web.includes("sk-ant-oat01-token"));

    // Blob writes happen app-side, so the token belongs there only.
    assert.ok(web.includes("vercel_blob_rw_token"));
    assert.ok(!worker.includes("vercel_blob_rw_token"));

    // Provider keys are the worker's business; the app never calls Magnific.
    assert.ok(worker.includes("MS-magnific-key"));
    assert.ok(!web.includes("MS-magnific-key"));

    assert.ok(worker.includes('APP_URL="https://example.vercel.app"'));
    // Both get the pooled string for runtime use; only the worker also gets
    // the direct one, because only it runs migrations.
    assert.ok(web.includes("postgres://u:p@host-pooler/db"));
    assert.ok(worker.includes("postgres://u:p@host-pooler/db"));
  });

  section("Rendering");

  await test("markdownToHtml wraps an image plus caption in a figure", () => {
    const html = markdownToHtml(
      "![a diagram](https://a.test/x.png)\n\n*Figure 1: the joint*",
    );
    assert.ok(html.includes("<figure>"), `no figure in: ${html}`);
    assert.ok(html.includes("<figcaption>Figure 1: the joint</figcaption>"));
    assert.ok(html.includes('loading="lazy"'));
  });

  await test("buildJsonLd emits BlogPosting, FAQPage and BreadcrumbList", () => {
    const blocks = buildJsonLd({
      title: "How to Choose Fasteners",
      description: "A guide.",
      slug: "how-to-choose-fasteners",
      domain: "acme.test",
      author: { name: "Jo Rivera", title: "Head of Engineering" },
      faq: [{ question: "Q?", answer: "A." }],
      publisherName: "Acme",
    });

    const types = blocks.map((b) => (b as { "@type": string })["@type"]);
    assert.deepEqual(types, ["BlogPosting", "FAQPage", "BreadcrumbList"]);

    const posting = blocks[0] as { author: { name: string }; url: string };
    assert.equal(posting.author.name, "Jo Rivera");
    assert.equal(posting.url, "https://acme.test/blog/how-to-choose-fasteners");
  });

  await test("buildJsonLd omits FAQPage when there are no questions", () => {
    const blocks = buildJsonLd({
      title: "T",
      description: "d",
      slug: "t",
      domain: null,
      faq: [],
      publisherName: "Acme",
    });
    const types = blocks.map((b) => (b as { "@type": string })["@type"]);
    assert.deepEqual(types, ["BlogPosting"]);
  });

  console.log("\nContent gap wording");

  await test("zero gaps does not claim a fact about the market", () => {
    // Each of these used to read "Competitors rank, this client does not".
    assert.match(
      gapHint({ gapKeywords: 0, competitorsRequested: [], competitorsAnalysed: [] }),
      /No competitors set/,
    );
    assert.match(
      gapHint({
        gapKeywords: 0,
        competitorsRequested: ["rival.com"],
        competitorsAnalysed: [],
      }),
      /No ranking data for rival\.com yet/,
    );
    assert.match(
      gapHint({
        gapKeywords: 0,
        competitorsRequested: ["rival.com"],
        competitorsAnalysed: ["rival.com"],
      }),
      /Nothing found that these competitors rank for/,
    );
  });

  await test("a real gap count keeps the plain reading", () => {
    assert.equal(
      gapHint({ gapKeywords: 12, competitorsAnalysed: ["rival.com"] }),
      "Competitors rank, this client does not",
    );
  });

  console.log("\nFront matter");

  const FRONT_MATTER_BODY = [
    "---",
    'title: "Houston Car Accident Lawyer Fees"',
    'description: "What a contingency fee actually costs."',
    'slug: "houston-car-accident-lawyer-fees"',
    'author: "The Firm"',
    "---",
    "",
    "# Houston Car Accident Lawyer Fees",
    "",
    "Most Houston car accident lawyers take a third of the settlement.",
    "",
    "## What does a contingency fee cover?",
    "",
    "Everything up to trial.",
  ].join("\n");

  await test("a leading YAML block is dropped, the H1 becomes the first line", () => {
    const stripped = stripFrontMatter(FRONT_MATTER_BODY);
    assert.equal(
      stripped.split("\n")[0],
      "# Houston Car Accident Lawyer Fees",
    );
    assert.ok(!stripped.includes("slug:"));
  });

  await test("a body without front matter is returned untouched", () => {
    const body = "# Title\n\nA sentence.\n";
    assert.equal(stripFrontMatter(body), body);
  });

  await test("a thematic break mid-article survives", () => {
    const body = "# Title\n\nOne.\n\n---\n\nTwo: a line.\n\n---\n";
    assert.equal(stripFrontMatter(body), body);
  });

  await test("prose fenced by rules at the top is not mistaken for metadata", () => {
    // An article may open on a thematic break. Eating everything up to the
    // next one would silently delete its lead.
    const body = "---\n\nMost lawyers take a third.\n\n---\n\n# Title\n";
    assert.equal(stripFrontMatter(body), body);
  });

  await test("stripping twice changes nothing the second time", () => {
    const once = stripFrontMatter(FRONT_MATTER_BODY);
    assert.equal(stripFrontMatter(once), once);
  });

  await test("front matter is gone from the rendered article, not just the source", () => {
    // The visible bug: the preview and every HTML export printed
    // `title: "…" description: "…"` as a paragraph above the heading. The
    // scores never showed it — `leadParagraph` skips such a block already —
    // which is why it survived to a reader.
    assert.ok(markdownToHtml(FRONT_MATTER_BODY).includes("slug:"));
    assert.ok(
      !markdownToHtml(stripFrontMatter(FRONT_MATTER_BODY)).includes("slug:"),
    );
  });

  await test("the lead is the article's own opening either way", () => {
    // One rule for what front matter is: the check used to carry its own,
    // looser pattern, and two definitions of the same thing drift.
    const input = {
      title: "Houston Car Accident Lawyer Fees",
      titleTag: "Houston Car Accident Lawyer Fees | The Firm",
      metaDescription: "What a contingency fee actually costs in Houston.",
      slug: "houston-car-accident-lawyer-fees",
      mainKeyword: "houston car accident lawyer",
      secondaryKeywords: [],
      faqCount: 3,
      internalLinkCount: 2,
      externalSourceCount: 2,
      imageCount: 3,
      imagesMissingAlt: 0,
      targetWordCount: null,
    };

    const detail = (bodyMdx: string): string | undefined =>
      runSeoChecks({ ...input, bodyMdx }).checks.find(
        (c) => c.id === "opening-answer",
      )?.detail;

    assert.equal(
      detail(FRONT_MATTER_BODY),
      detail(stripFrontMatter(FRONT_MATTER_BODY)),
    );
  });

  console.log("\nWhere the minutes go");

  await test("a stage's seconds are recorded even when it throws", async () => {
    // The most interesting number in a failed run is how long it burned first,
    // and a finally-less timer loses exactly that one.
    let clock = 0;
    const timer = createTimer(() => clock);

    await timer
      .measure("draft", async () => {
        clock += 90_000;
        throw new Error("boom");
      })
      .catch(() => {});

    assert.equal(timer.summary().draft, 90);
  });

  await test("repeated stages accumulate rather than overwrite", () => {
    let clock = 0;
    const timer = createTimer(() => clock);
    return (async () => {
      for (const seconds of [30, 45, 20]) {
        await timer.measure("revise", async () => {
          clock += seconds * 1000;
        });
      }
      // Three revision passes are one number worth comparing across runs.
      assert.equal(timer.summary().revise, 95);
    })();
  });

  await test("overlapping stages make the parts exceed the whole", async () => {
    // That gap is the saving from running images alongside the draft; a total
    // that merely summed the parts would hide it.
    let clock = 0;
    const timer = createTimer(() => clock);

    const slow = timer.measure("images", async () => {
      clock += 200_000;
    });
    await timer.measure("draft", async () => {});
    await slow;

    const summary = timer.summary();
    assert.equal(summary.images, 200);
    assert.ok(summary.total <= summary.images);
  });

  await test("a stage that burned its turns in seconds is worth another go", () => {
    // Not retrying this cost a finished draft and four rendered images.
    assert.equal(isRetryableFailure("error_max_turns", "error_max_turns"), true);
  });

  await test("five spent schema attempts are not paid for a sixth time", () => {
    assert.equal(
      isRetryableFailure("error_max_structured_output_retries", "…5 attempts"),
      false,
    );
  });

  await test("a rate limit is retryable whatever the subtype says", () => {
    assert.equal(isRetryableFailure("error_during_execution", "429 rate limit"), true);
    assert.equal(isRetryableFailure("something_new", "overloaded"), true);
  });

  await test("an unknown failure is not retried on a guess", () => {
    assert.equal(isRetryableFailure("something_new", "no idea"), false);
  });

  console.log("\nSERP intelligence");

  const SERP_BRAND = {
    name: "The Firm",
    domain: "example.com",
    country: "US",
    locale: "es-US",
    audience: "Houston drivers",
    toneOfVoice: "plain",
    services: [],
    differentiators: [],
    moneyPages: [],
    facts: [],
    forbidden: [],
    authorPersona: "The Editorial Team",
  } as unknown as Parameters<typeof serpIntelPrompt>[0];

  const SERP_BRIEF = {
    title: "Houston car accident lawyer fees",
    mainKeyword: "houston car accident lawyer",
    secondaryKeywords: [],
    intent: "commercial",
    pageType: "blog",
    funnelStage: "mofu",
    targetWordCount: 1700,
    internalLinkTargets: [],
    serpNotes: null,
  } as unknown as Parameters<typeof serpIntelPrompt>[1];

  await test("with provider data the stage is told not to search", () => {
    const prompt = serpIntelPrompt(SERP_BRAND, SERP_BRIEF, {
      results: [
        { position: 1, url: "https://rival.com/fees", title: "Fees explained" },
      ],
      peopleAlsoAsk: ["How much does a lawyer take?"],
      relatedSearches: [],
    });

    assert.ok(prompt.includes("https://rival.com/fees"));
    assert.ok(/have no tools/i.test(prompt));
    assert.ok(!/Use web search/i.test(prompt));
  });

  await test("without provider data it still knows how to read the web", () => {
    // The fallback matters: a keyword the tracker has never seen must still
    // produce an article, just more slowly.
    const prompt = serpIntelPrompt(SERP_BRAND, SERP_BRIEF, null);
    assert.ok(/Use web search/i.test(prompt));
    assert.ok(!/have no tools/i.test(prompt));
  });

  await test("an empty result set counts as no data", () => {
    const prompt = serpIntelPrompt(SERP_BRAND, SERP_BRIEF, {
      results: [],
      peopleAlsoAsk: [],
      relatedSearches: [],
    });
    assert.ok(/Use web search/i.test(prompt));
  });

  console.log("\nWhat the review may be judged on");

  await test("metadata checks are not held against a draft that has none yet", () => {
    // The bug this pins: the metadata stage runs after the review, so these
    // three failed on every article, every pass. The gate then demanded a
    // revision every time, and the review — told the meta description was
    // empty — wrote one into the body, which is the only place it can write.
    assert.deepEqual(
      checksReadyForReview([
        "meta-description-length",
        "meta-description-keyword",
        "slug-format",
        "word-count",
        "machine-tells",
      ]),
      ["word-count", "machine-tells"],
    );
  });

  await test("a draft with only pending checks failing is not sent back", () => {
    const decision = gateDraft({
      verdict: "ship",
      issues: [],
      failedCheckIds: checksReadyForReview([
        "meta-description-length",
        "slug-format",
        "image-count",
      ]),
    });
    assert.equal(decision.mustRevise, false);
  });

  await test("real writing failures still send it back", () => {
    const decision = gateDraft({
      verdict: "ship",
      issues: [],
      failedCheckIds: checksReadyForReview(["slug-format", "word-count"]),
    });
    assert.equal(decision.mustRevise, true);
    assert.ok(decision.reason.includes("word-count"));
    assert.ok(!decision.reason.includes("slug-format"));
  });

  console.log("\nNothing above the H1");

  await test("a publishing-metadata blockquote above the heading is dropped", () => {
    const body = [
      "> **Metadatos para la etapa de publicación**",
      "> Title tag: Abogado de Lesiones Personales Houston",
      "> Slug: preguntas-abogado-lesiones-personales-houston",
      "",
      "# Antes de Firmar el Contrato",
      "",
      "Confirme la licencia por escrito.",
    ].join("\n");

    const out = stripBeforeH1(body);
    assert.ok(out.startsWith("# Antes de Firmar el Contrato"));
    assert.ok(!out.includes("Slug:"));
  });

  await test("a body that already starts at the H1 is untouched", () => {
    const body = "# Title\n\nA sentence.\n";
    assert.equal(stripBeforeH1(body), body);
  });

  await test("real prose above the heading is kept, not silently deleted", () => {
    // Losing an article's lead because it forgot its heading would be worse
    // than the apparatus this removes.
    const body = "Most lawyers take a third of the settlement.\n\n# Title\n";
    assert.equal(stripBeforeH1(body), body);
  });

  await test("a body with no H1 at all is left alone", () => {
    const body = "> a note\n\nSome text without any heading.\n";
    assert.equal(stripBeforeH1(body), body);
  });

  console.log("\nImage generation rules");

  const PLANNED = "A lawyer and a client reviewing a contract at a desk in Houston.";

  await test("the planned prompt survives, the rules are added to it", () => {
    const request = imageRequestFor({
      role: "inline",
      kind: "photo",
      prompt: PLANNED,
    });
    assert.ok(request.prompt.startsWith(PLANNED));
    assert.ok(/five fingers/i.test(request.prompt));
  });

  await test("a photo is told to keep hands out of the way and text out of frame", () => {
    // The six-fingered hand and the shop sign nobody can read.
    const { prompt } = imageRequestFor({
      role: "hero",
      kind: "photo",
      prompt: PLANNED,
    });
    assert.ok(/hands are never the subject/i.test(prompt));
    assert.ok(/no legible text/i.test(prompt));
  });

  await test("a diagram is told no numbers, and told to override a request for them", () => {
    const { prompt } = imageRequestFor({
      role: "inline",
      kind: "diagram",
      prompt: "A bar chart comparing 25%, 33% and 40% of a $100,000 settlement.",
    });
    assert.ok(/no numbers of any kind/i.test(prompt));
    assert.ok(/at most 3 labels/i.test(prompt));
    // The planning stage is what asked for the chart, so the last word has to
    // belong to the rules rather than to the prompt above them.
    assert.ok(/ignore that part of it/i.test(prompt));
    assert.ok(prompt.lastIndexOf("ignore that part") > prompt.indexOf("bar chart"));
  });

  await test("a diagram is rendered large enough for its labels to survive", () => {
    // 1K in-body is 1216x832; a label at a twelfth of that is on the edge.
    assert.equal(
      imageRequestFor({ role: "inline", kind: "diagram", prompt: "x" }).resolution,
      "2k",
    );
    assert.equal(
      imageRequestFor({ role: "inline", kind: "photo", prompt: "x" }).resolution,
      "1k",
    );
  });

  await test("a prompt that orders what models render badly is reported", () => {
    assert.deepEqual(
      findImagePromptRisks(
        "A bar chart comparing 25%, 33% and 40% contingency fees.",
      ),
      ["numbers", "a chart"],
    );
    assert.deepEqual(
      findImagePromptRisks("A checklist of the twelve questions, grouped."),
      ["a list"],
    );
    assert.deepEqual(findImagePromptRisks(PLANNED), []);
  });

  console.log("\nHTML the draft had no business writing");

  // Verbatim from an exported article: three <img> tags at paths that exist
  // nowhere, the on-page mechanics comment that hid the meta description, and
  // the JSON-LD block the pipeline builds for itself.
  const AUTHORED_HTML_BODY = [
    "# Antes de Firmar el Contrato",
    "",
    "![Un cliente y una abogada revisan un contrato](https://blob.example.com/articles/a/hero.jpg)",
    "",
    "Antes de firmar, confirme la licencia por escrito.",
    "",
    '<img src="/img/preguntas-antes-firmar.webp" alt="Un cliente y una abogada" width="1600" height="900" loading="eager" />',
    "",
    "## ¿Qué preguntas debe hacerle?",
    "",
    "Las tres de mayor peso son la licencia, el porcentaje y los gastos.",
    "",
    "<!-- MECÁNICA ON-PAGE (no publicar como texto visible)",
    "Slug (45 caracteres): preguntas-abogado-lesiones-personales-houston",
    "Meta description (142 caracteres): Antes de contratar…",
    "-->",
    "",
    '<script type="application/ld+json">',
    '{ "@type": "BlogPosting" }',
    "</script>",
  ].join("\n");

  await test("the invented <img> tags are gone", () => {
    const cleaned = stripAuthoredHtml(AUTHORED_HTML_BODY);
    assert.ok(!/<img/i.test(cleaned));
    // The real image, in Markdown, is untouched.
    assert.ok(cleaned.includes("https://blob.example.com/articles/a/hero.jpg"));
  });

  await test("the comment that hid the meta description is gone", () => {
    const cleaned = stripAuthoredHtml(AUTHORED_HTML_BODY);
    assert.ok(!cleaned.includes("<!--"));
    assert.ok(!cleaned.includes("MECÁNICA ON-PAGE"));
  });

  await test("a script block never reaches the rendered body", () => {
    // markdownToHtml passes raw HTML through and the result is injected with
    // dangerouslySetInnerHTML, so this is the path that matters.
    assert.ok(markdownToHtml(AUTHORED_HTML_BODY).includes("<script"));
    assert.ok(
      !markdownToHtml(stripAuthoredHtml(AUTHORED_HTML_BODY)).includes("<script"),
    );
  });

  await test("an unterminated script block does not survive on a technicality", () => {
    const cleaned = stripAuthoredHtml('# Title\n\n<script>\nalert(1)\n');
    assert.ok(!/<script/i.test(cleaned));
  });

  await test("prose and Markdown are left alone", () => {
    const body = "# Title\n\nOne < two, and 3 > 2.\n\n![alt](https://x/y.jpg)\n";
    assert.equal(stripAuthoredHtml(body), body.trim());
  });

  await test("cleaning twice changes nothing the second time", () => {
    const once = stripAuthoredHtml(AUTHORED_HTML_BODY);
    assert.equal(stripAuthoredHtml(once), once);
  });

  await test("the check names what it found, and passes once cleaned", () => {
    assert.deepEqual(findAuthoredHtml(AUTHORED_HTML_BODY), [
      "<img>",
      "<script>",
      "HTML comment",
    ]);
    assert.deepEqual(findAuthoredHtml(stripAuthoredHtml(AUTHORED_HTML_BODY)), []);
  });

  await test("an existing article reports its raw HTML rather than hiding it", () => {
    const input = {
      title: "Antes de Firmar el Contrato",
      titleTag: "Abogado de Lesiones Personales Houston: 12 Preguntas",
      metaDescription: "Antes de contratar a un abogado en Houston, confirme la licencia.",
      slug: "preguntas-abogado-lesiones-personales-houston",
      mainKeyword: "abogado de lesiones personales houston",
      secondaryKeywords: [],
      faqCount: 3,
      internalLinkCount: 2,
      externalSourceCount: 2,
      imageCount: 3,
      imagesMissingAlt: 0,
      targetWordCount: null,
    };

    const passes = (bodyMdx: string): boolean =>
      runSeoChecks({ ...input, bodyMdx }).checks.find(
        (c) => c.id === "authored-html",
      )?.passed ?? false;

    assert.equal(passes(AUTHORED_HTML_BODY), false);
    assert.equal(passes(stripAuthoredHtml(AUTHORED_HTML_BODY)), true);
  });

  await test("raw HTML holds an article back rather than scoring it down", () => {
    const decision = gateDraft({
      verdict: "ship",
      issues: [],
      failedCheckIds: ["authored-html"],
    });
    assert.equal(decision.mustRevise, true);
  });

  await test("an invented Markdown image is reconciled out of the body", () => {
    // The same failure in the syntax the pipeline does understand: assembly
    // used to only add what was missing, so a URL the draft made up stayed.
    const body = [
      "# Title",
      "",
      "![made up](https://blob.example.com/articles/a/ghost.jpg)",
      "",
      "## What is it?",
      "",
      "An answer.",
    ].join("\n");

    const live: PlacedImage[] = [
      {
        id: "img-1",
        role: "hero",
        position: 0,
        blobUrl: "https://blob.example.com/articles/a/real.jpg",
        altText: "The real one",
        caption: null,
        placementHeading: null,
      },
    ];

    const out = reconcileImages(body, live);
    assert.ok(!out.includes("ghost.jpg"));
    assert.ok(out.includes("real.jpg"));
  });

  console.log("\nRegenerating an article");

  await test("a run in flight cannot be commissioned again", () => {
    assert.equal(canRegenerate("queued"), false);
    assert.equal(canRegenerate("generating"), false);
  });

  await test("a finished or failed article can be re-run", () => {
    for (const status of ["planned", "drafted", "approved", "exported", "failed"] as const) {
      assert.equal(canRegenerate(status), true, status);
    }
  });

  await test("a failed run offers a retry, a finished one a rewrite", () => {
    assert.equal(regenerateLabel("failed"), "Retry");
    assert.equal(regenerateLabel("drafted"), "Regenerate");
  });

  console.log("\nJob banner");

  const job = (
    type: string,
    status: JobView["status"],
    id: string,
  ): JobView => ({
    id,
    type,
    status,
    progress: null,
    error: status === "failed" ? "boom" : null,
    result: null,
    attempts: 1,
    createdAt: "2026-08-27T00:00:00Z",
    finishedAt: null,
  });

  await test("a failure superseded by a later success is not shown", () => {
    // Newest first, as the API returns them. The old failure had been claiming
    // the page was broken through every successful run after it.
    const shown = jobsToShow([
      job("keyword_research", "done", "new"),
      job("keyword_research", "failed", "old"),
    ]);
    assert.deepEqual(shown, []);
  });

  await test("a failure that is still the latest of its type is shown", () => {
    const shown = jobsToShow([
      job("keyword_research", "failed", "latest"),
      job("keyword_research", "done", "older"),
    ]);
    assert.deepEqual(shown.map((j) => j.id), ["latest"]);
  });

  await test("a failed type does not hide a different type still running", () => {
    const shown = jobsToShow([
      job("write_article", "running", "running-one"),
      job("keyword_research", "failed", "failed-one"),
    ]);
    assert.deepEqual(shown.map((j) => j.id).sort(), ["failed-one", "running-one"]);
  });

  await test("a retry in flight replaces its own type's failure", () => {
    const shown = jobsToShow([
      job("keyword_research", "running", "retry"),
      job("keyword_research", "failed", "first-try"),
    ]);
    assert.deepEqual(shown.map((j) => j.id), ["retry"]);
  });

  console.log("\nProgress and deadlines");

  await test("the heartbeat re-sends the stage, not a generic label", async () => {
    // The regression this guards: a heartbeat that sent its own "Working"
    // overwrote the real stage a minute after it appeared, which made a slow
    // job impossible to tell apart from a stuck one.
    const sent: ProgressUpdate[] = [];
    const { report, current } = makeReporter("job-1", (_id, update) => {
      sent.push(update);
    });

    await report(3, 6, "Analysing content gap", "4 competitors");

    const stop = startHeartbeat("job-1", current, (_id, u) => void sent.push(u), 5);
    await new Promise((resolve) => setTimeout(resolve, 25));
    stop();

    const beats = sent.slice(1);
    assert.ok(beats.length > 0, "no heartbeat fired");
    for (const beat of beats) {
      assert.equal(beat.label, "Analysing content gap");
      assert.equal(beat.step, 3);
      assert.equal(beat.totalSteps, 6);
    }
  });

  await test("a job that outlives its deadline fails, naming the stage", async () => {
    const { report, current } = makeReporter("job-2", () => {});
    await report(2, 6, "Pulling keyword volume");

    // Never settles — the shape of a provider call that has wedged.
    const stuck = new Promise<void>(() => {});

    await assert.rejects(
      withDeadline(stuck, current, 20),
      (error: unknown) => {
        assert.ok(error instanceof JobTimeoutError);
        assert.match(error.message, /Pulling keyword volume/);
        assert.match(error.message, /step 2\/6/);
        return true;
      },
    );
  });

  await test("the deadline names the stage it reached, not the one it started on", async () => {
    const { report, current } = makeReporter("job-3", () => {});
    await report(1, 6, "Choosing seed keywords");

    const stuck = (async () => {
      await report(4, 6, "Ranking candidates");
      await new Promise<void>(() => {});
    })();

    await assert.rejects(withDeadline(stuck, current, 30), (error: unknown) => {
      assert.match((error as Error).message, /Ranking candidates/);
      return true;
    });
  });

  await test("finishing in time clears the timer rather than leaking it", async () => {
    const { current } = makeReporter("job-4", () => {});
    assert.equal(await withDeadline(Promise.resolve("done"), current, 50), "done");
    // A leaked timer would keep the event loop alive; the suite exiting proves
    // it does not.
  });

  console.log("\nMCP over HTTP");

  await test("a tool result's text block is unwrapped to its JSON", () => {
    // MCP wraps results in content blocks aimed at a model; the data we want
    // is JSON inside one of them.
    assert.deepEqual(
      unwrapToolResult({ content: [{ type: "text", text: '{"volume":320}' }] }),
      { volume: 320 },
    );
  });

  await test("structuredContent wins over the text block", () => {
    assert.deepEqual(
      unwrapToolResult({
        structuredContent: { volume: 1 },
        content: [{ type: "text", text: '{"volume":2}' }],
      }),
      { volume: 1 },
    );
  });

  await test("non-JSON text comes back as text, not as an error", () => {
    assert.equal(
      unwrapToolResult({ content: [{ type: "text", text: "no data" }] }),
      "no data",
    );
  });

  console.log("\nSearchAtlas adapter");

  /**
   * A stand-in for the live endpoint.
   *
   * The real responses were never observable from where this was written, so
   * the shapes here are deliberately awkward in the ways a real API is: the
   * rows are nested two levels deep under different keys per tool, the field
   * names are the alternate spellings rather than the obvious ones, and volume
   * arrives as a string with a thousands separator. If the adapter's tolerance
   * is real, this passes; if it only handles the tidy case, it does not.
   */
  const searchAtlas = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body || "{}") as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (!message.id) return void res.writeHead(202).end();

      const reply = (result: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };

      if (message.method === "initialize") return reply({ serverInfo: {} });

      const tool = message.params?.name;
      const json = (value: unknown): unknown => ({
        content: [{ type: "text", text: JSON.stringify(value) }],
      });

      if (tool === "se_research_keywords") {
        const asked = (message.params?.arguments?.keywords ?? []) as string[];
        // Stands in for a response this code cannot read: the request
        // succeeded, so nothing throws, and yet no row comes out of it.
        if (asked.includes("unreadable")) return reply(json({ status: "ok" }));

        if (asked.includes("mixed")) {
          // Has `columns`, but the rows are already objects. The columnar path
          // must decline this rather than index into them positionally.
          return reply(
            json({
              columns: ["keyword", "search_volume"],
              rows: [{ keyword: "already an object", search_volume: 77 }],
            }),
          );
        }

        if (asked.includes("columnar")) {
          // Copied from a live response. The parallel-array shape is the one
          // that silently produced empty columns for several runs.
          return reply(
            json({
              id: 4929413,
              name: "Untitled",
              columns: [
                "keyword",
                "search_volume",
                "keyword_difficulty",
                "cost_per_click",
                "ppc_difficulty",
              ],
              rows: [["abogado de accidentes houston", 30, 6, 238.06, 84]],
              keyword_count: 1,
            }),
          );
        }

        return reply(
          json({
            project: {
              keyword_data: [
                { keyword_text: "kids trampoline", search_volume: "12,100", kd: 34, cpc: 0.8 },
                { keyword_text: "", search_volume: 10 },
              ],
            },
          }),
        );
      }

      if (tool === "se_analyze_domain") {
        return reply(
          json({
            facets: {
              organic: [
                { query: "garden trampoline", current_position: 4, landing_page: "https://x.com/a", search_volume: 900 },
                { query: "no position here" },
              ],
            },
          }),
        );
      }

      if (tool === "se_keyword_gap_analyze") {
        return reply(json({ analysis: { analysis_id: "an-1" } }));
      }

      if (tool === "se_get_keyword_gap_results") {
        return reply(
          json({
            data: {
              rows: [
                {
                  keyword: "trampoline safety net",
                  search_volume: 480,
                  primary_position: null,
                  competitors: [
                    { domain: "https://rival-b.com/x", position: 7, url: "https://rival-b.com/x" },
                    { domain: "rival-a.com", position: 2 },
                  ],
                },
              ],
            },
          }),
        );
      }

      return reply(json({}));
    });
  });

  await new Promise<void>((resolve) => searchAtlas.listen(0, "127.0.0.1", resolve));
  const port = (searchAtlas.address() as AddressInfo).port;
  const provider = new SearchAtlasProvider(
    { apiKey: "test" },
    `http://127.0.0.1:${port}/mcp`,
  );
  const geo = { country: "gb", locale: "en-GB" };

  try {
    await test("metrics survive nesting, alternate spellings and a string volume", async () => {
      const metrics = await provider.getMetrics(["kids trampoline"], geo);
      assert.equal(metrics.length, 1, "the row with no keyword should be dropped");
      assert.equal(metrics[0]?.keyword, "kids trampoline");
      assert.equal(metrics[0]?.volume, 12100, "'12,100' should parse");
      assert.equal(metrics[0]?.difficulty, 34);
    });

    await test("ranked keywords drop rows with no position", async () => {
      const ranked = await provider.getRankedKeywords("https://acme.com/shop", geo);
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0]?.keyword, "garden trampoline");
      assert.equal(ranked[0]?.position, 4);
    });

    await test("the gap is read through the analysis id it returns", async () => {
      const gap = await provider.getKeywordGap(
        "acme.com",
        ["rival-a.com", "rival-b.com"],
        geo,
      );
      assert.equal(gap.length, 1);
      assert.equal(gap[0]?.keyword, "trampoline safety net");
      // No position for the client is what makes it a gap.
      assert.equal(gap[0]?.clientRank, null);
      assert.equal(gap[0]?.isGap, true);
      // Competitor domains are normalised, whichever form they arrive in.
      assert.deepEqual(
        gap[0]?.competitors.map((c) => c.domain).sort(),
        ["rival-a.com", "rival-b.com"],
      );
    });

    await test("a columnar table is zipped into rows", async () => {
      const metrics = await provider.getMetrics(["columnar"], geo);
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0]?.keyword, "abogado de accidentes houston");
      assert.equal(metrics[0]?.volume, 30);
      assert.equal(metrics[0]?.difficulty, 6);
      assert.equal(metrics[0]?.cpc, 238.06);
    });

    await test("rows of objects are not mistaken for a columnar table", async () => {
      // `rows` is also the key a normal list arrives under, so the columnar
      // path must decline it when the entries are already objects — zipping
      // them would index into an object by position and yield nothing.
      const metrics = await provider.getMetrics(["mixed"], geo);
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0]?.keyword, "already an object");
      assert.equal(metrics[0]?.volume, 77);
    });

    await test("no metrics at all is an error, not a table of zeros", async () => {
      // The failure this prevents: every request coming back unreadable, the
      // run completing, and a strategist acting on a column of zeros.
      await assert.rejects(
        provider.getMetrics(["unreadable"], geo),
        (error: unknown) => {
          assert.match((error as Error).message, /no metrics for any of 1/);
          assert.match((error as Error).message, /searchatlas:probe/);
          return true;
        },
      );
    });

    await test("progress is reported as batches and seeds complete", async () => {
      const seen: string[] = [];
      await provider.getRelated(["a", "b"], geo, 10, (done, total) =>
        seen.push(`${done}/${total}`),
      );
      assert.deepEqual(seen, ["1/2", "2/2"]);
    });

    await test("a gap needs competitors, and never counts the client", async () => {
      assert.deepEqual(await provider.getKeywordGap("acme.com", [], geo), []);
      assert.deepEqual(
        await provider.getKeywordGap("acme.com", ["acme.com"], geo),
        [],
      );
    });
  } finally {
    await new Promise<void>((resolve) => searchAtlas.close(() => resolve()));
  }

  console.log("\nConnection strings");

  await test("Neon's channel_binding is stripped", () => {
    // Verbatim from Neon's Connect dialog. postgres-js forwards what it does
    // not recognise as a server startup parameter, and Postgres rejects this
    // one; drizzle-kit does not even report it, it just hangs forever.
    const neon =
      "postgresql://neondb_owner:pw@ep-x-pooler.eu-central-1.aws.neon.tech" +
      "/neondb?sslmode=require&channel_binding=require";
    const cleaned = sanitizeConnectionString(neon);

    assert.ok(!cleaned.includes("channel_binding"), "channel_binding survived");
    assert.ok(cleaned.includes("sslmode=require"), "sslmode was dropped too");
    assert.ok(cleaned.includes("ep-x-pooler"), "the host was mangled");
    assert.ok(cleaned.includes("neondb_owner:pw@"), "credentials were mangled");
  });

  await test("real server settings are left alone", () => {
    const url =
      "postgres://u:p@host/db?application_name=seo&options=-c%20statement_timeout%3D5s";
    assert.equal(sanitizeConnectionString(url), url);
  });

  await test("sslrootcert=system survives, a file path does not", () => {
    assert.ok(
      sanitizeConnectionString(
        "postgres://u:p@host/db?sslrootcert=system",
      ).includes("sslrootcert=system"),
    );
    assert.ok(
      !sanitizeConnectionString(
        "postgres://u:p@host/db?sslrootcert=/etc/ca.pem",
      ).includes("sslrootcert"),
    );
  });

  await test("an unparseable string is passed through, not swallowed", () => {
    // Better the driver reports the real problem than this helper eats it.
    assert.equal(sanitizeConnectionString("not a url"), "not a url");
  });
}

/* ------------------------------------------------------------- database */

async function databaseTests(): Promise<string> {
  section("Database");

  const [client] = await db()
    .insert(clients)
    .values({
      name: `Smoke Test ${Date.now()}`,
      domain: "smoke.test",
      country: "US",
      locale: "en-US",
    })
    .returning();
  assert.ok(client, "client insert failed");

  await db().insert(brandVaults).values({
    clientId: client.id,
    businessDescription: "Sells fasteners.",
    competitors: ["rival.com"],
  });

  await test("style reference is unique per client", async () => {
    const [first] = await db()
      .insert(brandAssets)
      .values({
        clientId: client.id,
        blobUrl: "https://blob.test/a.png",
        isStyleReference: true,
      })
      .returning();
    assert.ok(first);

    // A second style reference for the same client must be rejected by the
    // partial unique index — this is what stops two "the brand look" images.
    await assertUniqueViolation(
      db().insert(brandAssets).values({
        clientId: client.id,
        blobUrl: "https://blob.test/b.png",
        isStyleReference: true,
      }),
      "a second style reference",
    );

    // Non-reference assets are unconstrained.
    await db().insert(brandAssets).values({
      clientId: client.id,
      blobUrl: "https://blob.test/c.png",
    });
    await db().insert(brandAssets).values({
      clientId: client.id,
      blobUrl: "https://blob.test/d.png",
    });

    const all = await db()
      .select()
      .from(brandAssets)
      .where(eq(brandAssets.clientId, client.id));
    assert.equal(all.length, 3);
  });

  await test("keywords are unique per run", async () => {
    const [run] = await db()
      .insert(keywordRuns)
      .values({ clientId: client.id, seeds: ["fasteners"] })
      .returning();
    assert.ok(run);

    await db().insert(keywordsTable).values({
      runId: run.id,
      clientId: client.id,
      keyword: "bolt torque",
      volume: 900,
    });

    await assertUniqueViolation(
      db().insert(keywordsTable).values({
        runId: run.id,
        clientId: client.id,
        keyword: "bolt torque",
      }),
      "a duplicate keyword in the same run",
    );
  });

  await test("deleting a client cascades to its dependent rows", async () => {
    const [temp] = await db()
      .insert(clients)
      .values({ name: "Cascade Test", domain: "cascade.test" })
      .returning();
    assert.ok(temp);

    const [run] = await db()
      .insert(keywordRuns)
      .values({ clientId: temp.id })
      .returning();
    assert.ok(run);

    const [plan] = await db()
      .insert(contentPlans)
      .values({ clientId: temp.id, runId: run.id })
      .returning();
    assert.ok(plan);

    await db().insert(planItems).values({
      planId: plan.id,
      clientId: temp.id,
      title: "T",
      mainKeyword: "k",
    });
    await db().insert(articles).values({
      clientId: temp.id,
      title: "T",
    });

    await db().delete(clients).where(eq(clients.id, temp.id));

    const leftoverPlans = await db()
      .select()
      .from(contentPlans)
      .where(eq(contentPlans.clientId, temp.id));
    const leftoverArticles = await db()
      .select()
      .from(articles)
      .where(eq(articles.clientId, temp.id));

    assert.equal(leftoverPlans.length, 0);
    assert.equal(leftoverArticles.length, 0);
  });

  return client.id;
}

/* --------------------------------------------------------------- queue */

async function queueTests(clientId: string): Promise<void> {
  section("Job queue");

  // Mirrors lib/queue.ts claimNextJob — this is the query concurrent workers
  // race on, so it is worth exercising against a real Postgres.
  await db().delete(jobs).where(eq(jobs.clientId, clientId));

  await test("claims the oldest queued job and marks it running", async () => {
    const [first] = await db()
      .insert(jobs)
      .values({
        type: "keyword_research",
        clientId,
        payload: { order: 1 },
      })
      .returning();
    assert.ok(first);

    // Distinct timestamps so "oldest first" is actually testable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db()
      .insert(jobs)
      .values({ type: "content_plan", clientId, payload: { order: 2 } });

    const claimed = await claimNextJob("worker-a");
    assert.ok(claimed, "nothing claimed");
    assert.equal(claimed.id, first.id);
    assert.equal(claimed.attempts, 1);

    const [row] = await db().select().from(jobs).where(eq(jobs.id, first.id));
    assert.equal(row?.status, "running");
    assert.equal(row?.claimedBy, "worker-a");
  });

  await test("a second worker gets a different job, never the same one", async () => {
    const claimed = await claimNextJob("worker-b");
    assert.ok(claimed, "second claim returned nothing");
    assert.equal(claimed.type, "content_plan");

    const running = await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.clientId, clientId), eq(jobs.status, "running")));
    assert.equal(running.length, 2);

    const owners = new Set(running.map((j) => j.claimedBy));
    assert.equal(owners.size, 2, "two workers claimed the same job");
  });

  await test("an empty queue returns nothing rather than blocking", async () => {
    assert.equal(await claimNextJob("worker-c"), null);
  });

  await test("concurrent claims hand out distinct jobs", async () => {
    await db().delete(jobs).where(eq(jobs.clientId, clientId));

    for (let i = 0; i < 5; i++) {
      await db()
        .insert(jobs)
        .values({ type: "write_article", clientId, payload: { i } });
    }

    // The real reason for SKIP LOCKED: five workers grabbing at once must end
    // up with five different jobs, not one job handed out five times.
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, i) => claimNextJob(`racer-${i}`)),
    );

    const ids = claims.filter(Boolean).map((c) => c!.id);
    assert.equal(ids.length, 5, `only ${ids.length} of 5 jobs were claimed`);
    assert.equal(new Set(ids).size, 5, "the same job was claimed twice");
  });

  await test("the reaper requeues a job whose worker went silent", async () => {
    await db().delete(jobs).where(eq(jobs.clientId, clientId));

    const silent = new Date(Date.now() - (STALE_JOB_MINUTES + 20) * 60_000);

    const [stale] = await db()
      .insert(jobs)
      .values({
        type: "write_article",
        clientId,
        payload: {},
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        claimedBy: "ghost",
        claimedAt: silent,
        heartbeatAt: silent,
      })
      .returning();
    assert.ok(stale);

    const [exhausted] = await db()
      .insert(jobs)
      .values({
        type: "write_article",
        clientId,
        payload: {},
        status: "running",
        attempts: 3,
        maxAttempts: 3,
        claimedBy: "ghost",
        claimedAt: silent,
        heartbeatAt: silent,
      })
      .returning();
    assert.ok(exhausted);

    // Still beating, so it must survive the sweep untouched.
    const [alive] = await db()
      .insert(jobs)
      .values({
        type: "write_article",
        clientId,
        payload: {},
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        claimedBy: "healthy",
        claimedAt: silent,
        heartbeatAt: new Date(),
      })
      .returning();
    assert.ok(alive);

    const result = await requeueStaleJobs();
    assert.equal(result.requeued, 1, "wrong number requeued");
    assert.equal(result.failed, 1, "wrong number failed");

    const byId = new Map(
      (await db().select().from(jobs).where(eq(jobs.clientId, clientId))).map(
        (job) => [job.id, job],
      ),
    );

    // Attempts left → back on the queue, and released so another worker can
    // take it. Attempts exhausted → terminal, so the UI stops spinning on it.
    assert.equal(byId.get(stale.id)?.status, "queued");
    assert.equal(byId.get(stale.id)?.claimedBy, null);
    assert.equal(byId.get(exhausted.id)?.status, "failed");
    assert.ok(byId.get(exhausted.id)?.finishedAt, "failed job has no finish time");
    assert.equal(byId.get(alive.id)?.status, "running", "reaped a live job");
  });

  await test("a requeued job is handed straight back out", async () => {
    // The whole point of sweeping on the claim endpoint: recovery is only
    // useful if the rescued job is immediately claimable again.
    const claimed = await claimNextJob("worker-after-reap");
    assert.ok(claimed, "the requeued job was not claimable");
    assert.equal(claimed.attempts, 2, "attempts did not carry over");
  });

  await db().delete(clients).where(eq(clients.id, clientId));
}

/* ----------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log("SEO Article Generator — smoke test\n");

  await pureTests();
  const clientId = await databaseTests();
  await queueTests(clientId);

  console.log(
    `\n${failures.length === 0 ? "✔" : "✖"} ${passed} passed, ${failures.length} failed`,
  );
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
  }

  await closeDb();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("Smoke test crashed:", error);
  await closeDb();
  process.exit(1);
});
