#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_SERVICE_FILE="${OPENCLAW_SERVICE_FILE:-/etc/systemd/system/openclaw.service}"
OPENCLAW_WATCH_SERVICE_FILE="${OPENCLAW_WATCH_SERVICE_FILE:-/etc/systemd/system/openclaw-watch.service}"
OPENCLAW_WATCH_ENV_FILE="${OPENCLAW_WATCH_ENV_FILE:-/etc/default/openclaw-watch}"
OPENCLAW_WATCH_INTERVAL="${OPENCLAW_WATCH_INTERVAL:-60}"
CLAWSATS_DIRECTORY_URL="${CLAWSATS_DIRECTORY_URL:-https://clawsats.com/api/directory}"

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required." >&2
  exit 1
fi

if [[ ! -f "${OPENCLAW_SERVICE_FILE}" ]]; then
  echo "OpenClaw service file not found: ${OPENCLAW_SERVICE_FILE}" >&2
  echo "Create openclaw.service first, then run this script." >&2
  exit 1
fi

read_setting() {
  local key="$1"
  sudo awk -F= -v key="${key}" '$1 == key {print $2; exit}' "${OPENCLAW_SERVICE_FILE}" | tr -d '\r'
}

RUN_AS_USER="$(read_setting "User")"
WORKDIR="$(read_setting "WorkingDirectory")"
NODE_BIN="$(sudo awk -F= '/^ExecStart=/{print $2; exit}' "${OPENCLAW_SERVICE_FILE}" | awk '{print $1}')"

if [[ -z "${RUN_AS_USER}" ]]; then
  RUN_AS_USER="${SUDO_USER:-$USER}"
fi
if [[ -z "${WORKDIR}" ]]; then
  WORKDIR="$(pwd)"
fi
if [[ -z "${NODE_BIN}" ]] || [[ ! -x "${NODE_BIN}" ]]; then
  NODE_BIN="/usr/bin/node"
fi

if [[ ! -f "${WORKDIR}/dist/cli/index.js" ]]; then
  echo "Cannot find ${WORKDIR}/dist/cli/index.js" >&2
  echo "Run npm run build in ${WORKDIR} first." >&2
  exit 1
fi

if [[ ! "${OPENCLAW_WATCH_INTERVAL}" =~ ^[0-9]+$ ]] || [[ "${OPENCLAW_WATCH_INTERVAL}" -lt 10 ]]; then
  echo "OPENCLAW_WATCH_INTERVAL must be an integer >= 10" >&2
  exit 1
fi

echo "Configuring OpenClaw autopilot..."
echo "  Wallet service: ${OPENCLAW_SERVICE_FILE}"
echo "  Watch service:  ${OPENCLAW_WATCH_SERVICE_FILE}"
echo "  User:           ${RUN_AS_USER}"
echo "  Working dir:    ${WORKDIR}"
echo "  Node:           ${NODE_BIN}"
echo "  Interval:       ${OPENCLAW_WATCH_INTERVAL}s"
echo "  Directory API:  ${CLAWSATS_DIRECTORY_URL}"

sudo tee "${OPENCLAW_WATCH_ENV_FILE}" >/dev/null <<EOF
# OpenClaw peer-discovery daemon configuration.
# Edit this file, then run:
#   sudo systemctl restart openclaw-watch
OPENCLAW_WATCH_INTERVAL=${OPENCLAW_WATCH_INTERVAL}
CLAWSATS_DIRECTORY_URL=${CLAWSATS_DIRECTORY_URL}
EOF

sudo cp "${OPENCLAW_WATCH_SERVICE_FILE}" "${OPENCLAW_WATCH_SERVICE_FILE}.bak.$(date +%s)" 2>/dev/null || true
sudo tee "${OPENCLAW_WATCH_SERVICE_FILE}" >/dev/null <<EOF
[Unit]
Description=OpenClaw Peer Discovery Daemon
After=network-online.target openclaw.service
Wants=network-online.target openclaw.service
PartOf=openclaw.service

[Service]
Type=simple
User=${RUN_AS_USER}
WorkingDirectory=${WORKDIR}
Environment=NODE_ENV=production
EnvironmentFile=-${OPENCLAW_WATCH_ENV_FILE}
ExecStart=${NODE_BIN} ${WORKDIR}/dist/cli/index.js watch --config config/wallet-config.json --interval \${OPENCLAW_WATCH_INTERVAL} --directory-url \${CLAWSATS_DIRECTORY_URL}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-watch
sudo systemctl restart openclaw-watch

echo
echo "openclaw-watch status:"
sudo systemctl status openclaw-watch --no-pager -l | sed -n '1,40p'

echo
echo "Recent openclaw-watch logs:"
sudo journalctl -u openclaw-watch -n 40 --no-pager || true

echo
echo "Autopilot is enabled."
echo "Config file: ${OPENCLAW_WATCH_ENV_FILE}"
