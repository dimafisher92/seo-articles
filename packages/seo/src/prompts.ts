/**
 * Prompt construction for every generation stage.
 *
 * The house style lives in `content/playbook.md`; this file only assembles
 * context and states each stage's contract. Keeping the two apart means the
 * quality rules can be tuned by a strategist without reading TypeScript.
 */

export type BrandContext = {
  clientName: string;
  domain: string | null;
  locale: string;
  country: string;
  businessDescription?: string | null;
  productsServices?: string | null;
  icpAudience?: string | null;
  toneOfVoice?: string | null;
  usps?: string[];
  brandTerms?: string[];
  bannedWords?: string[];
  competitors?: string[];
  ctaTargets?: { label: string; url: string; useWhen?: string }[];
  authorPersona?: {
    name?: string;
    title?: string;
    bio?: string;
    credentials?: string[];
  };
  siteCrawlSummary?: string | null;
  contentGuidelines?: string | null;
};

const SENIOR_SEO_IDENTITY = `You are a senior SEO content strategist with 12+ years of experience taking B2B and ecommerce sites from invisible to category-leading in Google. You have run hundreds of content programs, you have seen which tactics survived every core update since 2018, and you have no patience for content that exists only to hit a word count.

You write like a practitioner, not a content mill. You would rather publish 900 sharp words than 2,400 padded ones.`;

function section(title: string, body: string | null | undefined): string {
  const value = body?.trim();
  return value ? `### ${title}\n${value}\n` : "";
}

function listSection(title: string, items?: string[]): string {
  if (!items || items.length === 0) return "";
  return `### ${title}\n${items.map((i) => `- ${i}`).join("\n")}\n`;
}

