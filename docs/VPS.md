# Running the whole thing on one server

App, worker and database on a single VPS. Nothing else is needed: no Vercel
deployment, no managed Postgres.

This started as a worker-only runbook, and moved here after a free-tier
database paused itself mid-month and took the app down with it. The layout it
describes is also simply smaller: Postgres listens on localhost and is not
reachable from the internet at all, the worker talks to the app over
`127.0.0.1`, and one command deploys both services.

The only thing still hosted elsewhere is **Vercel Blob**, which stores article
images. Its token works from any machine, so nothing changes — but do not
delete the Vercel project, because deleting it deletes the store and every
image in it.

Written for Debian/Ubuntu, which is what Contabo installs by default.

```
┌──────────────────── your VPS ────────────────────┐
│  Caddy :443  ──►  Next.js 127.0.0.1:3000         │      ┌──────────────┐
│                     │                             │      │ Vercel Blob  │
│                     ▼                             │◄────►│  (images)    │
│  Postgres 127.0.0.1:5432                          │      └──────────────┘
│                     ▲                             │
│  worker ────────────┘  (polls 127.0.0.1:3000)     │
└───────────────────────────────────────────────────┘
```

---

## Before you start

**Three things are on you, and the rest will not work without them:**

- A **subdomain** — say `seo.example.com` — with an A record pointing at the
  VPS IP. Caddy needs it resolving before it can get a certificate.
- **Ports 80 and 443** open. Port **5432 stays closed**; the database is
  reachable only from the machine itself, which is the main reason this layout
  is safe to run.
- **Google OAuth**: add `https://seo.example.com/api/auth/callback/google` to
  the Authorized redirect URIs in the Google console.

Two things to know, because both are easy to get wrong in a way that looks like
something else:

- **Do not run `pnpm run configure` on the server.** It mints a fresh
  `WORKER_SECRET`. The app and the worker have to share one, and when they stop
  matching every worker request comes back 401 — an authentication failure that
  reads like a broken deployment.
- **The env files are the whole keyring**: the Claude subscription token, the
  Magnific and SearchAtlas keys, the database password, the Google client
  secret. They end up `0600`, owned by the service user, and never in git.

---

## 1. A user for the services

```bash
ssh root@<your-vps-ip>       # or: ssh <you>@<ip> then sudo -i
id -u                        # must print 0

adduser --disabled-password --gecos '' seo
```

No password and no sudo is correct for a service account — you administer it
from root. A home directory matters: the Claude Agent SDK keeps state under
`$HOME`.

## 2. Node, pnpm, Postgres, Caddy

```bash
apt update && apt install -y curl git ca-certificates postgresql
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
corepack enable

# Caddy, from its own repository
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

node -v && pnpm -v && psql --version && caddy version
```

No browser and no display. The research stage runs its searches through
Anthropic's own tools rather than a local browser.

## 3. The database

```bash
DB_PASSWORD="$(openssl rand -hex 24)"
su - postgres -c "psql -c \"create role seo login password '${DB_PASSWORD}'\""
su - postgres -c "createdb -O seo seo_articles"
echo "DATABASE_URL=postgres://seo:${DB_PASSWORD}@127.0.0.1:5432/seo_articles"
```

Copy that last line — it goes into both env files below. Generate the password
on the machine and never paste it into a chat window.

Leave `listen_addresses` alone. The default is localhost, which is exactly
what this needs:

```bash
su - postgres -c "psql -c 'show listen_addresses'"   # localhost
```

## 4. The repository

The repo is private, so the server gets its own read-only key.

```bash
su - seo
ssh-keygen -t ed25519 -C "seo-server" -f ~/.ssh/id_ed25519 -N ''
ssh-keyscan github.com >> ~/.ssh/known_hosts
ssh-keygen -lf ~/.ssh/known_hosts      # check the ed25519 fingerprint against
                                       # GitHub's published one before going on
cat ~/.ssh/id_ed25519.pub
```

Paste that public key into the repository on GitHub under **Settings → Deploy
keys → Add deploy key**, leaving "Allow write access" unchecked.

```bash
exit                                   # back to root
mkdir -p /opt/seo-articles && chown seo:seo /opt/seo-articles
su - seo -c "git clone git@github.com:dimafisher92/seo-articles.git /opt/seo-articles"
```

`ssh -T git@github.com` as `seo` should answer *"successfully authenticated,
but GitHub does not provide shell access"* — that is success, despite the
"but".

## 5. Environment files

Two of them. `apps/web/.env.local`:

