# SEO Article Generator

An internal tool for producing brand-aware SEO articles for agency clients.

The workflow is deliberately sequential, and the app enforces it:

```
Client (Brand Vault)
   → Keyword Research + Content Gap        [button]
   → Content Plan — titles and briefs only [button]
   → Write this article                    [button, one row at a time]
   → Edit, score, export
```

Nothing is written before the research exists, and no article body is generated
until a human has read its brief and pressed the button on that row.

---

## Architecture

The system is split across two deployments because the Claude Agent SDK on a
subscription needs a long-lived Node process with the `claude` binary, which a
Vercel function cannot provide — and a single article takes 5-15 minutes.

```
┌──────────────── Vercel ────────────────┐        ┌──── Your machine ────┐
│  Next.js — UI, API routes, job queue   │        │  worker (Node)       │
│  Postgres · Vercel Blob                │◄───────┤  Claude Agent SDK    │
└────────────────────────────────────────┘  HTTPS │  SearchAtlas         │
                                            (poll) │  Magnific            │
                                                   └──────────────────────┘
```

The worker **pulls** work rather than being pushed to. That means:

- it runs behind NAT with no tunnel, no white IP, no open ports;
- jobs queue harmlessly while the machine is asleep;
- **the Claude subscription token never reaches Vercel's environment** — it
  lives only on the machine running the worker.

Queue coordination goes over HTTP; bulk domain data (hundreds of keyword rows,
a full article body) is written straight to Postgres by the worker, which
already holds the connection.

### Layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js app — deploys to Vercel |
| `apps/worker` | The generation worker — runs on your machine |
| `packages/db` | Drizzle schema and migrations |
| `packages/shared` | Job contracts, provider interfaces, SEO checks, rendering |
| `packages/seo` | The SEO playbook (editable Markdown) and prompt builders |

---

## Setup

**Starting from nothing?** [`docs/QUICKSTART.md`](docs/QUICKSTART.md) walks
through it step by step on Windows — installing Node, cloning, the database,
and running the app and worker locally before deploying anything. The section
below assumes you already have the stack and want the short version.

### 1. Database

Any Postgres works — Neon, Supabase, or a local container. Use the **pooled**
connection string on serverless providers.

```bash
pnpm install
pnpm run configure   # writes both env files, asks for both strings
pnpm db:push         # reads DATABASE_URL_UNPOOLED from apps/worker/.env
```

Migrations use the **direct** connection; the app and worker use the **pooled**
one (`DATABASE_URL`). Schema tools need session state, which PgBouncer in
transaction mode does not have, and running them pooled fails without ever
naming pooling as the cause. `neon env pull` writes both strings.

### 2. Vercel

Deploy `apps/web`. Set the environment variables from `.env.example` under the
"apps/web" heading, plus `DATABASE_URL` and `WORKER_SECRET`.

- **Blob storage** — add the Vercel Blob integration; it sets
  `BLOB_READ_WRITE_TOKEN` for you.
- **Google OAuth** — callback is `https://<your-app>/api/auth/callback/google`.
  Set `ALLOWED_EMAIL_DOMAINS` to your agency domain. With neither that nor
  `ALLOWED_EMAILS` set, sign-in is refused outright rather than left open.
- **Stale-job recovery** — no cron needed. Jobs abandoned by a worker that died
  mid-run are requeued by `/api/worker/claim`, which sweeps for them whenever a
  worker asks for work. `/api/cron/reap` still exists to run the same sweep by
  hand (or on a schedule, if you are on a plan that allows a useful one); set
  `CRON_SECRET` if you want to call it.

### 3. Claude credentials for the worker

The worker bills the existing Claude subscription rather than API credits:

```bash
claude setup-token      # mint a long-lived OAuth token
```

Put the result in the worker's `CLAUDE_CODE_OAUTH_TOKEN`. Setting
`ANTHROPIC_API_KEY` instead switches to metered API billing — useful during a
burst, when subscription rate limits would otherwise stall a batch. Set one or
the other, never both.

### 4. Run the worker

```bash
cp .env.example apps/worker/.env   # fill in APP_URL, WORKER_SECRET, keys
pnpm worker
```

It polls, claims one job at a time, and reports progress back. Jobs run
strictly sequentially: article generation is token-heavy and a subscription's
rate limit is shared, so running two at once just means both stalling on
backoff instead of one finishing.

---

## The providers

### SearchAtlas — keyword data

Every volume, difficulty and ranking figure the app displays comes from here.
The model is never asked to estimate them; a plausible invented number is worse
than an empty cell, because a strategist will act on it.

Without `SEARCHATLAS_API_KEY` the pipeline still runs — it clusters keywords and
finds content gaps from live SERPs — but leaves the volume and difficulty
columns blank and says so in the UI.

**Find the real endpoint paths before the first run:**

```bash
pnpm searchatlas:probe
```

The `X-API-Key` header and the base URL are confirmed, but the exact paths were
not readable where this code was written — `docs.searchatlas.com` and
`api.searchatlas.com` are both unreachable from there. The paths in
`apps/worker/src/providers/searchatlas.ts` are therefore educated guesses, and
every one is overridable via `SEARCHATLAS_PATH_*` precisely because they were
expected to need correcting.

The probe does the correcting from a machine that can reach the API. It reads
the OpenAPI manifest if one is published — authoritative, no guessing — and
otherwise tries candidate paths against all four capabilities. Either way it
prints the exact env lines to paste into `apps/worker/.env`:

