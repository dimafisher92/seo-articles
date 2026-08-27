# Quickstart — from nothing to a working system

Written for Windows, because that is where this is being set up. macOS and Linux
notes are inline where the commands differ.

The goal of this guide is to get the whole thing running **on your own machine
first** — web app and worker both local. That is the fastest way to see it work
and the easiest place to debug. Deploying to Vercel comes afterwards, once you
know the pieces fit.

Budget about 30 minutes, most of it waiting on installers and signups.

---

## What you will need

| | Why | Cost |
|---|---|---|
| **Node.js 20+** | Runs everything | free |
| **Git** | To clone the repository | free |
| **Neon** account | Postgres database | free tier is plenty |
| **Vercel** account | Image storage (Blob), and later the deployment | free tier |
| **Claude** subscription | Writes the articles | you have this |
| **Magnific** API key | Generates the images | prepaid credits |
| **SearchAtlas** API key | Keyword volume and rankings | your plan |

The last two are optional to *start*. Without SearchAtlas the keyword table has
no volume figures; without Magnific, articles use only the photos you upload.
Both are worth adding, but neither blocks a first run.

---

## 1. Install the tools

Open **PowerShell** (no admin needed) and run:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close PowerShell and open a **new** window — installers only update `PATH` for
new sessions.

Windows blocks PowerShell scripts by default, which stops `npm` from running at
all, so allow them for your own account first:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Answer `Y`. `RemoteSigned` lets scripts you wrote or installed locally run, and
still requires a signature on anything downloaded from the internet. It applies
to your user only, needs no elevation, and is the setting Microsoft documents
for development machines.

Now install pnpm:

```powershell
npm install -g pnpm@10
```

> The usual advice is `corepack enable pnpm`, but on Windows that writes a shim
> into `C:\Program Files\nodejs\` and fails with `EPERM: operation not
> permitted` unless PowerShell is running as Administrator. Installing through
> npm puts it under your own profile instead, so no elevation is needed. The
> `@10` pins the major version the lockfile was built with.

Check all three:

```powershell
node -v      # v20 or higher
pnpm -v
git --version
```

### Fixing `claude` is not recognized

You hit this already. `claude.exe` lives in `C:\Users\dimaf\.local\bin`, which
is not on your `PATH`. Add it permanently:

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";$HOME\.local\bin",
  "User"
)
```

Open a new PowerShell window and check:

```powershell
claude --version
```

---

## 2. Get the code

Clone it somewhere sensible — **not** into `.local\bin`, which is just where
the Claude binary happens to live:

```powershell
cd $HOME
mkdir projects -Force
cd projects
git clone https://github.com/dimafisher92/seo-articles.git
cd seo-articles
pnpm install
```

Every command from here on runs from this `seo-articles` folder. If a command
says "not recognized" or "no package.json", you are in the wrong directory —
`cd $HOME\projects\seo-articles` and try again.

---

## 3. Database

Go to <https://neon.tech> and sign up. On the "create your first project" screen:

- **Project name** — anything; `seo-articles` is fine.
- **Region** — leave the US East default. The latency that matters is between
  the app and the database, not between your laptop and the database: page
  loads are the sensitive part, and Vercel deploys functions to US East by
  default. The worker only does batch work and will not notice.
- **Services** — leave only **Postgres database** on. Object storage is not
  needed (images go to Vercel Blob), and neither is Neon Auth (sign-in is
  Auth.js).

Create the project, then copy the **pooled** connection string — the one with
`-pooler` in the hostname:

```
postgresql://neondb_owner:PASSWORD@ep-something-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
```

If the dialog shows a **Connection pooling** toggle, turn it on; otherwise find
it under Dashboard → Connection Details. This is not cosmetic: the app is
serverless, so every request opens a fresh connection, and without the pooler
the database runs out of connection slots under any real load. The code is
already written for a pooler (`prepare: false`), so a direct string works too —
it just fails later, under load, which is the worse way to find out.

The free tier's 0.5 GB is ample: only text and metadata live here, images are in
Blob. The database also scales to zero when idle, so the first query after a
pause takes a second or two — that is normal, not a fault.

You also want the **direct** string — the same URL *without* `-pooler`. Schema
migrations cannot run over PgBouncer, and when they try they fail in ways that
never mention pooling (`prepared statement "s0" already exists`, a `SET` that
does not survive its own transaction). `pnpm run configure` asks for both.

Create the tables:

```powershell
pnpm db:push
```

