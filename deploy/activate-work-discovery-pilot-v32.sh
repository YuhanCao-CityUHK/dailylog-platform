#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_ID="20260902-daily-assistant-work-discovery-v32"
PILOT_USERID="example-user-4"
APP_DIR="/opt/dailylog/app"
MARKER="/opt/dailylog/DEPLOYED_HOTFIX"
BACKUP_DIR="/opt/dailylog/backups/activate-${RELEASE_ID}"
LOCK_FILE="/var/lock/dailylog-deploy.lock"
LOCAL_BASE="http://127.0.0.1:8100"
PUBLIC_BASE="https://dailylog.vivolightsales.com"
LEGACY_BASE="https://dailyreport.vivolightsales.com"
ACTIVATION_LOG_SINCE=""
ACTIVATION_JOURNAL_CURSOR=""
MUTATED=0

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-30}"
  local i
  for ((i=1; i<=attempts; i+=1)); do
    if curl -fsS --max-time 5 "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "health check failed: $url" >&2
  return 1
}

activation_logs() {
  if [[ -n "$ACTIVATION_JOURNAL_CURSOR" ]]; then
    journalctl -u dailylog --after-cursor="$ACTIVATION_JOURNAL_CURSOR" --no-pager
  else
    journalctl -u dailylog --since "$ACTIVATION_LOG_SINCE" --no-pager
  fi
}

rollback_activation() {
  trap - ERR INT TERM HUP
  set +e
  local rc=0
  if [[ -f "$BACKUP_DIR/ACTIVATION_ROLLBACK_COMPLETED" ]]; then
    echo "pilot activation rollback already completed" >&2
    return 0
  fi
  echo "pilot activation failed; restoring the disabled rollout" >&2
  install -o dailylog -g dailylog -m 0600 "$BACKUP_DIR/.env" "$APP_DIR/.env" || rc=1
  install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX" "$MARKER" || rc=1
  systemctl restart dailylog || rc=1
  wait_for_url "$LOCAL_BASE/healthz" 30 || rc=1
  wait_for_url "$LOCAL_BASE/readyz" 30 || rc=1
  systemctl is-active --quiet dailyreport || rc=1
  wait_for_url "$LEGACY_BASE/healthz" 15 || rc=1
  if [[ "$rc" -ne 0 ]]; then
    echo "CRITICAL: disabled rollout did not recover cleanly" >&2
    return 1
  fi
  touch "$BACKUP_DIR/ACTIVATION_ROLLBACK_COMPLETED"
  echo "pilot activation rolled back" >&2
}

on_error() {
  local rc="$1"
  local line="$2"
  local command="$3"
  trap - ERR INT TERM HUP
  echo "activation error: rc=$rc line=$line command=$command" >&2
  if [[ "$MUTATED" == "1" && -d "$BACKUP_DIR" ]]; then
    rollback_activation || exit 99
  fi
  exit "$rc"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
trap 'on_error 130 "$LINENO" "signal:INT"' INT
trap 'on_error 143 "$LINENO" "signal:TERM"' TERM
trap 'on_error 129 "$LINENO" "signal:HUP"' HUP

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "another dailylog deployment holds $LOCK_FILE" >&2
  exit 1
}

grep -qx "release=${RELEASE_ID}" "$MARKER"
grep -qx "work_discovery=installed-disabled" "$MARKER"
test -f "$APP_DIR/.env"
test ! -e "$BACKUP_DIR"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport

# The marker and runtime configuration must describe the same disabled state,
# otherwise the saved rollback image would not be a known-safe baseline.
(
  cd "$APP_DIR"
  sudo -u dailylog node --import tsx --input-type=module <<'TS'
import { CONFIG } from "./src/infra/config.ts";
if (CONFIG.assistant.workDiscoveryEnabled !== false) {
  throw new Error("pre-activation work discovery state is not disabled");
}
if (CONFIG.assistant.workDiscoveryPilotUserids.length !== 0) {
  throw new Error("pre-activation work discovery pilot list is not empty");
}
TS
)

