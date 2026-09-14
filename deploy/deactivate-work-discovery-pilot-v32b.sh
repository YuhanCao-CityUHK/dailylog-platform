#!/usr/bin/env bash
set -Eeuo pipefail

# Explicit post-acceptance rollback for a pilot that activated successfully but
# did not meet quality criteria. This restores only the saved disabled v32b
# configuration and marker; it never rolls application code back to v32.

RELEASE_ID="20260902-daily-assistant-work-discovery-v32b"
PILOT_USERID="example-user-4"
APP_DIR="/opt/dailylog/app"
MARKER="/opt/dailylog/DEPLOYED_HOTFIX"
ACTIVATION_BACKUP_DIR="/opt/dailylog/backups/activate-${RELEASE_ID}"
DEACTIVATION_AUDIT_DIR="/opt/dailylog/backups/deactivate-${RELEASE_ID}"
LOCK_FILE="/var/lock/dailylog-deploy.lock"
LOCAL_BASE="http://127.0.0.1:8100"
PUBLIC_BASE="https://dailylog.vivolightsales.com"
LEGACY_BASE="https://dailyreport.vivolightsales.com"
DEACTIVATION_LOG_SINCE=""
DEACTIVATION_JOURNAL_CURSOR=""
MUTATED=0

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

deactivation_logs() {
  if [[ -n "$DEACTIVATION_JOURNAL_CURSOR" ]]; then
    journalctl -u dailylog --after-cursor="$DEACTIVATION_JOURNAL_CURSOR" --no-pager
  else
    journalctl -u dailylog --since "$DEACTIVATION_LOG_SINCE" --no-pager
  fi
}

verify_disabled_backup() {
  grep -qx "release=${RELEASE_ID}" "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX"
  grep -qx "previous_release=20260902-daily-assistant-work-discovery-v32" "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX"
  grep -qx "scope=daily-assistant-work-discovery-v32b-latency-hotfix" "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX"
  grep -qx "migration_version=main:10,context:8" "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX"
  grep -qx "work_discovery=installed-disabled" "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX"
  grep -q '^DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED=0$' "$ACTIVATION_BACKUP_DIR/.env"
  if grep '^DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED=' "$ACTIVATION_BACKUP_DIR/.env" \
    | grep -qvx 'DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED=0'; then
    echo "activation backup contains a non-disabled work discovery flag" >&2
    return 1
  fi
  grep -q '^DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS=$' "$ACTIVATION_BACKUP_DIR/.env"
  if grep '^DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS=' "$ACTIVATION_BACKUP_DIR/.env" \
    | grep -qvx 'DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS='; then
    echo "activation backup contains a non-empty pilot list" >&2
    return 1
  fi
}

verify_runtime_pilot() {
  (
    cd "$APP_DIR"
    sudo -u dailylog env DOTENV_CONFIG_QUIET=true node --import tsx --input-type=module <<'TS'
import { CONFIG } from "./src/infra/config.ts";
const expected = "example-user-4";
if (!CONFIG.assistant.workDiscoveryEnabled) {
  throw new Error("work discovery is not active");
}
if (CONFIG.assistant.workDiscoveryPilotUserids.length !== 1
  || CONFIG.assistant.workDiscoveryPilotUserids[0] !== expected) {
  throw new Error("active pilot scope is not the approved employee");
}
if (CONFIG.assistant.eventFusionPilotUserids.includes(expected)) {
  throw new Error("active work-discovery pilot is still in strict Event fusion");
}
TS
  )
}

verify_runtime_disabled() {
  (
    cd "$APP_DIR"
    sudo -u dailylog env DOTENV_CONFIG_QUIET=true node --import tsx --input-type=module <<'TS'
import { CONFIG } from "./src/infra/config.ts";
if (CONFIG.assistant.workDiscoveryEnabled !== false) {
  throw new Error("work discovery did not return to disabled state");
}
if (CONFIG.assistant.workDiscoveryPilotUserids.length !== 0) {
  throw new Error("pilot list did not return to empty state");
}
if (!CONFIG.assistant.eventFusionPilotUserids.includes("example-user-4")) {
  throw new Error("original Event fusion pilot membership was not restored");
}
TS
  )
}