`pnpm run configure` already wrote the direct string into `apps\worker\.env`,
and `db:push` reads it from there. Setting `$env:DATABASE_URL_UNPOOLED` first
still works and takes priority — useful for pointing one run at a different
database.

You should see a list of `CREATE TABLE` statements ending in `[✓] Changes applied`.

### Or let the Neon CLI do it

If you would rather not copy strings by hand, the CLI writes both for you:

```powershell
npx neon@latest init --agent
npx neon@latest link      # pick org Dmitriy, project seo-articles
npx neon@latest env pull  # writes DATABASE_URL and DATABASE_URL_UNPOOLED
```

`link` stores the ids in a git-ignored `.neon` file, so later commands need no
`--project-id`.

## 4. Image storage

Article images and uploaded brand photos live in Vercel Blob. You can create the
store without deploying anything:

1. <https://vercel.com> → sign up → **Storage** → **Create Database** → **Blob**.
2. Open the store → `.env.local` tab → copy `BLOB_READ_WRITE_TOKEN`.

## 5. Claude token for the worker

This is what makes the worker bill your existing subscription instead of API
credits:

```powershell
claude setup-token
```

Follow the browser flow and copy the token it prints (it starts `sk-ant-oat01-`).

---

## 6. Configuration

Two files, neither committed. The quickest way is to let the setup script write
both:

```powershell
pnpm run configure
```

It asks for the values you collected above, generates the random secrets, and —
importantly — writes the *same* `WORKER_SECRET` into both files. That pairing is
how the worker proves it may claim jobs, and getting it wrong by hand surfaces
much later as an unexplained 401. Press Enter to skip anything you do not have
yet; it lists what is still missing at the end.

Then skip to step 7.

<details>
<summary>Writing the files by hand instead</summary>

### `apps\web\.env.local`

```powershell
notepad apps\web\.env.local
```

```ini
DATABASE_URL="postgresql://…-pooler….neon.tech/neondb?sslmode=require"
WORKER_SECRET="pick-any-long-random-string-and-reuse-it-below"
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_…"
CRON_SECRET="another-random-string"

# Local development only. Skips sign-in entirely so you do not need to set up
# Google OAuth just to look at the app. Never set this on Vercel.
AUTH_DISABLED="true"
AUTH_SECRET="any-random-string-will-do-locally"

# Optional — only needed for the "Sync from Notion" button.
NOTION_TOKEN=""
NOTION_CLIENTS_DATABASE_ID="483dbcc6-4b34-459e-be34-57c1f70383a6"
```

### `apps\worker\.env`

```powershell
notepad apps\worker\.env
```

```ini
APP_URL="http://localhost:3000"
WORKER_SECRET="the same string you used above"
DATABASE_URL="the same connection string as above"

CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-…"

# Optional — without it the keyword table has no volume or difficulty figures.
SEARCHATLAS_API_KEY=""

# Optional — without it, articles use only uploaded brand photos. See step 8.
MAGNIFIC_API_KEY=""
MAGNIFIC_IMAGE_MODEL="nano-banana-pro-flash"
```

`WORKER_SECRET` must be **identical** in both files — it is how the worker
proves to the app that it is allowed to claim jobs.

</details>

---

## 7. Run it

Two terminals, both in `seo-articles`.

**Terminal 1 — the app:**

```powershell
pnpm dev
```

Wait for `Ready`, then open <http://localhost:3000>. You should see the Clients
page.

**Terminal 2 — the worker:**

```powershell
pnpm worker
```

You should see:

```
Worker worker-1234 polling http://localhost:3000
Claude: subscription (OAuth token) · model claude-opus-5
Images: …
Queue empty — waiting for work
```

`Queue empty — waiting for work` is the good outcome. It means the worker
reached the app, authenticated, and is ready.

### First run through the product

1. **Add client** — name and website.
2. **Knowledge Base** → *Fill from website* to have Claude read their site, then
   fill in tone of voice, audience and competitors. This is what stops articles
   sounding generic, so it is worth the ten minutes.
3. Upload a few product photos. Mark one as **style reference**.
4. **Keyword Research** → *Run keyword research*. Watch the worker terminal.
5. Tick the keywords worth writing about → **Build content plan**.
6. On any title row → **Write article**. This takes 5-15 minutes.
7. Open the article, edit, export.

---

## 8. SearchAtlas keyword data

Put your key in `apps\worker\.env` as `SEARCHATLAS_API_KEY`, then find the
endpoint paths:

