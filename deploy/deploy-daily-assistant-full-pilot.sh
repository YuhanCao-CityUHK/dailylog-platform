#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_ID="20260825-daily-assistant-temporal-agent-v15"
APP_DIR="/opt/dailylog/app"
UPLOAD_DIR="/tmp/${RELEASE_ID}"
PAYLOAD_DIR="${UPLOAD_DIR}/payload"
RELEASE_DIR="/opt/dailylog/releases/${RELEASE_ID}"
BACKUP_DIR="/opt/dailylog/backups/before-${RELEASE_ID}"
LOCK_FILE="/var/lock/dailylog-assistant-deploy.lock"
PILOT_USERIDS="example-user-5,example-user-2"
LOCAL_BASE="http://127.0.0.1:8100"
PUBLIC_BASE="https://dailylog.vivolightsales.com"
LEGACY_BASE="https://dailyreport.vivolightsales.com"
CUTOVER_STARTED=0
DEPLOY_STARTED_AT="$(date --iso-8601=seconds)"

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

configure_pilot_env() {
  local file="$1"
  set_env_value "$file" "DWS_ASSISTANT_PILOT_USERIDS" "$PILOT_USERIDS"
  set_env_value "$file" "DAILY_ASSISTANT_PILOT_USERIDS" "$PILOT_USERIDS"
  set_env_value "$file" "DAILY_ASSISTANT_ENABLED" "1"
  set_env_value "$file" "DAILY_ASSISTANT_CONVERSATION_ENABLED" "1"
  set_env_value "$file" "DAILY_ASSISTANT_SUBMIT_ENABLED" "1"
  set_env_value "$file" "DAILY_ASSISTANT_MANAGER_OVERVIEW_ENABLED" "1"
  set_env_value "$file" "DAILY_ASSISTANT_PREWARM_ENABLED" "0"
  set_env_value "$file" "DAILY_ASSISTANT_REMINDER_ENABLED" "0"
  set_env_value "$file" "DAILY_ASSISTANT_GLOBAL_CONCURRENCY" "4"
  set_env_value "$file" "DAILY_ASSISTANT_PER_USER_CONCURRENCY" "2"
  if ! grep -Eq '^DAILY_ASSISTANT_CONTEXT_KEY=.{32,}$' "$file"; then
    set_env_value "$file" "DAILY_ASSISTANT_CONTEXT_KEY" "$(openssl rand -hex 32)"
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
  (
    cd "$APP_DIR"
    sha256sum --quiet -c "$UPLOAD_DIR/base.sha256"
  )
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    test -f "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/existing-files.txt"
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
    echo "Rollback already completed" >&2
    return
  fi
  echo "Deployment failed after cutover; restoring $BACKUP_DIR" >&2
  systemctl stop dailylog
  tar -C "$APP_DIR" -xf "$BACKUP_DIR/app-files.tar"
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    rm -f -- "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/new-files.txt"
  install -o dailylog -g dailylog -m 0600 "$BACKUP_DIR/.env" "$APP_DIR/.env"
  if [[ -f "$BACKUP_DIR/DEPLOYED_HOTFIX" ]]; then
    install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX" /opt/dailylog/DEPLOYED_HOTFIX
  else
    rm -f -- /opt/dailylog/DEPLOYED_HOTFIX
  fi
  for name in platform.sqlite platform.sqlite-wal platform.sqlite-shm; do
    rm -f -- "$APP_DIR/data/$name"
    if [[ -f "$BACKUP_DIR/$name" ]]; then
      install -o dailylog -g dailylog -m 0640 "$BACKUP_DIR/$name" "$APP_DIR/data/$name"
    fi
  done
  rm -f -- \
    "$APP_DIR/data/assistant-context.sqlite" \
    "$APP_DIR/data/assistant-context.sqlite-wal" \
    "$APP_DIR/data/assistant-context.sqlite-shm"
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

for manifest in base.sha256 release.sha256 existing-files.txt new-files.txt release-files.txt; do
  sed -i 's/\r$//' "$UPLOAD_DIR/$manifest"
done

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another dailylog deployment holds $LOCK_FILE" >&2
  exit 1
fi

echo "[1/8] Guarding the live baseline and uploaded payload"
test -d "$APP_DIR"
test -d "$PAYLOAD_DIR"
test -d "$UPLOAD_DIR/tests"
test -f "$UPLOAD_DIR/production-smoke.mjs"
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
cp -a "$PAYLOAD_DIR/." "$RELEASE_DIR/"
install -d -o dailylog -g dailylog "$RELEASE_DIR/tests" "$RELEASE_DIR/deploy"
cp -a "$UPLOAD_DIR/tests/." "$RELEASE_DIR/tests/"
install -o dailylog -g dailylog -m 0700 "$UPLOAD_DIR/deploy.sh" "$RELEASE_DIR/deploy/deploy-daily-assistant-full-pilot.sh"
install -d -o dailylog -g dailylog "$RELEASE_DIR/data"
configure_pilot_env "$RELEASE_DIR/.env"
install -o dailylog -g dailylog -m 0600 "$RELEASE_DIR/.env" "$RELEASE_DIR/.env.production"
set_env_value "$RELEASE_DIR/.env" "DATA_DIR" "$RELEASE_DIR/data"
set_env_value "$RELEASE_DIR/.env" "UPLOADS_DIR" "$RELEASE_DIR/data/uploads"
set_env_value "$RELEASE_DIR/.env" "DWS_USERS_DIR" "$RELEASE_DIR/data/dws-users"
set_env_value "$RELEASE_DIR/.env" "DAILY_ASSISTANT_CONTEXT_DB" "$RELEASE_DIR/data/assistant-context.sqlite"
chown -R dailylog:dailylog "$RELEASE_DIR"
chmod 0600 "$RELEASE_DIR/.env"
chmod 0600 "$RELEASE_DIR/.env.production"

echo "[3/8] Snapshotting production data and testing migrations in isolation"
SOURCE_DB="$APP_DIR/data/platform.sqlite" SNAPSHOT_DB="$RELEASE_DIR/data/platform.sqlite" \
  sudo -u dailylog --preserve-env=SOURCE_DB,SNAPSHOT_DB node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const source = new DatabaseSync(process.env.SOURCE_DB);
const target = String(process.env.SNAPSHOT_DB).replaceAll("'", "''");
source.exec(`VACUUM INTO '${target}'`);
source.close();
NODE
(
  cd "$RELEASE_DIR"
  sudo -u dailylog npm run migrate
  sudo -u dailylog npm run typecheck
  sudo -u dailylog npm test
  sudo -u dailylog npm run verify-daily-assistant-readiness
  sudo -u dailylog npm run verify-dws-connection
  sudo -u dailylog npm run verify-dws-context-preview
  sudo -u dailylog npm run verify-dws-pilot-routes
  sudo -u dailylog node --import tsx --input-type=module - <<'TS'
import { getContextDb, listContextMigrations } from "./src/assistant/context-db.ts";
const db = getContextDb();
const versions = listContextMigrations(db).map((migration) => migration.version);
if (JSON.stringify(versions) !== JSON.stringify([1, 2, 3, 4, 5])) throw new Error(`unexpected context migrations: ${versions.join(",")}`);
console.log(JSON.stringify({ contextMigrationVersions: versions }));
TS
  node --check public/app.js
)

echo "[4/8] Rechecking the live baseline and creating an exact rollback backup"
verify_baseline
verify_payload
install -d -o root -g root -m 0700 "$BACKUP_DIR"
tar -C "$APP_DIR" -cf "$BACKUP_DIR/app-files.tar" -T "$UPLOAD_DIR/existing-files.txt"
install -o root -g root -m 0600 "$APP_DIR/.env" "$BACKUP_DIR/.env"
if [[ -f /opt/dailylog/DEPLOYED_HOTFIX ]]; then
  install -o root -g root -m 0600 /opt/dailylog/DEPLOYED_HOTFIX "$BACKUP_DIR/DEPLOYED_HOTFIX"
fi

echo "[5/8] Applying the release and incremental database migrations"
CUTOVER_STARTED=1
systemctl stop dailylog
if systemctl is-active --quiet dailylog; then
  echo "dailylog did not stop cleanly" >&2
  false
fi
systemctl is-active --quiet dailyreport
for name in platform.sqlite platform.sqlite-wal platform.sqlite-shm; do
  if [[ -f "$APP_DIR/data/$name" ]]; then
    install -o root -g root -m 0600 "$APP_DIR/data/$name" "$BACKUP_DIR/$name"
  fi
done
cp -a "$PAYLOAD_DIR/." "$APP_DIR/"
install -o dailylog -g dailylog -m 0600 "$RELEASE_DIR/.env.production" "$APP_DIR/.env"
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
if (JSON.stringify(versions) !== JSON.stringify([1, 2, 3, 4, 5])) throw new Error(`unexpected context migrations: ${versions.join(",")}`);
console.log(JSON.stringify({ contextMigrationVersions: versions }));
TS
)
chown -R dailylog:dailylog "$APP_DIR/data"
verify_installed
systemctl start dailylog
wait_for_url "$LOCAL_BASE/healthz" 30
wait_for_url "$LOCAL_BASE/readyz" 30

