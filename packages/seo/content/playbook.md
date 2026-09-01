# SEO Blog Playbook — 2026

This file is injected verbatim into every article-generation prompt and used as
the checklist for the QA stage. Edit it to change how the system writes; no code
change is needed.

Per-client `contentGuidelines` from the Brand Vault are appended after this file
and **override** anything here when the two conflict.

---

## 1. What ranking means now

Ranking is no longer only about being the tenth blue link. A page has to work in
three places at once:

1. **Classic organic results** — relevance, authority, experience.
2. **AI Overviews and AI-mode answers** — the page has to be *extractable*: a
   model must be able to lift one self-contained passage and cite it.
3. **LLM recall** — when someone asks an assistant for a recommendation in this
   category, the brand should be one of the names that comes back.

Every rule below serves at least one of those three.

## 2. Intent before keywords

- Determine what the searcher actually wants *before* writing, from the live
  SERP, not from assumptions. If the top 10 are all comparison tables, a
  narrative essay will not rank no matter how well written.
- Match the **format** the SERP rewards: listicle, comparison, how-to, definition,
  buying guide.
- Keyword *density* is not a target. Do not repeat the main keyword to hit a
  count. Cover the topic and the exact phrase will appear naturally.
- Cover the **entities** the topic requires — the people, products, standards,
  and concepts a domain expert would necessarily mention. Entity coverage is a
  far stronger relevance signal than repetition.

## 3. Answer-first structure

- The first 100-150 words must answer the query directly. No throat-clearing, no
  "In today's fast-paced world", no restating the question back at the reader.
- The opening paragraph should be liftable on its own: if a model quotes only
  that paragraph, the answer is still correct and still useful.
- Then, and only then, expand into nuance, caveats and depth.

## 4. Write for extraction

An H2 is a question, and the sentence directly under it is the answer. Not a
label, not a teaser — the question a reader would type, answered before any
elaboration. A heading like "A $90,000 settlement: the subtraction no advert
shows you" answers nothing and cannot be lifted; "How does the contract change
what you actually receive?" can.

The opening sentence of the article is the one an AI Overview quotes. Keep it
under forty words and make it answer the title. Six claims and three statutory
references in one sentence is not a strong opening, it is an unliftable one.

- Paragraphs of 2-4 sentences. Nothing over 120 words.
- Put discrete facts — specs, prices, steps, criteria — in tables or lists, not
  buried in prose.
- Each section should stand alone. A reader arriving from a jump link should not
  need the previous section for context.

## 5. E-E-A-T: experience first

- **Experience** is the hardest signal to fake and the most valuable. Include
  specifics only someone who has done the thing would know: numbers, edge cases,
  what went wrong, what to do instead.
- Attribute the article to the client's author persona from the Brand Vault, with
  their real credentials.
- Cite external sources for every statistic, standard, or claim of fact. Link to
  the primary source — the original study, the official documentation, the
  standards body — not to another blog summarising it.
- Never invent statistics, dates, prices, or quotes. If a number cannot be
  verified from a source, do not use it.
- Be explicit about uncertainty rather than papering over it.

## 6. Differentiation

The top 10 already agree with each other. Repeating their consensus earns
nothing. Every article must carry at least one of:

- an angle the SERP is missing,
- original data, a worked example, or a real scenario,
- a clear point of view with reasoning behind it,
- practical detail the others hand-wave past.

If a section says nothing the top 10 do not already say, cut it.

## 7. On-page mechanics

| Element | Rule |
|---|---|
| Title tag | ≤ 60 characters, main keyword near the front, not a copy of the H1 |
| H1 | One only, may be longer and more human than the title tag |
| Meta description | 110-155 characters, contains the keyword, written to earn the click |
| Slug | Lowercase, hyphenated, ≤ 75 chars, keyword-bearing, no stop-word padding |
| H2/H3 | Real hierarchy, no skipped levels, no heading used purely for styling |
| Body | ≥ 4 H2 sections; length set by what the topic needs, not by a word quota |

## 8. Internal linking

- At least 2 internal links to the client's money pages, chosen from the Brand
  Vault CTA targets.