```powershell
pnpm searchatlas:probe
```

The adapter's paths are guesses — the SearchAtlas docs were unreachable where
this code was written. The probe reads the API's own schema if it publishes one,
otherwise tries candidates, and prints the env lines to paste back. Run it once;
without it, keyword runs may come back empty.

If only some endpoints resolve, ranked keywords is the one worth chasing —
without it there is no content gap analysis.

---

## 9. Magnific for images

Get an API key from the Magnific dashboard and put it in `apps\worker\.env` as
`MAGNIFIC_API_KEY` (or answer the question in `pnpm run configure`). Then verify it:

```powershell
pnpm magnific:probe
```

This is worth doing before your first article. The adapter's endpoints come from
Magnific's published reference but were never exercised against the live API
where this code was written, so the probe runs the whole round trip from your
machine and reports whether the shipping code understood the response. It asks
before spending credits.

Expected ending:

```
Verdict: the adapter is compatible with the live API.
```

If it reports a mismatch, send the output — it prints the raw responses so the
field names can be corrected.

Restart the worker and it should print:

```
Images: Magnific · Nano Banana 2 (Gemini 3.1 Flash)
```

### A note on cost

The default model, Nano Banana 2, is the best of the three and also the dearest
— up to about $0.30 an image at 4K. At four images an article that adds up. The
alternatives are in `apps\worker\.env`:

```ini
MAGNIFIC_IMAGE_MODEL="flux-dev"   # roughly a twentieth the cost
```

None of them are free. The free 20-images-a-day tier is the website, is
watermarked, and is personal-use only, so it will not do for client work.

Without a key at all, articles use only the photos you uploaded to the Brand
Vault — which is a perfectly reasonable way to work.

---

## 10. Deploying to Vercel

Only worth doing once the local run works end to end.

1. <https://vercel.com/new> → import `dimafisher92/seo-articles`.
2. **Root Directory**: `apps/web`.
3. Environment variables: everything from `apps\web\.env.local` **except**
   `AUTH_DISABLED` — never set that on a public URL.
4. Add real Google OAuth instead:
   - <https://console.cloud.google.com> → Credentials → OAuth client ID → Web.
   - Authorised redirect URI: `https://<your-app>.vercel.app/api/auth/callback/google`
   - Set `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and
     `ALLOWED_EMAIL_DOMAINS` to your agency's domain.
5. Connect the Blob store you made in step 4 to this project.
6. Deploy.

Then point the worker at it — change one line in `apps\worker\.env`:

```ini
APP_URL="https://<your-app>.vercel.app"
```

Restart the worker. It now serves the deployed app, while still running on your
machine and billing your Claude subscription.

---

## Troubleshooting

**`pnpm : The term 'pnpm' is not recognized`**
Node is not installed, or you did not open a new terminal after installing it.
Run `npm install -g pnpm@10` in a fresh window.

**`npm : File ...\npm.ps1 cannot be loaded because running scripts is disabled`**
PowerShell's execution policy is blocking it. Run
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` and
answer `Y`. To avoid changing the policy at all, call the batch shims instead —
`npm.cmd`, `pnpm.cmd` — though you would then need `.cmd` on every such command.

**`corepack enable pnpm` fails with `EPERM: operation not permitted`**
Corepack writes into `C:\Program Files\nodejs\`, which needs Administrator
rights. Use `npm install -g pnpm@10` instead — it installs under your own
profile and needs no elevation.

**`no package.json here`**
You are in the wrong folder. `cd $HOME\projects\seo-articles`.

**`claude : The term 'claude' is not recognized`**
See the `PATH` fix in step 1.

**Worker says `Poll failed ... ECONNREFUSED`**
The app is not running, or `APP_URL` is wrong. Start `pnpm dev` first.

**Worker says `401` when claiming**
`WORKER_SECRET` differs between the two env files.

**`DATABASE_URL is not set`**
The worker reads `apps\worker\.env`; the app reads `apps\web\.env.local`. Check
you edited the right one, and that you restarted after editing.

**A job sits at `queued` forever**
The worker is not running. Start it — the job will be picked up.

**A job is stuck at `running` after a crash**
Start the worker: the claim endpoint requeues jobs whose worker went silent for
10 minutes, and it does that on the next poll. If the worker cannot be started,
clear it by hand:

```sql
update jobs set status = 'queued', claimed_by = null where status = 'running';
```
