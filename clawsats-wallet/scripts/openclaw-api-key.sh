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
  local tmp_file backup_file
  tmp_file="${SERVICE_FILE}.tmp.$$"
  backup_file="${SERVICE_FILE}.bak.$(date +%s)"
  sudo cp "${SERVICE_FILE}" "${backup_file}"
  if ! sudo awk -v key="${key}" '
    BEGIN { updated = 0 }
    /^ExecStart=/ {
      if ($0 ~ /--api-key[[:space:]]+/) {
        sub(/--api-key[[:space:]]+[^[:space:]]+/, "--api-key " key);
      } else {
        $0 = $0 " --api-key " key;
      }
      updated = 1;
    }
    { print }
    END {
      if (updated == 0) {
        print "No ExecStart= line found in service file." > "/dev/stderr";
        exit 2;
      }
    }
  ' "${SERVICE_FILE}" | sudo tee "${tmp_file}" >/dev/null; then
    sudo rm -f "${tmp_file}"
    echo "Failed updating ${SERVICE_FILE}; original kept at ${backup_file}" >&2
    exit 1
  fi
  sudo mv "${tmp_file}" "${SERVICE_FILE}"
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
echo "Health check (retry up to 15s):"
ok=0
for _ in {1..15}; do
  if health="$(curl -fsS http://127.0.0.1:3321/health 2>/dev/null)"; then
    echo "${health}"
    ok=1
    break
  fi
  sleep 1
done
if [[ "${ok}" -eq 0 ]]; then
  curl -sS http://127.0.0.1:3321/health || true
fi
echo
