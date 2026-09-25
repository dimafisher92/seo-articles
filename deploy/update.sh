#!/usr/bin/env bash
#
# Pulls the latest code, rebuilds the app, and restarts both services.
#
#   sudo bash deploy/update.sh
#
# One script rather than one per service: two commands you have to remember to
# run both of is a deployment that is half old and half new, and the half that
# gets forgotten is whichever you changed less.
#
# The worker restart is graceful — it finishes the article it is holding before
# it exits, which is why its unit allows fifty minutes to stop. A deploy during
# a generation costs waiting, not the article. The app comes back in seconds.

set -euo pipefail

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

# Only when the app is actually installed here: the worker can still be run on
# its own machine, and rebuilding an app nobody serves wastes two minutes.
if systemctl list-unit-files seo-web.service >/dev/null 2>&1 &&
   systemctl is-enabled seo-web >/dev/null 2>&1; then
  echo "  … building the app"
  su - "${RUN_AS}" -c "cd '${ROOT}' && pnpm --filter @seo/web build" >/dev/null
  systemctl restart seo-web
  echo "  … app restarted"
fi

echo "  … restarting the worker (waits for the current article to finish)"
systemctl restart seo-worker

echo
systemctl --no-pager --lines=0 status seo-worker seo-web 2>/dev/null || true
echo
echo "  Now at: $(su - "${RUN_AS}" -c "cd '${ROOT}' && git log --oneline -1")"
echo
