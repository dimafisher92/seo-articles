#!/usr/bin/env bash
#
# Pulls the latest code and restarts the worker.
#
#   sudo bash deploy/update-worker.sh
#
# The restart is graceful: the worker finishes the article it is holding before
# it exits, which is why the unit allows fifty minutes to stop. A deploy during
# a generation costs waiting, not the article.

set -euo pipefail

SERVICE=seo-worker
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_AS="${SEO_WORKER_USER:-seo}"

[[ $EUID -eq 0 ]] || { echo "  ✖ Run this with sudo." >&2; exit 1; }

# Whatever was cloned, rather than a hardcoded "main" that may not exist in
# this repository. Override with SEO_WORKER_BRANCH to move the server to a
# different branch.
BRANCH="${SEO_WORKER_BRANCH:-$(su - "${RUN_AS}" -c "cd '${ROOT}' && git rev-parse --abbrev-ref HEAD")}"

echo
# A hard reset, so a half-finished edit made on the server does not silently
# survive a deploy and make the running code something nobody has read. The
# .env is untracked and unaffected.
echo "  … fetching ${BRANCH}"
su - "${RUN_AS}" -c "cd '${ROOT}' && git fetch origin '${BRANCH}' && git checkout '${BRANCH}' && git reset --hard 'origin/${BRANCH}'"

echo "  … installing dependencies"
su - "${RUN_AS}" -c "cd '${ROOT}' && pnpm install --frozen-lockfile" >/dev/null

echo "  … restarting (waits for the current article to finish)"
systemctl restart "${SERVICE}"

echo
systemctl --no-pager --lines=0 status "${SERVICE}" || true
echo
echo "  Now at: $(su - "${RUN_AS}" -c "cd '${ROOT}' && git log --oneline -1")"
echo
