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

### 1. Database

Any Postgres works — Neon, Supabase, or a local container. Use the **pooled**
connection string on serverless providers.

```bash
pnpm install
DATABASE_URL="postgres://…" pnpm db:push
```

### 2. Vercel

Deploy `apps/web`. Set the environment variables from `.env.example` under the
"apps/web" heading, plus `DATABASE_URL` and `WORKER_SECRET`.

- **Blob storage** — add the Vercel Blob integration; it sets
  `BLOB_READ_WRITE_TOKEN` for you.
- **Google OAuth** — callback is `https://<your-app>/api/auth/callback/google`.
  Set `ALLOWED_EMAIL_DOMAINS` to your agency domain. With neither that nor
  `ALLOWED_EMAILS` set, sign-in is refused outright rather than left open.
- **Cron** — `vercel.json` registers `/api/cron/reap` every 10 minutes. It
  rescues jobs whose worker went away mid-run. Set `CRON_SECRET`.

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

> **Verify the endpoint paths before the first run.** The `X-API-Key` header and
> the existence of the keyword endpoints are confirmed, but the exact paths were
> not readable from the build environment. They are declared in one block at the
> top of `apps/worker/src/providers/searchatlas.ts` and every one is overridable
> via `SEARCHATLAS_PATH_*`, so a correction needs no code change. Check them
> against <https://docs.searchatlas.com> once your key is in hand. Response
> field names are read tolerantly, so a naming difference degrades to a null
> rather than a crash.

### Magnific — image generation

`POST /v1/ai/mystic` returns a task id; the worker polls until it completes,
then the app copies the bytes into Blob storage (the provider URL expires).

The **style reference** is the important part: nominate one Brand Vault image
as the style reference and Magnific matches its palette, lighting and treatment.
Without one, generated images look like generic stock.

Without `MAGNIFIC_API_KEY`, articles fall back to the client's uploaded photos.

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
7. **Images** — hero plus 2-3 in-body, generated or picked from the vault.
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
pnpm dev            # Next.js on :3000
pnpm worker         # the worker
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
- **A job whose worker vanishes** is requeued by the cron reaper after 10
  minutes of silence, up to `maxAttempts`.