/** Renders the Brand Vault into the block every stage prompt carries. */
export function renderBrandContext(brand: BrandContext): string {
  const persona = brand.authorPersona;
  const personaText = persona?.name
    ? [
        `Name: ${persona.name}`,
        persona.title ? `Title: ${persona.title}` : null,
        persona.bio ? `Bio: ${persona.bio}` : null,
        persona.credentials?.length
          ? `Credentials: ${persona.credentials.join("; ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  const ctas = brand.ctaTargets?.length
    ? brand.ctaTargets
        .map(
          (t) =>
            `- ${t.label} → ${t.url}${t.useWhen ? ` (link when: ${t.useWhen})` : ""}`,
        )
        .join("\n")
    : null;

  return [
    `## BRAND CONTEXT — ${brand.clientName}`,
    `Site: ${brand.domain ?? "unknown"} · Market: ${brand.country} · Language: ${brand.locale}`,
    "",
    section("What the business does", brand.businessDescription),
    section("What they sell", brand.productsServices),
    section("Who they sell to", brand.icpAudience),
    section("Tone of voice", brand.toneOfVoice),
    listSection("Differentiators", brand.usps),
    listSection("Brand terms — spell these exactly this way", brand.brandTerms),
    listSection("Banned words — never use these", brand.bannedWords),
    listSection("Competitors", brand.competitors),
    section("Internal link targets (money pages)", ctas),
    section("Author persona — byline this article to them", personaText),
    section("What their website says", brand.siteCrawlSummary),
    section("Client-specific rules — these override the playbook", brand.contentGuidelines),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

/* ------------------------------------------------------------ seed stage */

export function seedKeywordsPrompt(brand: BrandContext): string {
  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## TASK
Propose seed keywords for a keyword-research run for this client.

Seeds are broad head and mid-tail terms that a keyword tool will expand from. Good seeds describe:
- the categories of thing the client sells,
- the problems their buyers search before they know the solution exists,
- the comparisons and alternatives their buyers weigh,
- the jobs-to-be-done around the product.

Rules:
- 15-25 seeds. Do not pad the list.
- No branded terms for this client (they already rank for their own name).
- Competitor brand names are allowed only as comparison seeds.
- Write them as a searcher would type them, in ${brand.locale}.
- Do not guess search volumes. A tool supplies those.

Return JSON only:
{"seeds": ["...", "..."], "reasoning": "two sentences on the strategy behind this set"}`;
}

/* -------------------------------------------------------- cluster stage */

export function clusterKeywordsPrompt(
  brand: BrandContext,
  keywords: { keyword: string; volume: number | null; difficulty: number | null; isGap: boolean }[],
): string {
  const table = keywords
    .map(
      (k) =>
        `${k.keyword}\t${k.volume ?? "-"}\t${k.difficulty ?? "-"}\t${k.isGap ? "gap" : ""}`,
    )
    .join("\n");

  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## TASK
Classify and cluster the keyword list below into a topical map.

The columns are: keyword, monthly volume, difficulty, gap flag. The gap flag means tracked competitors rank for it and this client does not.

For every keyword assign:
- **cluster**: the topical group it belongs to. Use 6-14 clusters total, named as a strategist would name a content pillar — not as a keyword. Every keyword gets a cluster.
- **intent**: informational | commercial | transactional | navigational.
- **pageType**: blog | guide | comparison | listicle | category | product | landing.
- **funnelStage**: tofu | mofu | bofu.
- **businessRelevance**: 0.0-1.0 — how close this keyword sits to what the client actually sells and can convert. A high-volume term this client can never monetise scores low. Be honest and be harsh; this number decides what gets written.

Rules:
- Do not invent or alter volumes or difficulty. Echo keywords exactly as given.
- Cluster by *searcher intent and topic*, not by shared words. "cheap running shoes" and "running shoe deals" are one cluster; "running shoe size guide" is another.
- Anything irrelevant to the business gets businessRelevance ≤ 0.2 rather than being dropped.

KEYWORDS (keyword \\t volume \\t difficulty \\t gap):
${table}

Return JSON only:
{"clusters": [{"name": "...", "rationale": "one line"}],
 "keywords": [{"keyword": "...", "cluster": "...", "intent": "...", "pageType": "...", "funnelStage": "...", "businessRelevance": 0.0}]}`;
}

/* ----------------------------------------------------- content plan stage */

export function contentPlanPrompt(
  brand: BrandContext,
  keywords: {
    keyword: string;
    volume: number | null;
    difficulty: number | null;
    cluster: string | null;
    intent: string | null;
    funnelStage: string | null;
    isGap: boolean;
    competitorUrls: { url: string; position: number }[];
  }[],
  targetTitles: number,
  playbook: string,
): string {
  const table = keywords
    .map((k) =>
      [
        k.keyword,
        k.volume ?? "-",
        k.difficulty ?? "-",
        k.cluster ?? "-",
        k.intent ?? "-",
        k.funnelStage ?? "-",
        k.isGap ? "gap" : "-",
        k.competitorUrls
          .slice(0, 3)
          .map((c) => c.url)
          .join(" "),
      ].join("\t"),
    )
    .join("\n");

  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## PLAYBOOK
${playbook}

## TASK
Build a content plan of exactly ${targetTitles} articles from the selected keywords.

**Produce titles and briefs only. Do not write any article body.**

Group the keywords: one article should own a whole cluster of closely-related terms, not one keyword each. Pick the strongest term in each group as the main keyword; the rest become secondary keywords for that article.

For each article give:
- **title** — the working H1. It must promise something the current top 10 does not deliver. No "The Ultimate Guide to X", no "Everything You Need to Know About X", no title that could sit on any competitor's blog unchanged. Use the client's angle, their market, their point of view.
- **mainKeyword** — must be one of the keywords given, exactly as written.
- **secondaryKeywords** — 3-10 of the given keywords this article will also cover.
- **intent**, **pageType**, **funnelStage**.
- **targetWordCount** — set by what the topic needs to beat the SERP. Range 900-3000. A definition post does not need 2,500 words.
- **internalLinkTargets** — pick from the client's money pages above; the ones this article should genuinely route readers toward.
- **serpNotes** — {"dominantAngle": what the top results all do, "missingAngles": [what none of them do], "commonSections": [sections they all have]}. Base this on the competitor URLs given and on searching the web where you need to. Do not guess.
- **rationale** — one sentence: why this article, why now, what it wins.
- **priority** — 1-100, publishing priority. Weight gap keywords and bottom-funnel commercial intent higher.

Order the array by descending priority.

SELECTED KEYWORDS (keyword \\t volume \\t difficulty \\t cluster \\t intent \\t funnel \\t gap \\t competitor URLs):
${table}

Return JSON only:
{"items": [{"title": "...", "mainKeyword": "...", "secondaryKeywords": ["..."], "intent": "...", "pageType": "...", "funnelStage": "...", "targetWordCount": 0, "internalLinkTargets": [{"label": "...", "url": "..."}], "serpNotes": {"dominantAngle": "...", "missingAngles": ["..."], "commonSections": ["..."]}, "rationale": "...", "priority": 0}]}`;
}

/* ------------------------------------------------------ article: stage 1 */

export type ArticleBrief = {
  title: string;
  mainKeyword: string;
  secondaryKeywords: string[];
  intent?: string | null;
  pageType?: string | null;
  funnelStage?: string | null;
  targetWordCount?: number | null;
  internalLinkTargets?: { label: string; url: string; useWhen?: string }[];
  serpNotes?: {
    dominantAngle?: string;
    missingAngles?: string[];
    commonSections?: string[];
    peopleAlsoAsk?: string[];
  } | null;
};

function renderBrief(brief: ArticleBrief): string {
  return `## ARTICLE BRIEF
Working title: ${brief.title}
Main keyword: ${brief.mainKeyword}
Secondary keywords: ${brief.secondaryKeywords.join(", ") || "none"}
Intent: ${brief.intent ?? "unspecified"} · Page type: ${brief.pageType ?? "blog"} · Funnel: ${brief.funnelStage ?? "mofu"}
Target length: ${brief.targetWordCount ?? 1500} words
Internal link targets:
${
  brief.internalLinkTargets?.length
    ? brief.internalLinkTargets
        .map((t) => `- ${t.label} → ${t.url}`)
        .join("\n")
    : "- none supplied"
}`;
}

export function serpIntelPrompt(
  brand: BrandContext,
  brief: ArticleBrief,
): string {
  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

${renderBrief(brief)}

## TASK
Research the live SERP for "${brief.mainKeyword}" in ${brand.country} and report what it takes to beat it.

Use web search and fetch the actual top results. Do not work from memory — rankings change and your training data is stale.

Report:
- **topResults**: for each of the top 8-10 organic results — url, title, the format it uses, its main H2s, and its word count if you can tell.
- **consensus**: the points essentially every result makes. These are table stakes; our article must cover them or look incomplete.
- **entities**: the specific people, products, standards, tools, brands and technical concepts that credible coverage of this topic has to name.
- **peopleAlsoAsk**: the PAA questions on this SERP.
- **gaps**: what none of the top results do well — unanswered questions, missing depth, outdated information, no original data, no real examples.
- **angle**: the single sharpest angle this client could take, given who they are and what they sell, that the top 10 leaves open.
- **formatVerdict**: the format the SERP rewards, and whether our brief's page type matches it. Say so plainly if the brief is wrong.
- **sources**: authoritative primary sources worth citing in the article — original studies, official docs, standards bodies. Not other blogs.

Return JSON only:
{"topResults": [{"url": "...", "title": "...", "format": "...", "headings": ["..."], "wordCount": 0}],
 "consensus": ["..."], "entities": ["..."], "peopleAlsoAsk": ["..."], "gaps": ["..."],
 "angle": "...", "formatVerdict": "...", "sources": [{"title": "...", "url": "...", "usedFor": "..."}]}`;
}

/* ------------------------------------------------------ article: stage 2 */

export function outlinePrompt(
  brand: BrandContext,
  brief: ArticleBrief,
  serpIntel: unknown,
  playbook: string,
): string {
  const target = brief.targetWordCount ?? 1500;
  // One H2 per ~350 words, floored at four so a short piece still has shape.
  // Left to itself the outline fragments: sections proliferate, each too thin
  // to carry an idea, and the draft pads to fill them.
  const maxSections = Math.max(4, Math.round(target / 350));

  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## PLAYBOOK
${playbook}

${renderBrief(brief)}

## SERP INTELLIGENCE
${JSON.stringify(serpIntel, null, 2)}

## TASK
Design the outline that beats this SERP.

Requirements:
- Open with an answer-first lead: 100-150 words that directly answer "${brief.mainKeyword}" and would stand alone if an AI Overview quoted only that.
- Cover the consensus points, because omitting them reads as incomplete — but do not lead with them and do not spend the article's length on them.
- Build the middle around the gaps and the angle. This is where the article earns its ranking.
- Every H2 is a question people actually search, answered by the first sentence beneath it. A heading that only labels its contents cannot be lifted by an AI Overview.
- Cover every entity from the SERP intel somewhere in the structure.
- Include an FAQ section drawn from the PAA questions — minimum 3, only questions the body genuinely answers.
- Assign each section a word budget. The budgets must sum to roughly ${target}.
- **${maxSections} H2 sections at most**, and no section under 150 words. A previous outline split ${target} words across fourteen sections; each was too thin to say anything, the draft ran 68% over, and half the review's findings came from padding that existed only to fill them. Fewer sections that each earn their place.

For each section give: heading, level (2 or 3), intent (what this section must deliver), talkingPoints (3-6 specifics to hit — real substance, not topic labels), targetWords.

Also propose the final **title** (H1) and a **titleTag** of ≤60 characters.

Return JSON only:
{"title": "...", "titleTag": "...", "leadAnswer": "the 100-150 word answer-first opening, written out in full",
 "sections": [{"heading": "...", "level": 2, "intent": "...", "talkingPoints": ["..."], "targetWords": 0}],
 "faq": [{"question": "...", "answer": "one-sentence answer that the body will support"}]}`;
}

/* ------------------------------------------------------ article: stage 3 */

export function draftPrompt(
  brand: BrandContext,
  brief: ArticleBrief,
  outline: unknown,
  serpIntel: unknown,
  playbook: string,
): string {
  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## PLAYBOOK — follow every rule
${playbook}

${renderBrief(brief)}

## SERP INTELLIGENCE
${JSON.stringify(serpIntel, null, 2)}

## APPROVED OUTLINE
${JSON.stringify(outline, null, 2)}

## TASK
Write the full article in Markdown, following the outline exactly.

Hard requirements:
- The very first line is the H1. No YAML front matter, no \`---\` block, no title/description/slug/author lines — that metadata is written by a later stage and reads as body text if you put it here.
- After the H1, the answer-first lead. No preamble before the answer.
- Use the outline's headings verbatim, in order, at the levels given.
- Hit the section word budgets within about 15%.
- Write in ${brand.locale}, in the client's tone of voice.
- Cite external sources as inline Markdown links to the primary source. Never cite a statistic you cannot attribute.
- Include the internal links to the client's money pages, with descriptive anchors, placed where a reader would actually want them.
- Include at least one table or structured list where it genuinely helps.
- End with the FAQ section as H2 "Frequently Asked Questions", each question an H3.
- Return Markdown only. No raw HTML anywhere in the body: no \`<img>\`, no \`<script>\`, no \`<style>\`, no HTML comments, and no invented file paths like \`/img/something.webp\`.
- Do NOT insert images in any syntax, do NOT write a JSON-LD block, and do NOT write the title tag, slug or meta description into the body — even inside a comment. Images, schema and metadata are produced by later stages, and anything you write here is either deleted or published as visible text.
- Do NOT invent statistics, prices, dates, quotes or study findings.

Re-read section 11 of the playbook before you write, and again before you finish. The single fastest way to fail this task is to write competent, generic, machine-sounding prose.

Return JSON only:
{"bodyMdx": "the complete article in Markdown, starting with # H1",
 "externalSources": [{"title": "...", "url": "...", "usedFor": "..."}],
 "internalLinks": [{"anchor": "...", "url": "..."}]}`;
}

/* ------------------------------------------------------ article: stage 4 */

export function imagePlanPrompt(
  brand: BrandContext,
  brief: ArticleBrief,
  bodyMdx: string,
  inlineCount: number,
  availableAssets: { id: string; category: string | null; altText: string | null; tags: string[] }[],
  mode: "generate" | "brand_assets" | "mixed",
): string {
  const assetList = availableAssets.length
    ? availableAssets
        .map(
          (a) =>
            `- id=${a.id} category=${a.category ?? "-"} tags=[${a.tags.join(", ")}] description="${a.altText ?? "no description"}"`,
        )
        .join("\n")
    : "- none uploaded";

  const modeRule = {
    generate:
      "Every image must be generated. Do not select brand assets even if they fit.",
    brand_assets:
      "Every image must come from the brand assets listed. If none fit a slot, drop that slot rather than generating.",
    mixed:
      "Prefer a brand asset when one genuinely fits the slot; generate the rest.",
  }[mode];

  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## TASK
Plan 1 hero image and ${inlineCount} in-body images for this article.

${modeRule}

## AVAILABLE BRAND ASSETS
${assetList}

## ARTICLE
${bodyMdx}

Rules:
- Every image must carry information. No decorative filler, no generic stock-photo concepts, no "a person working on a laptop".
- Each in-body image belongs under a specific H2 from the article. Name that heading exactly as it appears.
- The hero sets the article's subject visually and is the one that shows in social shares.
- For generated images, write a prompt a text-to-image model can execute: subject, composition, lighting, setting, style. Say what is in frame. Do not ask for readable body text or logos — models render those badly. Short labels on a diagram are acceptable.
- Alt text: one sentence describing content and function. Not a keyword list, never starting with "image of".
- Filenames: lowercase, hyphenated, descriptive, no extension.

Return JSON only:
{"images": [{"role": "hero" | "inline", "position": 0, "source": "generated" | "brand_asset",
  "brandAssetId": "uuid or null", "prompt": "generation prompt or null",
  "placementHeading": "exact H2 text or null for hero",
  "altText": "...", "caption": "short caption or null", "filename": "..."}]}`;
}

/* ------------------------------------------------------ article: stage 5 */

export function qaPrompt(
  brand: BrandContext,
  brief: ArticleBrief,
  bodyMdx: string,
  failedChecks: { id: string; label: string; detail?: string }[],
  playbook: string,
): string {
  const failures = failedChecks.length
    ? failedChecks
        .map((c) => `- [${c.id}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`)
        .join("\n")
    : "- none";

  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## PLAYBOOK
${playbook}

${renderBrief(brief)}

## AUTOMATED CHECKS THAT FAILED
${failures}

## DRAFT
${bodyMdx}

## TASK
Review this draft the way you would review a junior writer's work before it goes to a paying client. Be specific and be tough.

Judge:
1. Every failed automated check above — each one is real and must be fixed.
2. **Differentiation** — does this say anything the top 10 does not? Name the sections that add nothing.
3. **Substance** — is any section padding? Which paragraphs survive deletion without loss?
4. **Machine tells** — quote every phrase matching playbook section 11.
5. **Accuracy** — any statistic, date, price or claim presented as fact without an attributable source.
6. **Entitlement to the claim** — playbook section 12, and mark every one of these \`high\`:
   - any fee, guarantee, result or term stated about the client that the Brand Vault does not contain;
   - any statement about the client's own contract, including no-win-no-fee phrasing;
   - any claim of fact about competitors, or about what happens to the audience, without a named source;
   - any number without a Brand Vault entry or a link;
   - a citation pointing at a summary where the primary text exists.
7. **Brand fit** — wrong tone, banned words, brand terms misspelled.
8. **Extraction** — could an AI Overview lift a clean answer from the opening? From each H2?

\`verdict\` is advisory — the pipeline decides from the findings, and a \`high\` forces a revision whatever the verdict says. Rate honestly rather than tactically.

Return JSON only:
{"verdict": "ship" | "revise",
 "issues": [{"severity": "high" | "medium" | "low", "note": "specific, quoting the offending text"}],
 "instructions": ["concrete rewrite instructions, ordered by importance"]}`;
}

/* ------------------------------------------------------ article: stage 6 */

export function revisePrompt(
  brand: BrandContext,
  bodyMdx: string,
  instructions: string[],
  playbook: string,
): string {
  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## PLAYBOOK
${playbook}

## REVISION INSTRUCTIONS
${instructions.map((i, n) => `${n + 1}. ${i}`).join("\n")}

## DRAFT
${bodyMdx}

## TASK
Apply every instruction and return the revised article.

While you are in there, do a final pass against playbook section 11: strip inflated significance, not-just-X-but-Y constructions, rule-of-three padding, vague attribution, empty transitions and promotional register. Vary sentence length. Cut any sentence that survives deletion.

Preserve: the heading structure, the internal and external links, the FAQ section, and every factual claim that was properly sourced. Do not shorten the article to avoid the work — fix the prose, keep the substance.

Return the body only, in Markdown. The first line is the H1 — no YAML front matter and no \`---\` block above it, and no raw HTML anywhere: no \`<img>\`, no \`<script>\`, no \`<style>\`, no HTML comments. If the draft you were given contains any of that, drop it; images, schema and metadata belong to other stages.

Return JSON only:
{"bodyMdx": "the complete revised article in Markdown", "appliedFixes": ["what you changed"]}`;
}

/* ------------------------------------------------------ article: stage 7 */

export function metaPrompt(
  brand: BrandContext,
  brief: ArticleBrief,
  title: string,
  bodyMdx: string,
): string {
  return `${SENIOR_SEO_IDENTITY}

${renderBrandContext(brand)}

## ARTICLE
Title: ${title}
Main keyword: ${brief.mainKeyword}

${bodyMdx}

## TASK
Write the search metadata.

- **titleTag**: ≤60 characters. Main keyword near the front. Must differ from the H1 — the H1 can be human, the title tag has to earn a click from a results page. Count the characters and stay under.
- **metaDescription**: 110-155 characters. Contains the main keyword. Written to earn the click, not to summarise. Count the characters.
- **slug**: lowercase, hyphenated, ≤75 characters, keyword-bearing, no stop-word padding.
- **faq**: the FAQ questions and answers as they appear in the body, for FAQPage schema. Only questions the body actually answers.
- **excerpt**: a 1-2 sentence summary for listing pages.

Return JSON only:
{"titleTag": "...", "metaDescription": "...", "slug": "...", "excerpt": "...",
 "faq": [{"question": "...", "answer": "..."}]}`;
}

/* ---------------------------------------------------------- site crawl */

export function siteCrawlPrompt(domain: string, maxPages: number): string {
  return `${SENIOR_SEO_IDENTITY}

## TASK
Study the website ${domain} and produce a brand profile for our content system.

Fetch the homepage first, then follow up to ${maxPages} of the most informative pages — about, products or services, pricing, category pages, a few blog posts. Use the sitemap if there is one.

Report what the site actually says, not what you assume about the industry. If something is not stated on the site, leave it out rather than filling it in.

Return JSON only:
{"businessDescription": "2-4 sentences on what this business does",
 "productsServices": "what they sell, specifically, including product categories and price points where stated",
 "icpAudience": "who they sell to, in their own framing",
 "toneOfVoice": "how they write: register, person, sentence style, vocabulary. Quote a representative line.",
 "usps": ["differentiators they claim"],
 "brandTerms": ["product names, trademarks and terms of art, spelled as the site spells them"],
 "ctaTargets": [{"label": "...", "url": "...", "useWhen": "when an article should link here"}],
 "contentThemes": ["topics their existing content covers"],
 "summary": "a compact briefing an SEO writer could work from cold"}`;
}