```bash
cat > /opt/seo-articles/apps/web/.env.local <<'ENV'
DATABASE_URL="postgres://seo:PASSWORD@127.0.0.1:5432/seo_articles"
WORKER_SECRET="<openssl rand -hex 32>"

AUTH_SECRET="<openssl rand -base64 32>"
AUTH_URL="https://seo.example.com"
AUTH_TRUST_HOST="true"
AUTH_GOOGLE_ID="<from the Google console>"
AUTH_GOOGLE_SECRET="<from the Google console>"
ALLOWED_EMAILS="you@example.com,colleague@example.com"

BLOB_READ_WRITE_TOKEN="<from the Vercel Blob store>"
ENV
```

`AUTH_URL` and `AUTH_TRUST_HOST` are the two that Vercel did not need. Vercel
supplied the URL through `VERCEL_URL`; here nothing can infer it, and Auth.js
builds the OAuth callback out of it. `AUTH_TRUST_HOST` is what lets Auth.js
believe the `Host` header that arrived through Caddy — without it sign-in fails
in a way that reads like wrong OAuth credentials.

Never put `AUTH_DISABLED` in this file. It bypasses sign-in entirely.

Then `apps/worker/.env` — copy `apps/worker/.env.example` and fill in the same
`DATABASE_URL` and the **same `WORKER_SECRET`**, plus the Claude, SearchAtlas
and Magnific keys. `APP_URL` is `http://127.0.0.1:3000`: the app is on this
machine, so the queue never leaves it.

## 6. Schema, then the services

```bash
cd /opt/seo-articles
chown -R seo:seo /opt/seo-articles
su - seo -c "cd /opt/seo-articles && pnpm install --frozen-lockfile"
su - seo -c "cd /opt/seo-articles && pnpm db:push"     # answer yes

bash deploy/install-web.sh
bash deploy/install-worker.sh
```

Both scripts check their prerequisites and refuse rather than guessing. If the
service user is not called `seo`, prefix both with
`SEO_WORKER_USER=<name>`.

```bash
curl -I http://127.0.0.1:3000          # 200 or 307
journalctl -u seo-web -f
journalctl -u seo-worker -f
```

The worker is up when it says:

```
Worker <hostname> polling http://127.0.0.1:3000
Claude: subscription (OAuth token)
Queue empty — waiting for work
```

## 7. Caddy

```bash
cp /opt/seo-articles/deploy/Caddyfile.example /etc/caddy/Caddyfile
sed -i 's/seo.gsmgrowthagency.com/seo.example.com/' /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -n 30
```

Caddy gets and renews the certificate itself, which is why it is here rather
than nginx plus certbot plus a renewal cron.

Open `https://seo.example.com`. You should get the sign-in page.

## 8. Check the door is shut

From your own machine, not the server:

```bash
nc -zv <your-vps-ip> 5432    # must fail: connection refused or timeout
```

If that connects, Postgres is exposed to the internet and the password is the
only thing between it and everyone. Fix it before going further.

---

## Living with it

**Deploying a change:**

```bash
ssh root@<your-vps-ip>
cd /opt/seo-articles && bash deploy/update.sh
```

One command for both services. It pulls, installs, rebuilds the app, restarts
it, then restarts the worker — gracefully, so the worker finishes the article
it is holding. A deploy during a generation costs waiting, not the article.

It hard-resets to the remote branch, so an edit made on the server is discarded
rather than quietly becoming the running code. The env files are untracked and
survive.

**Schema changes** now run here too, since the database is local:

```bash
su - seo -c "cd /opt/seo-articles && pnpm db:push"
```

**Everyday commands:**

```bash
systemctl status seo-web seo-worker
journalctl -u seo-worker -f            # follow the worker
journalctl -u seo-web --since -1h      # what the app did
systemctl restart seo-worker           # graceful
systemctl stop seo-worker              # pause generation, keep the app up
```

**Backups are yours now.** This is the one thing the managed database was doing
for free:

```bash
su - postgres -c "pg_dump seo_articles" | gzip > /root/seo-$(date +%F).sql.gz
```

33 MB of clients, brand vaults, keyword research and finished articles
compresses to very little. Worth a nightly cron and a copy off the machine —
a VPS is one failed disk away from losing all of it, and Neon was quietly
handling that.

**A stuck job** needs nothing clever: stop or restart the worker. After ten
minutes of silence the app requeues the job for whichever worker asks next.
There is also a Stop button on any running job in the app.

**Costs** are the VPS plus Magnific credits. The Claude subscription is billed
per account, not per machine.
