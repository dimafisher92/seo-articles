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
| **Magnific** account | Generates the images | credits |
| **SearchAtlas** API key | Keyword volume and rankings | your plan |

The last two are optional to *start*. Without SearchAtlas the keyword table has
no volume figures; without Magnific articles use only uploaded photos. Both are
worth adding, but neither blocks a first run.

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

Go to <https://neon.tech>, sign up, create a project. On the dashboard copy the
**pooled** connection string — it has `-pooler` in the hostname and looks like:

```
postgresql://user:pass@ep-something-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

Create the tables:

```powershell
$env:DATABASE_URL="<paste the connection string>"
pnpm db:push
```

You should see a list of `CREATE TABLE` statements ending in `[✓] Changes applied`.

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
pnpm setup
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

# Images come from Magnific's MCP server; see step 8. No key needed here.
MAGNIFIC_TRANSPORT="mcp"
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

## 8. Magnific for images

Register the MCP server globally, then authenticate:

```powershell
claude mcp add --transport http magnific https://mcp.magnific.com --scope user
```

`--scope user` matters: without it the server is only visible inside whatever
directory you happened to be in. If you already added it with the default local
scope, clean that up first:

```powershell
claude mcp remove magnific --scope local
```

Registering is not the same as authenticating. Start a Claude Code session, run
`/mcp`, pick `magnific`, and complete the browser sign-in.

Restart the worker. It should now print:

```
Images: Magnific over MCP
```

The OAuth token is stored globally in `C:\Users\dimaf\.claude\.credentials.json`,
keyed by the server name and URL — not by directory — so once you have signed in
anywhere, the worker picks it up.

If it instead says `needs-auth`, the name or URL does not match what the worker
declares. It must be exactly `magnific` and `https://mcp.magnific.com`, with no
trailing slash.

---

## 9. Deploying to Vercel

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
On Vercel a cron requeues it after 10 minutes. Running locally there is no cron,
so clear it by hand:

```sql
update jobs set status = 'queued', claimed_by = null where status = 'running';
```
