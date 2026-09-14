#!/usr/bin/env bash
set -Eeuo pipefail

# Restore the exact pre-all-user configuration (the validated Yang Chuzhen
# pilot) without reverting v32b application code or user data.

RELEASE_ID="20260902-daily-assistant-work-discovery-v32b"
APP_DIR="/opt/dailylog/app"
MARKER="/opt/dailylog/DEPLOYED_HOTFIX"
BACKUP_DIR="/opt/dailylog/backups/activate-all-work-discovery-v32b"
AUDIT_DIR="/opt/dailylog/backups/deactivate-all-work-discovery-v32b"
LOCK_FILE="/var/lock/dailylog-deploy.lock"
LOCAL_BASE="http://127.0.0.1:8100"
PUBLIC_BASE="https://dailylog.vivolightsales.com"
LEGACY_BASE="https://dailyreport.vivolightsales.com"

wait_for_url() {
  local url="$1" attempts="${2:-30}" i
  for ((i=1; i<=attempts; i+=1)); do
    if curl -fsS --max-time 5 "$url" >/dev/null; then return 0; fi
    sleep 2
  done
  echo "health check failed: $url" >&2
  return 1
}

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another dailylog deployment holds $LOCK_FILE" >&2; exit 1; }

grep -qx "release=${RELEASE_ID}" "$MARKER"
grep -q '^work_discovery=all_dingtalk:[0-9][0-9]*$' "$MARKER"
grep -qx 'event_fusion=disabled_for_all_work_discovery' "$MARKER"
test -f "$BACKUP_DIR/.env"
test -f "$BACKUP_DIR/DEPLOYED_HOTFIX"
test ! -e "$AUDIT_DIR"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport

install -d -o root -g root -m 0700 "$AUDIT_DIR"
install -o root -g root -m 0600 "$APP_DIR/.env" "$AUDIT_DIR/all-user.env"
install -o root -g root -m 0644 "$MARKER" "$AUDIT_DIR/DEPLOYED_HOTFIX.all"
install -o dailylog -g dailylog -m 0600 "$BACKUP_DIR/.env" "$APP_DIR/.env"
install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX" "$MARKER"
cmp -s "$APP_DIR/.env" "$BACKUP_DIR/.env"
cmp -s "$MARKER" "$BACKUP_DIR/DEPLOYED_HOTFIX"

systemctl restart dailylog
wait_for_url "$LOCAL_BASE/healthz" 30
wait_for_url "$LOCAL_BASE/readyz" 30
wait_for_url "$PUBLIC_BASE/healthz" 15
wait_for_url "$PUBLIC_BASE/readyz" 15
systemctl is-active --quiet dailyreport
wait_for_url "$LEGACY_BASE/healthz" 15

(
  cd "$APP_DIR"
  sudo -u dailylog env DOTENV_CONFIG_QUIET=true node --import tsx --input-type=module <<'TS'
import { CONFIG, validateConfig } from "./src/infra/config.ts";
const problems = validateConfig();
if (problems.length > 0) throw new Error(`restored configuration invalid: ${problems.join("; ")}`);
if (!CONFIG.assistant.workDiscoveryEnabled) throw new Error("previous pilot was not restored");
if (JSON.stringify(CONFIG.assistant.workDiscoveryPilotUserids) !== JSON.stringify(["example-user-4"])) throw new Error("previous pilot scope was not restored");
if (!CONFIG.assistant.eventFusionEnabled) throw new Error("previous Event Fusion state was not restored");
if (CONFIG.assistant.eventFusionPilotUserids.length === 0) throw new Error("previous Event Fusion pilots were not restored");
TS
)

touch "$AUDIT_DIR/DEACTIVATION_COMPLETED"
chmod 0600 "$AUDIT_DIR/DEACTIVATION_COMPLETED"
grep -qx 'work_discovery=pilot:example-user-4' "$MARKER"
echo "ALL_USER_DEACTIVATION_OK ${RELEASE_ID} restored=pilot:example-user-4"