echo "[6/8] Verifying the exact two-user rollout and migrated schema"
(
  cd "$APP_DIR"
  sudo -u dailylog node --import tsx --input-type=module - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./src/infra/config.ts";
import { canUseDwsAssistant } from "./src/auth/types.ts";

const expected = ["example-user-2", "example-user-5"];
const configured = [...CONFIG.assistant.pilotUserids].sort();
if (!CONFIG.assistant.enabled || !CONFIG.assistant.conversationEnabled || !CONFIG.assistant.submitEnabled || !CONFIG.assistant.managerOverviewEnabled) {
  throw new Error("daily assistant user-facing flags are not fully enabled");
}
if (CONFIG.assistant.prewarmEnabled || CONFIG.assistant.reminderEnabled) {
  throw new Error("pilot automation must remain disabled during interactive testing");
}
if (JSON.stringify(configured) !== JSON.stringify(expected)) {
  throw new Error(`unexpected pilot userids: ${configured.join(",")}`);
}
const db = new DatabaseSync("data/platform.sqlite", { readOnly: true });
const users = db.prepare("SELECT id, name, dd_userid, role, active FROM users WHERE active = 1").all();
const allowed = users.filter((row) => canUseDwsAssistant({
  id: Number(row.id), kind: "dingtalk", ddUserid: String(row.dd_userid ?? ""), name: String(row.name),
  title: "", dept: "", role: row.role, isExternal: false, mustChangePw: false,
}));
if (allowed.length !== 2 || allowed.map((row) => row.name).sort().join(",") !== ["示例员工", "示例管理员"].sort().join(",")) {
  throw new Error(`unexpected enabled users: ${allowed.map((row) => row.name).join(",")}`);
}
const migration = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
if (Number(migration.version) !== 7) throw new Error(`unexpected migration version: ${migration.version}`);
const contextDb = new DatabaseSync(CONFIG.assistant.contextDbPath, { readOnly: true });
const contextMigration = contextDb.prepare("SELECT MAX(version) AS version FROM context_schema_migrations").get();
contextDb.close();
if (Number(contextMigration.version) !== 5) throw new Error(`unexpected context migration version: ${contextMigration.version}`);
if (CONFIG.assistant.globalConcurrency !== 4 || CONFIG.assistant.perUserConcurrency !== 2) {
  throw new Error(`unexpected DWS concurrency: ${CONFIG.assistant.globalConcurrency}/${CONFIG.assistant.perUserConcurrency}`);
}
console.log(JSON.stringify({
  pilotUsers: allowed.map((row) => row.name).sort(),
  migrationVersion: migration.version,
  contextMigrationVersion: contextMigration.version,
  concurrency: { global: CONFIG.assistant.globalConcurrency, perUser: CONFIG.assistant.perUserConcurrency },
  automation: "off",
}));
db.close();
TS
)
test "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/api/daily-assistant/context/status")" = "401"
test "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/api/manager/overview")" = "401"

