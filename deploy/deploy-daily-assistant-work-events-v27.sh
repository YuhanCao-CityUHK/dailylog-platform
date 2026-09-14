#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_ID="20260828-daily-assistant-work-events-v27b"
BASELINE_RELEASE="20260827-log-detail-complete-v26"
APP_DIR="/opt/dailylog/app"
UPLOAD_DIR="/tmp/${RELEASE_ID}"
CANDIDATE_COMMIT="$(tr -d '\r\n' < "$UPLOAD_DIR/candidate-commit.txt")"
PAYLOAD_DIR="${UPLOAD_DIR}/payload"
RELEASE_DIR="/opt/dailylog/releases/${RELEASE_ID}"
BACKUP_DIR="/opt/dailylog/backups/before-${RELEASE_ID}"
LOCK_FILE="/var/lock/dailylog-deploy.lock"
LOCAL_BASE="http://127.0.0.1:8100"
PUBLIC_BASE="https://dailylog.vivolightsales.com"
LEGACY_BASE="https://dailyreport.vivolightsales.com"
DEPLOY_STARTED_AT="$(date --iso-8601=seconds)"
CUTOVER_STARTED=0

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

verify_baseline() {
  grep -qx "release=${BASELINE_RELEASE}" /opt/dailylog/DEPLOYED_HOTFIX
  while read -r expected rel; do
    [[ -z "${rel:-}" ]] && continue
    test -f "$APP_DIR/$rel"
    actual="$(tr -d '\r' < "$APP_DIR/$rel" | sha256sum | awk '{print $1}')"
    if [[ "$actual" != "$expected" ]]; then
      echo "production baseline drift: $rel" >&2
      return 1
    fi
  done < "$UPLOAD_DIR/base.sha256"
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    test ! -e "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/new-files.txt"
}

verify_payload() {
  (
    cd "$PAYLOAD_DIR"
    sha256sum --quiet -c "$UPLOAD_DIR/release.sha256"
  )
}

verify_installed() {
  (
    cd "$APP_DIR"
    sha256sum --quiet -c "$UPLOAD_DIR/release.sha256"
  )
}

restore_backup() {
  trap - ERR
  set +e
  if [[ -f "$BACKUP_DIR/ROLLBACK_COMPLETED" ]]; then
    return
  fi
  echo "Deployment failed after cutover; restoring ${BASELINE_RELEASE}" >&2
  systemctl stop dailylog
  tar -C "$APP_DIR" -xf "$BACKUP_DIR/app-files.tar"
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    rm -f -- "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/new-files.txt"
  install -o dailylog -g dailylog -m 0600 "$BACKUP_DIR/.env" "$APP_DIR/.env"
  install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX" /opt/dailylog/DEPLOYED_HOTFIX
  for name in platform.sqlite platform.sqlite-wal platform.sqlite-shm assistant-context.sqlite assistant-context.sqlite-wal assistant-context.sqlite-shm; do
    rm -f -- "$APP_DIR/data/$name"
    if [[ -f "$BACKUP_DIR/$name" ]]; then
      install -o dailylog -g dailylog -m 0640 "$BACKUP_DIR/$name" "$APP_DIR/data/$name"
    fi
  done
  systemctl start dailylog
  wait_for_url "$LOCAL_BASE/healthz" 30
  wait_for_url "$LOCAL_BASE/readyz" 30
  touch "$BACKUP_DIR/ROLLBACK_COMPLETED"
  echo "Rollback completed" >&2
}