install -d -o root -g root -m 0700 "$BACKUP_DIR"
install -o root -g root -m 0600 "$APP_DIR/.env" "$BACKUP_DIR/.env"
install -o root -g root -m 0644 "$MARKER" "$BACKUP_DIR/DEPLOYED_HOTFIX"
cmp -s "$APP_DIR/.env" "$BACKUP_DIR/.env"
cmp -s "$MARKER" "$BACKUP_DIR/DEPLOYED_HOTFIX"
MUTATED=1

set_env_value "$APP_DIR/.env" "DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED" "1"
set_env_value "$APP_DIR/.env" "DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS" "$PILOT_USERID"
set_env_value "$APP_DIR/.env" "DAILY_ASSISTANT_WORK_DISCOVERY_MAX_CANDIDATES" "50"
chown dailylog:dailylog "$APP_DIR/.env"
chmod 0600 "$APP_DIR/.env"

(
  cd "$APP_DIR"
  sudo -u dailylog node --import tsx --input-type=module <<'TS'
import { CONFIG, validateConfig } from "./src/infra/config.ts";
const expected = "example-user-4";
const problems = validateConfig();
if (problems.length > 0) throw new Error(`configuration invalid: ${problems.join("; ")}`);
if (!CONFIG.llm.enabled || !CONFIG.llm.primary.apiKey) throw new Error("real LLM is unavailable");
if (!CONFIG.assistant.workDiscoveryEnabled) throw new Error("work discovery is not enabled");
if (CONFIG.assistant.workDiscoveryPilotUserids.length !== 1
  || CONFIG.assistant.workDiscoveryPilotUserids[0] !== expected) {
  throw new Error("pilot scope must contain only the approved employee");
}
if (CONFIG.assistant.workDiscoveryMaxCandidates !== 50) throw new Error("candidate limit mismatch");
console.log(JSON.stringify({ enabled: true, pilotCount: 1, maxCandidates: 50, llmReady: true }));
TS
)

ACTIVATION_LOG_SINCE="$(date --iso-8601=seconds)"
if ! ACTIVATION_JOURNAL_CURSOR="$(
  journalctl -u dailylog -n 1 --show-cursor --no-pager \
    | sed -n 's/^-- cursor: //p' \
    | tail -1
)"; then
  echo "failed to capture the pre-restart journal cursor" >&2
  false
fi
systemctl restart dailylog
wait_for_url "$LOCAL_BASE/healthz" 30
wait_for_url "$LOCAL_BASE/readyz" 30
systemctl is-active --quiet dailyreport
wait_for_url "$PUBLIC_BASE/healthz" 15
wait_for_url "$PUBLIC_BASE/readyz" 15
wait_for_url "$LEGACY_BASE/healthz" 15
test "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/api/daily-assistant/context/status")" = "401"

if ! ACTIVATION_LOGS="$(activation_logs)"; then
  echo "failed to read post-activation dailylog journal" >&2
  false
fi
if grep -E '"evt":"(request_error|assistant_[^"]*_failed|config_warning)"' <<< "$ACTIVATION_LOGS"; then
  echo "new dailylog errors detected after pilot activation" >&2
  false
fi

sed "s/^work_discovery=.*/work_discovery=pilot:${PILOT_USERID}/" "$MARKER" > "$BACKUP_DIR/DEPLOYED_HOTFIX.activated"
printf 'work_discovery_activated_at=%s\n' "$(date --iso-8601=seconds)" >> "$BACKUP_DIR/DEPLOYED_HOTFIX.activated"
install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX.activated" "$MARKER"
grep -qx "release=${RELEASE_ID}" "$MARKER"
grep -qx "work_discovery=pilot:${PILOT_USERID}" "$MARKER"

MUTATED=0
trap - ERR INT TERM HUP
cat "$MARKER"
echo "ACTIVATION_OK ${RELEASE_ID} pilot=${PILOT_USERID}"
