#!/usr/bin/env bash
#
# Installs the worker as a systemd service. Idempotent: safe to re-run.
#
#   sudo bash deploy/install-worker.sh
#
# Deliberately does not install Node, pnpm or the repository. A script that
# quietly apt-installs a runtime is a script nobody can read before running as
# root; this one checks and tells you what is missing. docs/VPS.md has the
# commands.

set -euo pipefail

SERVICE=seo-worker
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
  die "No user '${RUN_AS}'. Create it first: adduser --disabled-password --gecos '' ${RUN_AS}"
ok "user ${RUN_AS}"

HOME_DIR="$(getent passwd "${RUN_AS}" | cut -d: -f6)"
[[ -d "${HOME_DIR}" ]] || die "${RUN_AS} has no home directory; the Agent SDK needs one."

command -v node >/dev/null || die "node is not installed. See docs/VPS.md."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node ${NODE_MAJOR} is too old; the worker needs 20 or newer."
ok "node $(node -v)"

command -v pnpm >/dev/null || die "pnpm is not installed. Run: corepack enable"
ok "pnpm $(pnpm -v)"

ENV_FILE="${ROOT}/apps/worker/.env"
[[ -f "${ENV_FILE}" ]] ||
  die "${ENV_FILE} does not exist. Copy it from the machine that runs the worker now — do NOT run \`pnpm run configure\` here, it mints a fresh WORKER_SECRET and the app would reject this worker."

# The file holds the Claude subscription token, both provider keys and the
# database password. Anyone who can read it can spend all three.
chown "${RUN_AS}:${RUN_AS}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
ok ".env locked to ${RUN_AS} (0600)"

grep -q '^APP_URL=' "${ENV_FILE}"       || die "APP_URL is missing from .env"
grep -q '^WORKER_SECRET=' "${ENV_FILE}" || die "WORKER_SECRET is missing from .env"

echo "  … installing dependencies"
chown -R "${RUN_AS}:${RUN_AS}" "${ROOT}"
su - "${RUN_AS}" -c "cd '${ROOT}' && pnpm install --frozen-lockfile" >/dev/null
ok "dependencies installed"

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
echo "  Watch it come up:"
echo "    journalctl -u ${SERVICE} -f"
echo
echo "  It is working when the log says: Queue empty — waiting for work"
echo