on_error() {
  local rc="$1"
  local line="$2"
  local command="$3"
  echo "deployment error: rc=$rc line=$line command=$command" >&2
  if [[ "$CUTOVER_STARTED" == "1" && -d "$BACKUP_DIR" && ! -f "$BACKUP_DIR/ROLLBACK_COMPLETED" ]]; then
    restore_backup
  fi
  exit "$rc"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

for manifest in base.sha256 release.sha256 existing-files.txt new-files.txt release-files.txt candidate-commit.txt; do
  sed -i 's/\r$//' "$UPLOAD_DIR/$manifest"
done

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another dailylog deployment holds $LOCK_FILE" >&2
  exit 1
fi

echo "[1/8] Guarding production v26 and the uploaded release"
test -d "$APP_DIR"
test -d "$PAYLOAD_DIR"
test -d "$UPLOAD_DIR/tests"
test -f "$UPLOAD_DIR/deploy.sh"
test "$CANDIDATE_COMMIT" = "$(cat "$UPLOAD_DIR/candidate-commit.txt")"
test -f "$APP_DIR/.env"
test -d "$APP_DIR/node_modules"
test ! -e "$RELEASE_DIR"
test ! -e "$BACKUP_DIR"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport
verify_baseline
verify_payload

echo "[2/8] Building an isolated production-derived release tree"
install -d -o dailylog -g dailylog "$RELEASE_DIR"
tar --exclude='./node_modules' --exclude='./data' --exclude='./.env' -C "$APP_DIR" -cf - . | tar -C "$RELEASE_DIR" -xf -
ln -s "$APP_DIR/node_modules" "$RELEASE_DIR/node_modules"
install -o dailylog -g dailylog -m 0600 "$APP_DIR/.env" "$RELEASE_DIR/.env"
install -o dailylog -g dailylog -m 0600 "$APP_DIR/.env" "$RELEASE_DIR/.env.production"
cp -a "$PAYLOAD_DIR/." "$RELEASE_DIR/"
install -d -o dailylog -g dailylog "$RELEASE_DIR/tests" "$RELEASE_DIR/data"
cp -a "$UPLOAD_DIR/tests/." "$RELEASE_DIR/tests/"
set_env_value "$RELEASE_DIR/.env" "DATA_DIR" "$RELEASE_DIR/data"
set_env_value "$RELEASE_DIR/.env" "UPLOADS_DIR" "$RELEASE_DIR/data/uploads"
set_env_value "$RELEASE_DIR/.env" "DAILY_ASSISTANT_CONTEXT_DB" "$RELEASE_DIR/data/assistant-context.sqlite"
set_env_value "$RELEASE_DIR/.env" "DAILY_ASSISTANT_EVENT_FUSION_ENABLED" "0"
chown -R dailylog:dailylog "$RELEASE_DIR"
chmod 0600 "$RELEASE_DIR/.env" "$RELEASE_DIR/.env.production"

echo "[3/8] Testing migrations and the real model in isolation"
SOURCE_DB="$APP_DIR/data/platform.sqlite" SNAPSHOT_DB="$RELEASE_DIR/data/platform.sqlite" \
  sudo -u dailylog --preserve-env=SOURCE_DB,SNAPSHOT_DB node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const source = new DatabaseSync(process.env.SOURCE_DB);
const target = String(process.env.SNAPSHOT_DB).replaceAll("'", "''");
source.exec(`VACUUM INTO '${target}'`);
source.close();
NODE
if [[ -f "$APP_DIR/data/assistant-context.sqlite" ]]; then
  SOURCE_DB="$APP_DIR/data/assistant-context.sqlite" SNAPSHOT_DB="$RELEASE_DIR/data/assistant-context.sqlite" \
    sudo -u dailylog --preserve-env=SOURCE_DB,SNAPSHOT_DB node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const source = new DatabaseSync(process.env.SOURCE_DB);
const target = String(process.env.SNAPSHOT_DB).replaceAll("'", "''");
source.exec(`VACUUM INTO '${target}'`);
source.close();
NODE
fi
(
  cd "$RELEASE_DIR"
  sudo -u dailylog npm run migrate
  sudo -u dailylog npm run typecheck
  sudo -u dailylog npm test
  sudo -u dailylog npm run verify-daily-assistant-readiness
  sudo -u dailylog env DAILY_ASSISTANT_REAL_MODEL_TEST=1 \
    DAILY_ASSISTANT_EVENT_PRIMARY_MODEL=qwen3.7-max-2026-06-08 \
    node --import tsx --test tests/assistant-events-real.integration.test.ts
  sudo -u dailylog node --import tsx --input-type=module - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { getContextDb, listContextMigrations } from "./src/assistant/context-db.ts";
const main = new DatabaseSync("data/platform.sqlite", { readOnly: true });
const mainVersion = Number(main.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version);
main.close();
const context = getContextDb();
const contextVersions = listContextMigrations(context).map((migration) => migration.version);
if (mainVersion !== 10) throw new Error(`unexpected main migration: ${mainVersion}`);
if (JSON.stringify(contextVersions) !== JSON.stringify([1,2,3,4,5,6,7])) {
  throw new Error(`unexpected context migrations: ${contextVersions.join(",")}`);
}
console.log(JSON.stringify({ mainVersion, contextVersions }));
TS
  sudo -u dailylog node --check public/app.js
)

echo "[4/8] Rechecking production and creating exact rollback backups"
verify_baseline
verify_payload
install -d -o root -g root -m 0700 "$BACKUP_DIR"
tar -C "$APP_DIR" -cf "$BACKUP_DIR/app-files.tar" -T "$UPLOAD_DIR/existing-files.txt"
install -o root -g root -m 0600 "$APP_DIR/.env" "$BACKUP_DIR/.env"
install -o root -g root -m 0600 /opt/dailylog/DEPLOYED_HOTFIX "$BACKUP_DIR/DEPLOYED_HOTFIX"

echo "[5/8] Applying code and incremental migrations"
CUTOVER_STARTED=1
systemctl stop dailylog
if systemctl is-active --quiet dailylog; then
  echo "dailylog did not stop cleanly" >&2
  false
fi
systemctl is-active --quiet dailyreport
for name in platform.sqlite platform.sqlite-wal platform.sqlite-shm assistant-context.sqlite assistant-context.sqlite-wal assistant-context.sqlite-shm; do
  if [[ -f "$APP_DIR/data/$name" ]]; then
    install -o root -g root -m 0600 "$APP_DIR/data/$name" "$BACKUP_DIR/$name"
  fi
done
cp -a "$PAYLOAD_DIR/." "$APP_DIR/"
while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  chown dailylog:dailylog "$APP_DIR/$rel"
done < "$UPLOAD_DIR/release-files.txt"
(
  cd "$APP_DIR"
  sudo -u dailylog npm run migrate
  sudo -u dailylog node --import tsx --input-type=module - <<'TS'
import { getContextDb, listContextMigrations } from "./src/assistant/context-db.ts";
const db = getContextDb();
const versions = listContextMigrations(db).map((migration) => migration.version);
if (JSON.stringify(versions) !== JSON.stringify([1,2,3,4,5,6,7])) {
  throw new Error(`unexpected context migrations: ${versions.join(",")}`);
}
console.log(JSON.stringify({ contextMigrationVersions: versions }));
TS
)
chown -R dailylog:dailylog "$APP_DIR/data"
verify_installed
systemctl start dailylog
wait_for_url "$LOCAL_BASE/healthz" 30
wait_for_url "$LOCAL_BASE/readyz" 30

echo "[6/8] Verifying disabled-by-default rollout and schemas"
(
  cd "$APP_DIR"
  sudo -u dailylog node --import tsx --input-type=module - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./src/infra/config.ts";
import { getContextDb, listContextMigrations } from "./src/assistant/context-db.ts";
if (CONFIG.assistant.eventFusionEnabled) throw new Error("event fusion must remain disabled after code deployment");
if (CONFIG.assistant.eventFusionPilotUserids.length !== 0) throw new Error("event fusion pilot list must remain empty");
const main = new DatabaseSync("data/platform.sqlite", { readOnly: true });
const mainVersion = Number(main.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version);
main.close();
const contextVersions = listContextMigrations(getContextDb()).map((migration) => migration.version);
if (mainVersion !== 10 || contextVersions.at(-1) !== 7) throw new Error("migration verification failed");
console.log(JSON.stringify({ eventFusionEnabled: false, mainVersion, contextVersion: contextVersions.at(-1) }));
TS
)
test "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/api/daily-assistant/context/status")" = "401"

