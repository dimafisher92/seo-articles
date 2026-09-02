# Running the worker on a VPS

The worker is the half that generates: it holds the Claude subscription token,
talks to SearchAtlas and Magnific, and writes finished articles to the
database. On a laptop that means generation stops whenever the laptop does. On
a server it does not.

Nothing about the pipeline changes. The worker **pulls** work over HTTPS, so
the server needs no inbound ports, no public hostname and no certificate — only
SSH, which it already has.

Written for Debian/Ubuntu, which is what Contabo installs by default.

---

## Two things to know first

Both are easy to get wrong in a way that looks like something else.

- **Do not run `pnpm run configure` on the server.** It mints a fresh
  `WORKER_SECRET`, which would stop matching the one set in Vercel, and every
  request the worker makes would come back 401 — an authentication failure that
  reads like a broken deployment. Copy the existing `apps/worker/.env` instead.
- **That `.env` is the whole keyring**: the Claude subscription token, the
  Magnific and SearchAtlas keys, and the database password inside the Neon
  connection string. Whoever can read the file can spend all of it. It ends up
  `0600`, owned by the service user, and it never goes into git.

If any of those keys have been pasted somewhere they should not have been,
rotate them before they land on another machine.

---

## 1. A user for the service

```bash
ssh root@<your-vps-ip>

adduser --disabled-password --gecos '' seo
```

The home directory matters: the Claude Agent SDK keeps state under `$HOME`.

## 2. Node and pnpm

```bash
apt update && apt install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
corepack enable

node -v    # v22.x
pnpm -v    # 10.x — corepack reads the version from package.json
```

No browser, no Chrome, no display. The research stage runs its searches through
Anthropic's own tools rather than a local browser.

## 3. The repository

The repo is private, so the server gets its own read-only key rather than your
GitHub credentials.

```bash
su - seo
ssh-keygen -t ed25519 -C "contabo-seo-worker" -f ~/.ssh/id_ed25519 -N ''
cat ~/.ssh/id_ed25519.pub
```

Paste that public key into the repository on GitHub under **Settings → Deploy
keys → Add deploy key**. Leave "Allow write access" unchecked — the server only
ever reads.

```bash
exit                                    # back to root
mkdir -p /opt/seo-articles && chown seo:seo /opt/seo-articles
su - seo -c "git clone git@github.com:dimafisher92/seo-articles.git /opt/seo-articles"
```

## 4. The environment file

From the machine that runs the worker today, in PowerShell:

```powershell
scp apps\worker\.env seo@<your-vps-ip>:/opt/seo-articles/apps/worker/.env
```

Then name this worker, so the queue records which machine took a job:

```bash
sudo -u seo sed -i 's/^WORKER_ID=.*/WORKER_ID="contabo"/' /opt/seo-articles/apps/worker/.env
```

With `WORKER_ID` absent the worker uses the machine's hostname, which is also
fine. What is not fine is two machines calling themselves the same thing.

If the Claude token turns out not to work from the server, mint a new one
there: `claude setup-token` prints a URL you open in your own browser, and the
result goes into `CLAUDE_CODE_OAUTH_TOKEN`.

## 5. Install the service

```bash
cd /opt/seo-articles
bash deploy/install-worker.sh          # as root, or with sudo
```

It checks the prerequisites, installs dependencies, locks down the `.env`,
writes the systemd unit and starts it. Re-running it is safe.

```bash
journalctl -u seo-worker -f
```

It is working when the log reads:

```
Worker contabo polling https://<your-app>.vercel.app
Claude: subscription (OAuth token)
Queue empty — waiting for work
```

## 6. Stop the worker on your PC

Two workers will not corrupt the queue — jobs are claimed with `FOR UPDATE SKIP
LOCKED`, so they take different ones — but they share one subscription rate
limit and make the logs ambiguous about which machine did what. Close the
`pnpm worker` window.

---

## Living with it

**Updating after a change:**

```bash
ssh seo@<your-vps-ip>
cd /opt/seo-articles && sudo bash deploy/update-worker.sh
```

The restart is graceful. The worker finishes the article it is holding before
it exits — which is why the unit allows fifty minutes to stop — so deploying
during a generation costs waiting, not the article.

`update-worker.sh` hard-resets to the remote branch, so an edit made on the
server is discarded rather than quietly becoming the running code. The `.env`
is untracked and survives.

**Everyday commands:**

```bash
systemctl status seo-worker           # is it up
journalctl -u seo-worker -f           # follow the log
journalctl -u seo-worker --since -1h  # what happened
systemctl restart seo-worker          # graceful
systemctl stop seo-worker             # pause generation entirely
```

**Schema changes** (`pnpm db:push`) still run from your PC against the same
database. The server does not run migrations; it only needs the new code.

**A stuck job** needs nothing clever: stop or restart the worker. After ten
minutes of silence the app requeues the job for whichever worker asks for work
next, up to its attempt limit. Nothing is lost by restarting.

**Cost is unchanged.** The subscription is billed per account rather than per
machine, and Magnific per image. The VPS is the only new line.