```
SEARCHATLAS_PATH_METRICS="/v2/keywords/overview"
SEARCHATLAS_PATH_RANKED="/v2/domains/ranked-keywords"
```

Ranked keywords is the one to chase if only some resolve: without it there is no
content gap analysis. Missing metrics costs the volume column but clustering
still works.

Response field names are read tolerantly, so a naming difference degrades to a
null rather than a crash.

### Magnific — image generation

Magnific is the rebranded Freepik platform. Set `MAGNIFIC_API_KEY` from its
dashboard and that is the whole setup — `api.freepik.com` accepts the same key
if you ever need to switch hosts, and the auth header follows the base URL.

**Run the probe once before the first real generation:**

```bash
pnpm magnific:probe
```

The endpoint paths and request bodies come from Magnific's published API
reference, but could not be exercised where this code was written — the network
there blocks `api.magnific.com`. The probe performs the whole round trip from a
machine that can reach it, prints exactly what came back, and says whether the
shipping adapter understood it. A field-name difference then surfaces in two
minutes rather than part-way through writing an article.

#### Choosing a model

`MAGNIFIC_IMAGE_MODEL` picks one, and it is pinned rather than chosen per image
so cost stays predictable and a client's articles share one visual language.

| Slug | Model | Roughly |
|---|---|---|
| `nano-banana-pro-flash` | **Nano Banana 2** (Gemini 3.1 Flash) — the default | up to ~$0.30/image at 4K |
| `mystic` | Magnific's own | ~$0.069/image at 1K |
| `flux-dev` | the cheap one | ~$0.012/image |

At four images an article that is a real spread — worth a look at the bill
before generating in bulk. Switching is one line in `apps/worker/.env`.

None of these are free. The free 20-images-a-day tier is the website, is
watermarked, and is licensed for personal use, so it cannot be used for client
work. The API bills prepaid credits; pay-per-usage was discontinued in June 2026.

Each model takes its style reference differently — Mystic wants a
`style_reference` URL and an adherence weight, the Gemini-backed models want
`reference_images` entries carrying an image, a description and a MIME type.
That is why `MODELS` in `apps/worker/src/providers/magnific.ts` is a registry
where each entry builds its own request body, rather than a table of paths.

The **style reference** itself is the setting worth caring about: nominate one
Brand Vault image and generated imagery matches its palette, lighting and
treatment. Without one, results look like generic stock.

Without `MAGNIFIC_API_KEY`, articles use only the photos uploaded to the Brand
Vault. That is a supported way to work, not a failure.

---

## How an article gets written

Eight stages, each a separate schema-validated call rather than one long agentic
run — so stages are individually retryable, their output is inspectable, and a
weak draft can be re-run without paying for a fresh SERP crawl.

1. **SERP intel** — reads the live top 10: format, consensus, entities, PAA, and
   what none of them do.
2. **Outline** — an answer-first lead plus a structure built around the gap.
3. **Draft** — written in the brand's voice, to the section word budgets.
4. **QA** — reviewed against the playbook and the failing automated checks.
5. **Revise** — applies the fixes and strips the machine tells.
6. **Metadata** — title tag, meta description, slug, FAQ, JSON-LD.
7. **Images** — hero plus 2-3 in-body, generated through Magnific or picked
   from the vault.
8. **Assemble** — images placed under their planned headings, final scoring.

### Tuning the output

`packages/seo/content/playbook.md` is the house style: what ranking means in
2026, answer-first structure, writing for extraction, E-E-A-T, differentiation,
schema, image rules, and a section on the phrasings that mark AI text. It is
injected into every prompt and used as the QA checklist.

**Edit that file to change how the system writes — no code change needed.**

Per-client `contentGuidelines` in the Brand Vault are appended after it and
override it where they conflict.

---

## Development

```bash
pnpm run configure          # write both env files
pnpm dev            # Next.js on :3000
pnpm worker         # the worker
pnpm magnific:probe # verify image generation against the live API
pnpm searchatlas:probe # discover the keyword endpoints
pnpm typecheck      # every package
pnpm db:studio      # browse the database
DATABASE_URL="postgres://…" pnpm smoke   # test suite
```

`AUTH_DISABLED=true` bypasses sign-in for local work against a throwaway
database. Never set it on Vercel.

### The smoke test

`scripts/smoke.ts` covers the parts that only break against a real database —
the atomic job claim under concurrency, the partial unique index behind the
style reference, cascade deletes, and the stale-job reaper — plus the pure
logic: content-gap detection, keyword scoring, the SEO rubric, and rendering.

It needs a live Postgres and creates and removes its own rows.

---

## Operational notes

- **Subscription rate limits.** A batch of articles will hit them. The worker
  backs off exponentially and retries; it does not fail the job. `CLAUDE_MODEL`
  and `CLAUDE_FAST_MODEL` let you put the mechanical stages (clustering) on a
  cheaper model than the writing.
- **The worker is a single point of failure for generation.** Jobs are never
  lost, but they stop moving when the machine is off. If that becomes a problem,
  the same worker runs unchanged on a small VPS.
- **A job whose worker vanishes** is requeued after 10 minutes of silence, up
  to `maxAttempts`. The sweep runs on the claim endpoint, so the rescue happens
  the moment a worker next asks for work rather than on a schedule — Vercel's
  Hobby plan allows only one cron run per day, which would have meant waiting
  up to twenty-four hours.
