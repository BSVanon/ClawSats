#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${1:-http://127.0.0.1:3321}"
SERVICE_FILE="${OPENCLAW_SERVICE_FILE:-/etc/systemd/system/openclaw.service}"
API_KEY="${OPENCLAW_API_KEY:-}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COURSES_DIR="${CLAWSATS_COURSES_DIR:-${ROOT_DIR}/courses}"

if [[ -z "${API_KEY}" ]] && [[ -f "${SERVICE_FILE}" ]]; then
  API_KEY="$(sudo sed -n 's/.*--api-key \([^[:space:]]*\).*/\1/p' "${SERVICE_FILE}" | head -n 1 || true)"
fi

if [[ -z "${API_KEY}" ]]; then
  echo "OPENCLAW_API_KEY not set and no --api-key found in ${SERVICE_FILE}" >&2
  echo "Set OPENCLAW_API_KEY or run: bash scripts/openclaw-api-key.sh" >&2
  exit 1
fi

if [[ ! -d "${COURSES_DIR}" ]]; then
  echo "Courses directory not found: ${COURSES_DIR}" >&2
  exit 1
fi

node - "${ENDPOINT}" "${API_KEY}" "${COURSES_DIR}" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [endpointRaw, apiKey, coursesDir] = process.argv.slice(2);
const endpoint = endpointRaw.replace(/\/$/, '');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function loadLocalCourses(dir) {
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const map = new Map();
  for (const file of entries) {
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.id && Array.isArray(parsed.quiz)) {
      map.set(parsed.id, parsed);
    }
  }
  return map;
}

async function rpc(method, params = {}) {
  const res = await fetch(`${endpoint}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    })
  });

  const body = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${body.slice(0, 240)}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(parsed)}`);
  }
  if (parsed.error) {
    throw new Error(`${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

function buildAnswers(course) {
  const answers = [];
  for (const q of (course.quiz || [])) {
    if (!Array.isArray(q.options) || !q.correctHash) {
      answers.push('');
      continue;
    }
    const match = q.options.find((opt) => sha256Hex(opt) === q.correctHash) || '';
    answers.push(match);
  }
  return answers;
}

async function main() {
  const localCourses = loadLocalCourses(coursesDir);
  console.log(`Loaded ${localCourses.size} local course files from ${coursesDir}`);

  let totalPassed = 0;
  let rounds = 0;
  while (rounds < 20) {
    rounds += 1;
    const state = await rpc('listCourses', {});
    const ready = (state.courses || []).filter((c) => c.prerequisitesMet && !c.completed);

    if (ready.length === 0) {
      console.log('No ready incomplete courses remain.');
      break;
    }

    let progressed = false;
    for (const c of ready) {
      const local = localCourses.get(c.id);
      if (!local) {
        console.log(`Skip ${c.id}: local file missing`);
        continue;
      }
      const answers = buildAnswers(local);
      if (answers.some((a) => !a)) {
        console.log(`Skip ${c.id}: could not derive all answers from local quiz hash data`);
        continue;
      }

      const result = await rpc('takeCourse', {
        courseId: c.id,
        answers
      });

      if (result.passed) {
        totalPassed += 1;
        progressed = true;
        console.log(`PASS ${c.id}: ${result.correct}/${result.total} (${Math.round((result.score || 0) * 100)}%)`);
      } else {
        console.log(`FAIL ${c.id}: ${result.correct}/${result.total} (${Math.round((result.score || 0) * 100)}%)`);
      }
    }

    if (!progressed) {
      console.log('No additional courses passed this round; stopping.');
      break;
    }
  }

  const finalState = await rpc('listCourses', {});
  const completed = (finalState.courses || []).filter((c) => c.completed).length;
  const total = finalState.totalAvailable || (finalState.courses || []).length;
  console.log(`Completed courses: ${completed}/${total}. Newly passed this run: ${totalPassed}.`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
NODE
