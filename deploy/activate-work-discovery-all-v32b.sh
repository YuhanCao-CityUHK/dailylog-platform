#!/usr/bin/env bash
set -Eeuo pipefail

# Expand the already validated v32b work-discovery release from its single
# approved pilot to every active DingTalk account.  The previous exact .env and
# provenance marker are copied before mutation so this can be rolled back to
# the prior single-pilot configuration without touching application code/data.

RELEASE_ID="20260902-daily-assistant-work-discovery-v32b"
PREVIOUS_PILOT_USERID="example-user-4"
APP_DIR="/opt/dailylog/app"
MARKER="/opt/dailylog/DEPLOYED_HOTFIX"
BACKUP_DIR="/opt/dailylog/backups/activate-all-work-discovery-v32b"
LOCK_FILE="/var/lock/dailylog-deploy.lock"
LOCAL_BASE="http://127.0.0.1:8100"
PUBLIC_BASE="https://dailylog.vivolightsales.com"
LEGACY_BASE="https://dailyreport.vivolightsales.com"
LOG_SINCE=""
JOURNAL_CURSOR=""
MUTATED=0

set_env_value() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

wait_for_url() {
  local url="$1" attempts="${2:-30}" i
  for ((i=1; i<=attempts; i+=1)); do
    if curl -fsS --max-time 5 "$url" >/dev/null; then return 0; fi
    sleep 2
  done
  echo "health check failed: $url" >&2
  return 1
}

new_logs() {
  if [[ -n "$JOURNAL_CURSOR" ]]; then
    journalctl -u dailylog --after-cursor="$JOURNAL_CURSOR" --no-pager
  else
    journalctl -u dailylog --since "$LOG_SINCE" --no-pager
  fi
}

restore_previous_config() {
  trap - ERR INT TERM HUP
  set +e
  local rc=0
  install -o dailylog -g dailylog -m 0600 "$BACKUP_DIR/.env" "$APP_DIR/.env" || rc=1
  install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX" "$MARKER" || rc=1
  cmp -s "$APP_DIR/.env" "$BACKUP_DIR/.env" || rc=1
  cmp -s "$MARKER" "$BACKUP_DIR/DEPLOYED_HOTFIX" || rc=1
  systemctl restart dailylog || rc=1
  wait_for_url "$LOCAL_BASE/healthz" 30 || rc=1
  wait_for_url "$LOCAL_BASE/readyz" 30 || rc=1
  wait_for_url "$PUBLIC_BASE/healthz" 15 || rc=1
  wait_for_url "$PUBLIC_BASE/readyz" 15 || rc=1
  systemctl is-active --quiet dailyreport || rc=1
  wait_for_url "$LEGACY_BASE/healthz" 15 || rc=1
  if [[ "$rc" -eq 0 ]]; then touch "$BACKUP_DIR/ROLLBACK_COMPLETED"; fi
  return "$rc"
}

on_error() {
  local rc="$1" line="$2" command="$3"
  trap - ERR INT TERM HUP
  echo "all-user activation error: rc=$rc line=$line command=$command" >&2
  if [[ "$MUTATED" == "1" && -d "$BACKUP_DIR" ]]; then
    restore_previous_config || exit 99
  fi
  exit "$rc"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
trap 'on_error 130 "$LINENO" "signal:INT"' INT
trap 'on_error 143 "$LINENO" "signal:TERM"' TERM
trap 'on_error 129 "$LINENO" "signal:HUP"' HUP

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another dailylog deployment holds $LOCK_FILE" >&2; exit 1; }

grep -qx "release=${RELEASE_ID}" "$MARKER"
grep -qx "candidate_commit=52f55cc27d29b8b37895b64dad17ebdf54a3900c" "$MARKER"
grep -qx "scope=daily-assistant-work-discovery-v32b-latency-hotfix" "$MARKER"
grep -qx "migration_version=main:10,context:8" "$MARKER"
grep -qx "work_discovery=pilot:${PREVIOUS_PILOT_USERID}" "$MARKER"
grep -qx "event_fusion_excluded_pilot=${PREVIOUS_PILOT_USERID}" "$MARKER"
test -f "$APP_DIR/.env"
test ! -e "$BACKUP_DIR"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport

read -r ALL_USERIDS USER_COUNT <<< "$(
  cd "$APP_DIR"
  sudo -u dailylog env DOTENV_CONFIG_QUIET=true node --import tsx --input-type=module <<'TS'
import { getDb } from "./src/infra/db.ts";
const db = getDb();
const rows = db.prepare(
  `SELECT DISTINCT TRIM(dd_userid) AS id
     FROM users
    WHERE kind = 'dingtalk' AND active = 1 AND TRIM(COALESCE(dd_userid, '')) <> ''
    ORDER BY id`,
).all();
const ids = rows.map((row) => String(row.id));
if (ids.length < 2) throw new Error("refusing all-user rollout with fewer than two active DingTalk accounts");
if (!ids.includes("example-user-4")) throw new Error("previous approved pilot is missing from active DingTalk accounts");
if (ids.some((id) => !/^[A-Za-z0-9._:@+-]+$/.test(id))) throw new Error("unsafe DingTalk userid for environment serialization");
process.stdout.write(`${ids.join(",")} ${ids.length}\n`);
TS
)"
[[ "$USER_COUNT" =~ ^[0-9]+$ && "$USER_COUNT" -ge 2 ]]
[[ "$ALL_USERIDS" == *,* ]]

