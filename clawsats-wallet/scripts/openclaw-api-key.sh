#!/usr/bin/env bash
set -euo pipefail

SERVICE_FILE="${OPENCLAW_SERVICE_FILE:-/etc/systemd/system/openclaw.service}"
ROTATE="${1:-}"

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required." >&2
  exit 1
fi

if [[ ! -f "${SERVICE_FILE}" ]]; then
  echo "Service file not found: ${SERVICE_FILE}" >&2
  exit 1
fi

extract_key() {
  sudo sed -n 's/.*--api-key \([^[:space:]]*\).*/\1/p' "${SERVICE_FILE}" | head -n 1
}

generate_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -dc 'A-Za-z0-9_-'
  else
    node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
  fi
}

set_key_in_service() {
  local key="$1"
  sudo cp "${SERVICE_FILE}" "${SERVICE_FILE}.bak.$(date +%s)"
  if sudo grep -q -- '--api-key' "${SERVICE_FILE}"; then
    sudo sed -i -E "s/--api-key[[:space:]]+[^[:space:]]+/--api-key ${key}/" "${SERVICE_FILE}"
  else
    sudo sed -i -E "s#^(ExecStart=.*)$#\1 --api-key ${key}#" "${SERVICE_FILE}"
  fi
  sudo systemctl daemon-reload
  sudo systemctl restart openclaw
}

current_key="$(extract_key || true)"

if [[ "${ROTATE}" == "--rotate" ]] || [[ -z "${current_key}" ]]; then
  new_key="$(generate_key)"
  if [[ -z "${new_key}" ]]; then
    echo "Failed to generate API key." >&2
    exit 1
  fi
  set_key_in_service "${new_key}"
  current_key="${new_key}"
fi

echo "OPENCLAW_API_KEY=${current_key}"
echo "Health check:"
curl -sS http://127.0.0.1:3321/health || true
echo