on_error() {
  local rc="$1"
  local line="$2"
  local command="$3"
  trap - ERR INT TERM HUP
  echo "pilot deactivation error: rc=$rc line=$line command=$command" >&2
  if [[ "$MUTATED" == "1" ]]; then
    # Do not automatically re-enable a pilot that was intentionally disabled
    # for failed quality acceptance. Make a best effort to run the service with
    # the already-restored disabled configuration and report any health issue.
    local recovery_rc=0
    install -o dailylog -g dailylog -m 0600 \
      "$ACTIVATION_BACKUP_DIR/.env" "$APP_DIR/.env" || recovery_rc=1
    install -o root -g root -m 0644 \
      "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX" "$MARKER" || recovery_rc=1
    cmp -s "$APP_DIR/.env" "$ACTIVATION_BACKUP_DIR/.env" || recovery_rc=1
    cmp -s "$MARKER" "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX" || recovery_rc=1
    systemctl restart dailylog || recovery_rc=1
    wait_for_url "$LOCAL_BASE/healthz" 30 || recovery_rc=1
    wait_for_url "$LOCAL_BASE/readyz" 30 || recovery_rc=1
    verify_runtime_disabled || recovery_rc=1
    if [[ "$recovery_rc" -ne 0 ]]; then
      echo "CRITICAL: pilot is intended to remain off, but disabled recovery is unhealthy" >&2
      exit 99
    fi
    echo "pilot remains configured off after deactivation verification failed" >&2
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
grep -qx "previous_release=20260902-daily-assistant-work-discovery-v32" "$MARKER"
grep -qx "scope=daily-assistant-work-discovery-v32b-latency-hotfix" "$MARKER"
grep -qx "migration_version=main:10,context:8" "$MARKER"
grep -qx "work_discovery=pilot:${PILOT_USERID}" "$MARKER"
grep -qx "event_fusion_excluded_pilot=${PILOT_USERID}" "$MARKER"
test -f "$APP_DIR/.env"
test -f "$ACTIVATION_BACKUP_DIR/.env"
test -f "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX"
test ! -e "$DEACTIVATION_AUDIT_DIR"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport
verify_disabled_backup
verify_runtime_pilot

install -d -o root -g root -m 0700 "$DEACTIVATION_AUDIT_DIR"
install -o root -g root -m 0600 "$APP_DIR/.env" "$DEACTIVATION_AUDIT_DIR/pilot.env"
install -o root -g root -m 0644 "$MARKER" "$DEACTIVATION_AUDIT_DIR/DEPLOYED_HOTFIX.pilot"
cmp -s "$APP_DIR/.env" "$DEACTIVATION_AUDIT_DIR/pilot.env"
cmp -s "$MARKER" "$DEACTIVATION_AUDIT_DIR/DEPLOYED_HOTFIX.pilot"
MUTATED=1

install -o dailylog -g dailylog -m 0600 "$ACTIVATION_BACKUP_DIR/.env" "$APP_DIR/.env"
install -o root -g root -m 0644 "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX" "$MARKER"
cmp -s "$APP_DIR/.env" "$ACTIVATION_BACKUP_DIR/.env"
cmp -s "$MARKER" "$ACTIVATION_BACKUP_DIR/DEPLOYED_HOTFIX"

DEACTIVATION_LOG_SINCE="$(date --iso-8601=seconds)"
if ! DEACTIVATION_JOURNAL_CURSOR="$(
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
verify_runtime_disabled

if ! DEACTIVATION_LOGS="$(deactivation_logs)"; then
  echo "failed to read post-deactivation dailylog journal" >&2
  false
fi
if grep -E '"evt":"(request_error|assistant_[^"]*_failed|config_warning)"' <<< "$DEACTIVATION_LOGS"; then
  echo "new dailylog errors detected after pilot deactivation" >&2
  false
fi

touch "$ACTIVATION_BACKUP_DIR/ACTIVATION_ROLLBACK_COMPLETED"
printf 'deactivated_at=%s\n' "$(date --iso-8601=seconds)" \
  > "$DEACTIVATION_AUDIT_DIR/DEACTIVATION_COMPLETED"
chmod 0600 "$DEACTIVATION_AUDIT_DIR/DEACTIVATION_COMPLETED"
grep -qx "release=${RELEASE_ID}" "$MARKER"
grep -qx "work_discovery=installed-disabled" "$MARKER"

MUTATED=0
trap - ERR INT TERM HUP
cat "$MARKER"
echo "PILOT_DEACTIVATION_OK ${RELEASE_ID} pilot=${PILOT_USERID}"
