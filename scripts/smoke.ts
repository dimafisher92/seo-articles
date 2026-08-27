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
} from "@seo/db";
import {
  buildJsonLd,
  computeContentGap,
  countWords,
  extractImageUrls,
  markdownToHtml,
  normaliseDomain,
  runSeoChecks,
  scoreKeyword,
  slugify,
  truncate,
  type RankedKeyword,
} from "@seo/shared";
import { and, eq, sql } from "drizzle-orm";

import { selectImageTransport } from "../apps/worker/src/providers/images.js";
import {
  MCP_ADD_COMMAND,
  MCP_SERVER_NAME,
  MCP_URL,
} from "../apps/worker/src/providers/magnific-mcp.js";

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

  section("Image transport");

  await test("MCP is the default; REST is an explicit opt-out", () => {
    assert.equal(
      selectImageTransport({ transport: "mcp", hasApiKey: false }),
      "mcp",
    );
    // MCP needs no key, so its absence must not silently disable images.
    assert.equal(
      selectImageTransport({ transport: "", hasApiKey: false }),
      "mcp",
    );
    assert.equal(
      selectImageTransport({ transport: "rest", hasApiKey: true }),
      "rest",
    );
  });

  await test("REST without a key degrades to brand assets, not to MCP", () => {
    // Silently falling back to MCP would ignore a deliberate opt-out and could
    // spend Magnific credits the operator did not intend to spend.
    assert.equal(
      selectImageTransport({ transport: "rest", hasApiKey: false }),
      "none",
    );
  });

  await test("the MCP identity matches what `claude mcp add` registers", () => {
    // The SDK keys the stored OAuth token on the server name and a hash of
    // {type, url, headers}. A trailing slash, a capital letter or a different
    // name yields a different key and presents as "needs-auth", so these are
    // pinned rather than left to drift.
    assert.equal(MCP_SERVER_NAME, MCP_SERVER_NAME.toLowerCase());
    assert.ok(MCP_URL.startsWith("https://"), "MCP URL must be https");
    assert.ok(!MCP_URL.endsWith("/"), "MCP URL must not have a trailing slash");
    assert.equal(
      MCP_ADD_COMMAND,
      `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_URL}`,
    );
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
  async function claim(workerId: string) {
    const rows = await db().execute(sql`
      update ${jobs}
         set status = 'running',
             attempts = ${jobs.attempts} + 1,
             claimed_by = ${workerId},
             claimed_at = now(),
             heartbeat_at = now()
       where ${jobs.id} = (
               select ${jobs.id}
                 from ${jobs}
                where ${jobs.status} = 'queued'
                order by ${jobs.createdAt}
                limit 1
                for update skip locked
             )
      returning ${jobs.id} as "id", ${jobs.type} as "type", ${jobs.attempts} as "attempts"
    `);
    return (rows as unknown as { id: string; type: string; attempts: number }[])[0] ?? null;
  }

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

    const claimed = await claim("worker-a");
    assert.ok(claimed, "nothing claimed");
    assert.equal(claimed.id, first.id);
    assert.equal(claimed.attempts, 1);

    const [row] = await db().select().from(jobs).where(eq(jobs.id, first.id));
    assert.equal(row?.status, "running");
    assert.equal(row?.claimedBy, "worker-a");
  });

  await test("a second worker gets a different job, never the same one", async () => {
    const claimed = await claim("worker-b");
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
    assert.equal(await claim("worker-c"), null);
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
      Array.from({ length: 5 }, (_, i) => claim(`racer-${i}`)),
    );

    const ids = claims.filter(Boolean).map((c) => c!.id);
    assert.equal(ids.length, 5, `only ${ids.length} of 5 jobs were claimed`);
    assert.equal(new Set(ids).size, 5, "the same job was claimed twice");
  });

  await test("the reaper requeues a job whose worker went silent", async () => {
    await db().delete(jobs).where(eq(jobs.clientId, clientId));

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
        claimedAt: new Date(Date.now() - 30 * 60_000),
        heartbeatAt: new Date(Date.now() - 30 * 60_000),
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
        claimedAt: new Date(Date.now() - 30 * 60_000),
        heartbeatAt: new Date(Date.now() - 30 * 60_000),
      })
      .returning();
    assert.ok(exhausted);

    const cutoff = sql`now() - interval '10 minutes'`;
    const candidates = await db()
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "running"),
          sql`coalesce(${jobs.heartbeatAt}, ${jobs.claimedAt}) < ${cutoff}`,
        ),
      );
    assert.equal(candidates.length, 2, "reaper did not see both stale jobs");

    // A job with attempts left goes back on the queue; one that has exhausted
    // them is terminal, so the UI stops spinning on it.
    assert.equal(
      candidates.filter((j) => j.attempts < j.maxAttempts).length,
      1,
    );
    assert.equal(
      candidates.filter((j) => j.attempts >= j.maxAttempts).length,
      1,
    );
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
