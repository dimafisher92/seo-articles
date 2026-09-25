#!/usr/bin/env bash
#
# Installs the Next.js app as a systemd service. Idempotent.
#
#   sudo bash deploy/install-web.sh
#
# Assumes Postgres, Node and pnpm are already there — docs/VPS.md has those
# steps. Like install-worker.sh, this checks and tells you rather than
# apt-installing a runtime under a root prompt nobody read.

set -euo pipefail

SERVICE=seo-web
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${SERVICE}.service"
ROOT="$(cd "$(dirname "${UNIT_SRC}")/.." && pwd)"

RUN_AS="${SEO_WORKER_USER:-seo}"

die() { echo "  ✖ $*" >&2; exit 1; }
ok()  { echo "  ✔ $*"; }

echo
echo "Installing the ${SERVICE} service from ${ROOT}"
echo

[[ $EUID -eq 0 ]] || die "Run this with sudo — it writes to /etc/systemd/system."

id -u "${RUN_AS}" >/dev/null 2>&1 ||
  die "No user '${RUN_AS}'. Set SEO_WORKER_USER=<name>, or create it."
ok "user ${RUN_AS}"

# The repository already belongs to someone. If that is not the user we are
# about to install for, stop: the chown below would take it away from them —
# and on this machine that means the worker loses the deploy key it pulls with,
# which surfaces later as a deploy that cannot fetch.
OWNER="$(stat -c '%U' "${ROOT}")"
if [[ "${OWNER}" != "${RUN_AS}" && "${OWNER}" != "root" ]]; then
  die "${ROOT} belongs to '${OWNER}', but this would install for '${RUN_AS}' and chown it away from them. Re-run as: SEO_WORKER_USER=${OWNER} bash ${BASH_SOURCE[0]}"
fi
ok "repository belongs to ${OWNER}"

HOME_DIR="$(getent passwd "${RUN_AS}" | cut -d: -f6)"
[[ -d "${HOME_DIR}" ]] || die "${RUN_AS} has no home directory."

command -v node >/dev/null || die "node is not installed. See docs/VPS.md."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node ${NODE_MAJOR} is too old; the app needs 20 or newer."
ok "node $(node -v)"

command -v pnpm >/dev/null || die "pnpm is not installed. Run: corepack enable"
ok "pnpm $(pnpm -v)"

ENV_FILE="${ROOT}/apps/web/.env.local"
[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} does not exist. docs/VPS.md lists what goes in it."

for name in DATABASE_URL WORKER_SECRET AUTH_SECRET AUTH_URL AUTH_TRUST_HOST; do
  grep -q "^${name}=" "${ENV_FILE}" || die "${name} is missing from .env.local"
done

# Without one of these nobody can sign in at all, which is the safe default but
# a confusing way to discover a typo.
grep -qE '^(ALLOWED_EMAILS|ALLOWED_EMAIL_DOMAINS)=.+' "${ENV_FILE}" ||
  die "Neither ALLOWED_EMAILS nor ALLOWED_EMAIL_DOMAINS is set — every sign-in would be refused."

grep -q '^AUTH_DISABLED=' "${ENV_FILE}" &&
  die "AUTH_DISABLED is in .env.local. That is local-development only and would leave this open to anyone."

chown "${RUN_AS}:${RUN_AS}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
ok ".env.local locked to ${RUN_AS} (0600)"

chown -R "${RUN_AS}:${RUN_AS}" "${ROOT}"

echo "  … installing dependencies"
su - "${RUN_AS}" -c "cd '${ROOT}' && pnpm install --frozen-lockfile" >/dev/null
ok "dependencies installed"

echo "  … building (a minute or two)"
su - "${RUN_AS}" -c "cd '${ROOT}' && pnpm --filter @seo/web build" >/dev/null
ok "built"

sed -e "s|__USER__|${RUN_AS}|g" \
    -e "s|__ROOT__|${ROOT}|g" \
    -e "s|__HOME__|${HOME_DIR}|g" \
    "${UNIT_SRC}" > "/etc/systemd/system/${SERVICE}.service"
ok "unit written to /etc/systemd/system/${SERVICE}.service"

systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null
systemctl restart "${SERVICE}"
ok "service started"

echo
echo "  It is listening on 127.0.0.1:3000 — Caddy is what the internet sees."
echo "    curl -I http://127.0.0.1:3000"
echo "    journalctl -u ${SERVICE} -f"
echo