echo "[7/8] Verifying services, public endpoints, code and startup logs"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport
wait_for_url "$PUBLIC_BASE/healthz" 15
wait_for_url "$PUBLIC_BASE/readyz" 15
wait_for_url "$LEGACY_BASE/healthz" 15
grep -q 'DAILY_ASSISTANT_EVENT_FUSION_ENABLED' "$APP_DIR/.env.example"
grep -q 'assistant_event_runs' "$APP_DIR/src/assistant/context-db.ts"
grep -q 'class CandidateService' "$APP_DIR/src/assistant/candidate-service.ts"
if journalctl -u dailylog --since "$DEPLOY_STARTED_AT" --no-pager | grep -E '"evt":"(request_error|assistant_[^"]*_failed|config_warning)"'; then
  echo "new dailylog errors detected after startup" >&2
  false
fi

echo "[8/8] Recording provenance and final status"
BASELINE_DIGEST="$(sha256sum "$UPLOAD_DIR/base.sha256" | awk '{print $1}')"
RELEASE_DIGEST="$(sha256sum "$UPLOAD_DIR/release.sha256" | awk '{print $1}')"
printf '%s\n' \
  "release=$RELEASE_ID" \
  "previous_release=$BASELINE_RELEASE" \
  "candidate_commit=$CANDIDATE_COMMIT" \
  "deployed_at=$(date --iso-8601=seconds)" \
  "scope=daily-assistant-multisource-grounded-work-events" \
  "baseline_digest=$BASELINE_DIGEST" \
  "release_digest=$RELEASE_DIGEST" \
  "migration_version=main:10,context:7" \
  "event_fusion=installed-disabled" \
  "real_model_integration=passed" \
  "backup=$BACKUP_DIR" \
  > "$BACKUP_DIR/DEPLOYED_HOTFIX.new"
install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX.new" /opt/dailylog/DEPLOYED_HOTFIX
cat /opt/dailylog/DEPLOYED_HOTFIX
curl -fsS "$PUBLIC_BASE/healthz"
printf '\n'
curl -fsS "$PUBLIC_BASE/readyz"
printf '\n'
trap - ERR
CUTOVER_STARTED=0
echo "DEPLOYMENT_OK $RELEASE_ID"