echo "[7/8] Verifying public health, the legacy service, and startup logs"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport
wait_for_url "$PUBLIC_BASE/healthz" 15
wait_for_url "$PUBLIC_BASE/readyz" 15
wait_for_url "$LEGACY_BASE/healthz" 15
grep -q '20260825-daily-assistant-temporal-agent-v15' "$APP_DIR/public/index.html"
grep -q 'canDwsAssistant' "$APP_DIR/public/app.js"
(
  cd "$APP_DIR"
  sudo -u dailylog DB_PATH="$APP_DIR/data/platform.sqlite" BASE_URL="$LOCAL_BASE" node "$UPLOAD_DIR/production-smoke.mjs"
)
if journalctl -u dailylog --since "$DEPLOY_STARTED_AT" --no-pager | grep -E '"evt":"(request_error|assistant_[^"]*_failed|config_warning)"'; then
  echo "new dailylog errors detected after startup" >&2
  false
fi

echo "[8/8] Recording provenance and final status"
BASELINE_DIGEST="$(sha256sum "$UPLOAD_DIR/base.sha256" | awk '{print $1}')"
RELEASE_DIGEST="$(sha256sum "$UPLOAD_DIR/release.sha256" | awk '{print $1}')"
printf '%s\n' \
  "release=$RELEASE_ID" \
  "deployed_at=$(date --iso-8601=seconds)" \
  "scope=daily-assistant-temporal-agent" \
  "pilot_userids=$PILOT_USERIDS" \
  "baseline_digest=$BASELINE_DIGEST" \
  "release_digest=$RELEASE_DIGEST" \
  "migration_version=main:7,context:5" \
  "dws_concurrency=global:4,per_user:2" \
  "automation=off" \
  "backup=$BACKUP_DIR" \
  > "$BACKUP_DIR/DEPLOYED_HOTFIX.new"
install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX.new" /opt/dailylog/DEPLOYED_HOTFIX
systemctl --no-pager --full status dailylog | sed -n '1,12p'
curl -fsS "$PUBLIC_BASE/healthz"
printf '\n'
curl -fsS "$PUBLIC_BASE/readyz"
printf '\n'
cat /opt/dailylog/DEPLOYED_HOTFIX
trap - ERR
CUTOVER_STARTED=0
echo "DEPLOYMENT_OK $RELEASE_ID"
