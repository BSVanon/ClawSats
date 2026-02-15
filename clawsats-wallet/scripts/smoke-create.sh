#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

cd "${TMP_DIR}"

node "${ROOT_DIR}/dist/cli/index.js" create --name smoke-claw --chain test --storage sqlite >/dev/null
node "${ROOT_DIR}/dist/cli/index.js" config --config config/wallet-config.json >/dev/null

echo "Wallet create/config smoke test passed."