(
  cd "$APP_DIR"
  sudo -u dailylog env DOTENV_CONFIG_QUIET=true node --import tsx --input-type=module <<'TS'
import { CONFIG } from "./src/infra/config.ts";
if (!CONFIG.assistant.workDiscoveryEnabled) throw new Error("work discovery must already be enabled for the validated pilot");
if (JSON.stringify(CONFIG.assistant.workDiscoveryPilotUserids) !== JSON.stringify(["example-user-4"])) {
  throw new Error("pre-activation scope is not the approved single pilot");
}
if (!CONFIG.assistant.eventFusionEnabled) throw new Error("expected active Event Fusion pilot before full migration");
if (CONFIG.assistant.eventFusionPilotUserids.length === 0) throw new Error("Event Fusion pilot list unexpectedly empty");
TS
)

install -d -o root -g root -m 0700 "$BACKUP_DIR"
install -o root -g root -m 0600 "$APP_DIR/.env" "$BACKUP_DIR/.env"
install -o root -g root -m 0644 "$MARKER" "$BACKUP_DIR/DEPLOYED_HOTFIX"
printf '%s\n' "$ALL_USERIDS" | install -o root -g root -m 0600 /dev/stdin "$BACKUP_DIR/all-dingtalk-userids.csv"
cmp -s "$APP_DIR/.env" "$BACKUP_DIR/.env"
cmp -s "$MARKER" "$BACKUP_DIR/DEPLOYED_HOTFIX"
MUTATED=1

# Event Fusion is the older strict model pipeline.  With discovery enabled for
# every employee, disable it rather than making its two old pilots pay for two
# model pipelines and receive mixed candidate semantics.
set_env_value "$APP_DIR/.env" "DAILY_ASSISTANT_EVENT_FUSION_ENABLED" "0"
set_env_value "$APP_DIR/.env" "DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED" "1"
set_env_value "$APP_DIR/.env" "DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS" "$ALL_USERIDS"
set_env_value "$APP_DIR/.env" "DAILY_ASSISTANT_WORK_DISCOVERY_MAX_CANDIDATES" "50"
chown dailylog:dailylog "$APP_DIR/.env"
chmod 0600 "$APP_DIR/.env"

(
  cd "$APP_DIR"
  sudo -u dailylog env \
    DOTENV_CONFIG_QUIET=true \
    ALL_USERIDS="$ALL_USERIDS" \
    EXPECTED_USER_COUNT="$USER_COUNT" \
    node --import tsx --input-type=module <<'TS'
import { CONFIG, validateConfig } from "./src/infra/config.ts";
const expected = String(process.env.ALL_USERIDS ?? "").split(",").filter(Boolean);
const problems = validateConfig();
if (problems.length > 0) throw new Error(`configuration invalid: ${problems.join("; ")}`);
if (!CONFIG.llm.enabled || !CONFIG.llm.primary.apiKey) throw new Error("real LLM is unavailable");
if (!CONFIG.assistant.workDiscoveryEnabled) throw new Error("work discovery is not enabled");
if (JSON.stringify(CONFIG.assistant.workDiscoveryPilotUserids) !== JSON.stringify(expected)) throw new Error("all-user list changed while writing config");
if (CONFIG.assistant.workDiscoveryPilotUserids.length !== Number(process.env.EXPECTED_USER_COUNT)) throw new Error("all-user count mismatch");
if (CONFIG.assistant.eventFusionEnabled) throw new Error("Event Fusion must be disabled during all-user discovery rollout");
if (CONFIG.assistant.workDiscoveryMaxCandidates !== 50) throw new Error("candidate limit mismatch");
console.log(JSON.stringify({ enabled: true, activeDingTalkUsers: expected.length, eventFusionEnabled: false, maxCandidates: 50 }));
TS
)

LOG_SINCE="$(date --iso-8601=seconds)"
JOURNAL_CURSOR="$(journalctl -u dailylog -n 1 --show-cursor --no-pager | sed -n 's/^-- cursor: //p' | tail -1)"
systemctl restart dailylog
wait_for_url "$LOCAL_BASE/healthz" 30
wait_for_url "$LOCAL_BASE/readyz" 30
systemctl is-active --quiet dailyreport
wait_for_url "$PUBLIC_BASE/healthz" 15
wait_for_url "$PUBLIC_BASE/readyz" 15
wait_for_url "$LEGACY_BASE/healthz" 15
test "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/api/daily-assistant/context/status")" = "401"

ACTIVATION_LOGS="$(new_logs)"
if grep -E '"evt":"(request_error|assistant_[^"]*_failed|config_warning)"' <<< "$ACTIVATION_LOGS"; then
  echo "new dailylog errors detected after all-user activation" >&2
  false
fi

USERIDS_DIGEST="$(printf '%s' "$ALL_USERIDS" | sha256sum | awk '{print $1}')"
sed \
  -e "s/^work_discovery=.*/work_discovery=all_dingtalk:${USER_COUNT}/" \
  -e '/^event_fusion_excluded_pilot=/d' \
  "$MARKER" > "$BACKUP_DIR/DEPLOYED_HOTFIX.all"
printf 'work_discovery_all_activated_at=%s\n' "$(date --iso-8601=seconds)" >> "$BACKUP_DIR/DEPLOYED_HOTFIX.all"
printf 'work_discovery_all_userids_sha256=%s\n' "$USERIDS_DIGEST" >> "$BACKUP_DIR/DEPLOYED_HOTFIX.all"
printf 'event_fusion=disabled_for_all_work_discovery\n' >> "$BACKUP_DIR/DEPLOYED_HOTFIX.all"
install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX.all" "$MARKER"
grep -qx "work_discovery=all_dingtalk:${USER_COUNT}" "$MARKER"
grep -qx 'event_fusion=disabled_for_all_work_discovery' "$MARKER"

MUTATED=0
trap - ERR INT TERM HUP
cat "$MARKER"
echo "ALL_USER_ACTIVATION_OK ${RELEASE_ID} users=${USER_COUNT}"