- Descriptive anchors that describe the destination. Never "click here", never a
  bare URL, never the same anchor twice pointing to different pages.
- Place links where they genuinely help the reader's next step, not clustered in
  a block at the end.

## 9. Structured data

Every article ships with:

- `BlogPosting` — headline, description, author (the persona), datePublished,
  image, mainEntityOfPage.
- `FAQPage` — only for questions genuinely answered in the body, minimum 3.
- `BreadcrumbList` — site → blog → article.

Schema must describe what is actually on the page. Marking up an FAQ that does
not appear in the body is a manual-action risk.

## 10. Images

- One hero (16:9) plus 2-3 in-body images placed where they explain something.
- Decorative stock filler adds nothing. Each image should carry information: a
  diagram, a comparison, a product in context, a labelled process.
- Alt text describes the image's content and function in one sentence. It is not
  a keyword dumping ground, and it is not "image of".
- Descriptive filenames, WebP, explicit width/height, lazy-load everything below
  the fold.
- Generated imagery must match the brand's visual language via the Brand Vault
  style reference.

## 11. Language: do not write like a language model

These are the tells that mark AI text. Rewrite anything matching them.

- **Inflated significance** — "stands as a testament to", "plays a vital role",
  "underscores its importance", "a rich tapestry".
- **The not-just-X-but-Y construction** — "It's not just a tool, it's a
  revolution." Cut it every time.
- **Rule-of-three padding** — "efficient, scalable, and robust" where one
  accurate adjective would do.
- **Vague attribution** — "industry experts say", "studies show", "it is widely
  regarded". Name the source or delete the claim.
- **Empty transitions** — "Moreover", "Furthermore", "In conclusion", "It is
  important to note that".
- **Promotional register** in editorial content — "cutting-edge", "seamless",
  "game-changing", "unlock the power of".
- **Negative parallelism** — "It isn't about X. It's about Y."
- **Em-dash pile-ups** and sentences that never commit to a verb.

Write in active voice. Prefer concrete nouns. Vary sentence length — a
paragraph of uniformly medium sentences reads as machine-made even when every
sentence is fine on its own. Cut any sentence that survives deletion without
loss of meaning.

## 12. Claims you are not entitled to make

Every rule below was broken by a real article before it was written down. They
are absolute: a piece that breaks one is held back, however good the rest is.

**Nothing about the client that is not in the Brand Vault.** Fee percentages,
guarantees, response times, case results, years in business. An article invented
a fee ladder — "33⅓% before filing, around 40% in litigation, up to 45% on
appeal" — where the Vault said "25% to 40%". The number was plausible, specific,
and made up, which is the worst combination: nobody rereads a figure that looks
researched. If the Vault does not say it, the article does not either. Write
around the gap or leave the sentence out.

**No statement about the client's own contract or terms.** "If we do not win,
you do not pay" is a claim about a document you have not read. Where a fee
arrangement is regulated — legal, medical, financial — a claim of no-cost
service must also address what the client owes for expenses, and an article that
implies otherwise while criticising rivals for the same silence is worse than
one that stays quiet.

**No claims of fact about competitors, and none about the audience.** "Many
Spanish-language adverts are lead-capture networks that hand the case to another
firm." "It happens to Spanish-speaking victims more than anyone." Either cite a
source or delete the sentence. Vague attribution — *many*, *most*, *studies
show* — is not a source. This is both a credibility rule and, in regulated
sectors, a legal one.

**Every number carries its source.** Statistics, dates, prices, statutory
limits, percentages. Either it is in the Brand Vault, or it has a link to where
it came from. A number with neither is removed, not softened.

**Cite the primary text, not a summary of it.** A rule of professional conduct
links to the bar association's own text, not to a law firm's blog about it. A
statute links to the statute. If a consumer guide is easier to read, link the
statute and say what it means in your own words.

## 13. Freshness

- Reference the current year only when the content is genuinely time-sensitive.
- Never claim data is current unless it was verified in this run.
- Prefer durable framing over dated framing where the substance is stable.
