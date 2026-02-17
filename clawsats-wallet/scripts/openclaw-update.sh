#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SELF_DIR}/../.." && pwd)"
WALLET_DIR="${REPO_ROOT}/clawsats-wallet"

echo "Updating ClawSats repo at ${REPO_ROOT}"
cd "${REPO_ROOT}"
git fetch origin
git checkout main
git pull --ff-only

echo "Installing wallet deps + build"
cd "${WALLET_DIR}"
npm ci
npm run build

echo "Ensuring API key + autopilot services"
bash scripts/openclaw-api-key.sh
bash scripts/openclaw-autopilot.sh

echo "Restarting services"
sudo systemctl daemon-reload
sudo systemctl restart openclaw openclaw-watch
sudo systemctl status openclaw openclaw-watch --no-pager -l | sed -n '1,50p'

echo "Done. Current commit:"
cd "${REPO_ROOT}"
git rev-parse --short HEAD
