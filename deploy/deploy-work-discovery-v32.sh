#!/usr/bin/env bash
set -Eeuo pipefail

# Incremental, production-derived release for the work-discovery pipeline.
# Expected upload layout under /tmp/$RELEASE_ID:
#   deploy.sh, payload/, base.sha256, release.sha256,
#   existing-files.txt, new-files.txt, removed-files.txt,
#   release-files.txt, candidate-commit.txt

RELEASE_ID="20260902-daily-assistant-work-discovery-v32"
BASELINE_RELEASE="20260901-external-project-member-owner-guard-v31c"
APP_DIR="/opt/dailylog/app"
UPLOAD_DIR="/tmp/${RELEASE_ID}"
PAYLOAD_DIR="${UPLOAD_DIR}/payload"
RELEASE_DIR="/opt/dailylog/releases/${RELEASE_ID}"
BACKUP_DIR="/opt/dailylog/backups/before-${RELEASE_ID}"
LOCK_FILE="/var/lock/dailylog-deploy.lock"
LOCAL_BASE="http://127.0.0.1:8100"
PUBLIC_BASE="https://dailylog.vivolightsales.com"
LEGACY_BASE="https://dailyreport.vivolightsales.com"
WORK_DISCOVERY_FLAG="DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED"
WORK_DISCOVERY_PILOT_FLAG="DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS"
DEPLOY_LOG_SINCE=""
DEPLOY_JOURNAL_CURSOR=""
CUTOVER_STARTED=0
SERVICE_STOPPED=0

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

configure_work_discovery_off() {
  local file="$1"
  set_env_value "$file" "$WORK_DISCOVERY_FLAG" "0"
  set_env_value "$file" "$WORK_DISCOVERY_PILOT_FLAG" ""
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

deployment_logs() {
  if [[ -n "$DEPLOY_JOURNAL_CURSOR" ]]; then
    journalctl -u dailylog --after-cursor="$DEPLOY_JOURNAL_CURSOR" --no-pager
  else
    journalctl -u dailylog --since "$DEPLOY_LOG_SINCE" --no-pager
  fi
}

safe_manifest_path() {
  local rel="$1"
  [[ -n "$rel" ]] || return 1
  [[ "$rel" != /* && "$rel" != "." && "$rel" != ".." ]] || return 1
  [[ "$rel" != ../* && "$rel" != */../* && "$rel" != */.. ]] || return 1
  [[ "$rel" != *[[:space:]]* ]] || return 1
  [[ "$rel" != ".env" && "$rel" != ".env."* ]] || return 1
  [[ "$rel" != "data" && "$rel" != data/* ]] || return 1
  [[ "$rel" != "node_modules" && "$rel" != node_modules/* ]] || return 1
  [[ "$rel" != ".git" && "$rel" != .git/* ]] || return 1
}

validate_path_list() {
  local file="$1"
  local rel
  while IFS= read -r rel || [[ -n "$rel" ]]; do
    [[ -z "$rel" ]] && continue
    if ! safe_manifest_path "$rel"; then
      echo "unsafe path in $file: $rel" >&2
      return 1
    fi
  done < "$file"
}

validate_hash_manifest() {
  local file="$1"
  local digest rel extra
  while read -r digest rel extra; do
    [[ -z "${digest:-}" ]] && continue
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
      echo "invalid sha256 in $file" >&2
      return 1
    }
    [[ -z "${extra:-}" ]] || {
      echo "unexpected fields in $file" >&2
      return 1
    }
    if ! safe_manifest_path "$rel"; then
      echo "unsafe path in $file: $rel" >&2
      return 1
    fi
  done < "$file"
}

verify_manifest_sets() {
  cmp -s \
    <(awk '{print $2}' "$UPLOAD_DIR/release.sha256" | sort -u) \
    <(sort -u "$UPLOAD_DIR/release-files.txt") || {
      echo "release.sha256 and release-files.txt disagree" >&2
      return 1
    }
  cmp -s \
    <(awk '{print $2}' "$UPLOAD_DIR/base.sha256" | sort -u) \
    <(cat "$UPLOAD_DIR/existing-files.txt" "$UPLOAD_DIR/removed-files.txt" | sort -u) || {
      echo "base.sha256 must cover every replaced or removed live file" >&2
      return 1
    }
  cmp -s \
    <(cat "$UPLOAD_DIR/existing-files.txt" "$UPLOAD_DIR/new-files.txt" | sort -u) \
    <(sort -u "$UPLOAD_DIR/release-files.txt") || {
      echo "existing-files.txt plus new-files.txt must equal release-files.txt" >&2
      return 1
    }
  if comm -12 \
    <(sort -u "$UPLOAD_DIR/new-files.txt") \
    <(sort -u "$UPLOAD_DIR/removed-files.txt") | grep -q .; then
    echo "a path cannot be both new and removed" >&2
    return 1
  fi
  cmp -s \
    <(find "$PAYLOAD_DIR" -type f -printf '%P\n' | sort -u) \
    <(sort -u "$UPLOAD_DIR/release-files.txt") || {
      echo "payload contents do not exactly match release-files.txt" >&2
      return 1
    }
  if find "$PAYLOAD_DIR" -type l -print -quit | grep -q .; then
    echo "payload symlinks are not allowed" >&2
    return 1
  fi
}

verify_baseline() {
  grep -qx "release=${BASELINE_RELEASE}" /opt/dailylog/DEPLOYED_HOTFIX
  (
    cd "$APP_DIR"
    sha256sum --quiet -c "$UPLOAD_DIR/base.sha256"
  )
  local rel
  while IFS= read -r rel || [[ -n "$rel" ]]; do
    [[ -z "$rel" ]] && continue
    test -f "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/existing-files.txt"
  while IFS= read -r rel || [[ -n "$rel" ]]; do
    [[ -z "$rel" ]] && continue
    test ! -e "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/new-files.txt"
  while IFS= read -r rel || [[ -n "$rel" ]]; do
    [[ -z "$rel" ]] && continue
    test -f "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/removed-files.txt"
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
  local rel
  while IFS= read -r rel || [[ -n "$rel" ]]; do
    [[ -z "$rel" ]] && continue
    test ! -e "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/removed-files.txt"
}

snapshot_sqlite() {
  local source_db="$1"
  local snapshot_db="$2"
  SOURCE_DB="$source_db" SNAPSHOT_DB="$snapshot_db" node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const source = new DatabaseSync(process.env.SOURCE_DB);
const target = String(process.env.SNAPSHOT_DB).replaceAll("'", "''");
source.exec(`VACUUM INTO '${target}'`);
source.close();
NODE
}

validate_sqlite_snapshot() {
  local snapshot_db="$1"
  SNAPSHOT_DB="$snapshot_db" node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.SNAPSHOT_DB, { readOnly: true });
const rows = db.prepare("PRAGMA quick_check").all();
db.close();
if (rows.length !== 1 || String(rows[0].quick_check).toLowerCase() !== "ok") {
  throw new Error(`SQLite snapshot failed quick_check: ${JSON.stringify(rows)}`);
}
NODE
}

apply_context_migrations() {
  sudo -u dailylog node --import tsx --input-type=module <<'TS'
import { getContextDb, listContextMigrations } from "./src/assistant/context-db.ts";
const db = getContextDb();
console.log(JSON.stringify({ contextMigrations: listContextMigrations(db).map((row) => row.version) }));
TS
}

schema_versions() {
  sudo -u dailylog env DOTENV_CONFIG_QUIET=true node --import tsx --input-type=module <<'TS'
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./src/infra/config.ts";
const main = new DatabaseSync("data/platform.sqlite", { readOnly: true });
const mainVersion = Number(main.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version);
main.close();
const context = new DatabaseSync(CONFIG.assistant.contextDbPath, { readOnly: true });
const contextVersion = Number(
  context.prepare("SELECT MAX(version) AS version FROM context_schema_migrations").get().version,
);
context.close();
process.stdout.write(`${mainVersion} ${contextVersion}\n`);
TS
}

verify_dependencies_unchanged() {
  cmp -s "$APP_DIR/package-lock.json" "$RELEASE_DIR/package-lock.json" || {
    echo "package-lock.json changed; this incremental release reuses live node_modules" >&2
    return 1
  }
  LIVE_PACKAGE="$APP_DIR/package.json" STAGED_PACKAGE="$RELEASE_DIR/package.json" node <<'NODE'
const fs = require("node:fs");
const live = JSON.parse(fs.readFileSync(process.env.LIVE_PACKAGE, "utf8"));
const staged = JSON.parse(fs.readFileSync(process.env.STAGED_PACKAGE, "utf8"));
for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  if (JSON.stringify(live[key] ?? {}) !== JSON.stringify(staged[key] ?? {})) {
    throw new Error(`${key} changed; use a full dependency-aware deployment instead`);
  }
}
NODE
}

restore_backup() {
  trap - ERR INT TERM HUP
  set +e
  local rollback_rc=0
  if [[ -f "$BACKUP_DIR/ROLLBACK_COMPLETED" ]]; then
    echo "rollback already completed" >&2
    return 0
  fi
  echo "deployment failed after cutover; restoring ${BASELINE_RELEASE}" >&2

  # A failed stop may still have terminated the unit. Never touch code or
  # databases until systemd confirms that no dailylog process is active.
  systemctl stop dailylog || true
  if systemctl is-active --quiet dailylog; then
    echo "CRITICAL: dailylog is still active; refusing rollback file changes" >&2
    return 1
  fi
  tar -C "$APP_DIR" -xf "$BACKUP_DIR/app-files.tar" || rollback_rc=1

  local rel
  while IFS= read -r rel || [[ -n "$rel" ]]; do
    [[ -z "$rel" ]] && continue
    if safe_manifest_path "$rel"; then
      rm -f -- "$APP_DIR/$rel" || rollback_rc=1
    else
      rollback_rc=1
    fi
  done < "$BACKUP_DIR/new-files.txt"

  install -o dailylog -g dailylog -m 0600 "$BACKUP_DIR/.env" "$APP_DIR/.env" || rollback_rc=1
  install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX" /opt/dailylog/DEPLOYED_HOTFIX || rollback_rc=1

  # Validate every required recovery image before deleting any live database.
  # If validation fails, retain the post-failure databases so no user data is
  # destroyed and still attempt to bring the restored code back online.
  local db_restore_ready=1
  # Preserve the exact post-failure database files before replacing them with
  # the pre-cutover snapshots. This prevents successful requests in the brief
  # verification window from becoming unrecoverable during an automatic
  # rollback; the files can be reconciled manually if needed.
  local name
  for name in \
    platform.sqlite platform.sqlite-wal platform.sqlite-shm \
    assistant-context.sqlite assistant-context.sqlite-wal assistant-context.sqlite-shm; do
    if [[ -f "$APP_DIR/data/$name" ]]; then
      install -o root -g root -m 0600 \
        "$APP_DIR/data/$name" "$BACKUP_DIR/post-failure-$name" || db_restore_ready=0
    fi
  done
  local preserve_live_platform=0
  if [[ -f "$APP_DIR/data/platform.sqlite" ]] \
    && validate_sqlite_snapshot "$APP_DIR/data/platform.sqlite"; then
    # This release is required to leave the main schema version unchanged.
    # Keep a healthy live main DB so a submission made during post-start
    # verification is not rolled out of the active database.
    preserve_live_platform=1
  fi
  if [[ -f "$BACKUP_DIR/platform.snapshot.sqlite" ]]; then
    validate_sqlite_snapshot "$BACKUP_DIR/platform.snapshot.sqlite" || db_restore_ready=0
  else
    echo "CRITICAL: platform rollback snapshot is missing" >&2
    db_restore_ready=0
  fi
  if [[ -f "$BACKUP_DIR/CONTEXT_DB_PRESENT" ]]; then
    if [[ -f "$BACKUP_DIR/assistant-context.snapshot.sqlite" ]]; then
      validate_sqlite_snapshot "$BACKUP_DIR/assistant-context.snapshot.sqlite" || db_restore_ready=0
    else
      echo "CRITICAL: assistant context rollback snapshot is missing" >&2
      db_restore_ready=0
    fi
  fi

  local platform_restore="$APP_DIR/data/.platform.sqlite.rollback-${RELEASE_ID}"
  local context_restore="$APP_DIR/data/.assistant-context.sqlite.rollback-${RELEASE_ID}"
  rm -f -- "$platform_restore" "$context_restore" || db_restore_ready=0
  if [[ "$db_restore_ready" -eq 1 ]]; then
    install -o dailylog -g dailylog -m 0640 \
      "$BACKUP_DIR/platform.snapshot.sqlite" "$platform_restore" || db_restore_ready=0
    if [[ -f "$BACKUP_DIR/CONTEXT_DB_PRESENT" ]]; then
      install -o dailylog -g dailylog -m 0640 \
        "$BACKUP_DIR/assistant-context.snapshot.sqlite" "$context_restore" || db_restore_ready=0
    fi
  fi
  if [[ "$db_restore_ready" -eq 1 ]]; then
    validate_sqlite_snapshot "$platform_restore" || db_restore_ready=0
    if [[ -f "$BACKUP_DIR/CONTEXT_DB_PRESENT" ]]; then
      validate_sqlite_snapshot "$context_restore" || db_restore_ready=0
    fi
  fi
  if [[ "$db_restore_ready" -eq 1 ]]; then
    # mv on the same filesystem atomically replaces an unhealthy main DB. A
    # healthy main DB is retained to preserve any post-start submissions.
    if [[ "$preserve_live_platform" -eq 1 ]]; then
      rm -f -- "$platform_restore" || db_restore_ready=0
    elif mv -f -- "$platform_restore" "$APP_DIR/data/platform.sqlite"; then
      rm -f -- "$APP_DIR/data/platform.sqlite-wal" "$APP_DIR/data/platform.sqlite-shm" || db_restore_ready=0
    else
      db_restore_ready=0
    fi
    if [[ "$db_restore_ready" -eq 1 && -f "$BACKUP_DIR/CONTEXT_DB_PRESENT" ]]; then
      if mv -f -- "$context_restore" "$APP_DIR/data/assistant-context.sqlite"; then
        rm -f -- \
          "$APP_DIR/data/assistant-context.sqlite-wal" \
          "$APP_DIR/data/assistant-context.sqlite-shm" || db_restore_ready=0
      else
        db_restore_ready=0
      fi
    elif [[ "$db_restore_ready" -eq 1 ]]; then
      rm -f -- \
        "$APP_DIR/data/assistant-context.sqlite" \
        "$APP_DIR/data/assistant-context.sqlite-wal" \
        "$APP_DIR/data/assistant-context.sqlite-shm" || db_restore_ready=0
    fi
  fi
  if [[ "$db_restore_ready" -ne 1 ]]; then
    rm -f -- "$platform_restore" "$context_restore" || true
    echo "CRITICAL: database rollback image was not installed; retained live databases where possible" >&2
    rollback_rc=1
  fi

  systemctl start dailylog || rollback_rc=1
  SERVICE_STOPPED=0
  wait_for_url "$LOCAL_BASE/healthz" 30 || rollback_rc=1
  wait_for_url "$LOCAL_BASE/readyz" 30 || rollback_rc=1
  wait_for_url "$LEGACY_BASE/healthz" 15 || rollback_rc=1
  systemctl is-active --quiet dailyreport || rollback_rc=1

  if [[ "$rollback_rc" -eq 0 ]]; then
    touch "$BACKUP_DIR/ROLLBACK_COMPLETED"
    echo "rollback completed" >&2
    return 0
  fi
  echo "CRITICAL: rollback did not fully recover production" >&2
  return 1
}

on_error() {
  local rc="$1"
  local line="$2"
  local command="$3"
  trap - ERR INT TERM HUP
  echo "deployment error: rc=$rc line=$line command=$command" >&2
  if [[ "$CUTOVER_STARTED" == "1" && -d "$BACKUP_DIR" ]]; then
    if ! restore_backup; then
      exit 99
    fi
  elif [[ "$SERVICE_STOPPED" == "1" ]]; then
    echo "pre-cutover failure while dailylog is stopped; restarting unchanged production" >&2
    if ! systemctl start dailylog \
      || ! wait_for_url "$LOCAL_BASE/healthz" 30 \
      || ! wait_for_url "$LOCAL_BASE/readyz" 30 \
      || ! systemctl is-active --quiet dailyreport \
      || ! wait_for_url "$LEGACY_BASE/healthz" 15; then
      echo "CRITICAL: unchanged production did not restart" >&2
      exit 99
    fi
    SERVICE_STOPPED=0
  fi
  exit "$rc"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
trap 'on_error 130 "$LINENO" "signal:INT"' INT
trap 'on_error 143 "$LINENO" "signal:TERM"' TERM
trap 'on_error 129 "$LINENO" "signal:HUP"' HUP

for manifest in \
  base.sha256 release.sha256 existing-files.txt new-files.txt \
  removed-files.txt release-files.txt candidate-commit.txt; do
  test -f "$UPLOAD_DIR/$manifest"
  sed -i 's/\r$//' "$UPLOAD_DIR/$manifest"
done

CANDIDATE_COMMIT="$(tr -d '\r\n' < "$UPLOAD_DIR/candidate-commit.txt")"
[[ "$CANDIDATE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "candidate-commit.txt must contain one full Git commit hash" >&2
  exit 1
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another dailylog deployment holds $LOCK_FILE" >&2
  exit 1
fi

echo "[1/8] Validating manifests, v31c baseline, and production guards"
test -d "$APP_DIR"
test -d "$PAYLOAD_DIR"
test -s "$UPLOAD_DIR/base.sha256"
test -s "$UPLOAD_DIR/release.sha256"
test -s "$UPLOAD_DIR/release-files.txt"
test -f "$APP_DIR/.env"
test -d "$APP_DIR/node_modules"
test ! -e "$RELEASE_DIR"
test ! -e "$BACKUP_DIR"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport
available_kb="$(df --output=avail /opt/dailylog | tail -1 | tr -d ' ')"
(( available_kb >= 1048576 )) || {
  echo "less than 1 GiB free under /opt/dailylog" >&2
  false
}
validate_hash_manifest "$UPLOAD_DIR/base.sha256"
validate_hash_manifest "$UPLOAD_DIR/release.sha256"
validate_path_list "$UPLOAD_DIR/existing-files.txt"
validate_path_list "$UPLOAD_DIR/new-files.txt"
validate_path_list "$UPLOAD_DIR/removed-files.txt"
validate_path_list "$UPLOAD_DIR/release-files.txt"
verify_manifest_sets
verify_baseline
verify_payload
read -r BASELINE_MAIN_MIGRATION BASELINE_CONTEXT_MIGRATION < <(
  cd "$APP_DIR"
  schema_versions
)
[[ "$BASELINE_MAIN_MIGRATION" =~ ^[0-9]+$ && "$BASELINE_CONTEXT_MIGRATION" =~ ^[0-9]+$ ]]

echo "[2/8] Building an isolated production-derived release tree"
install -d -o dailylog -g dailylog "$RELEASE_DIR"
tar --exclude='./node_modules' --exclude='./data' --exclude='./.env' -C "$APP_DIR" -cf - . | tar -C "$RELEASE_DIR" -xf -
ln -s "$APP_DIR/node_modules" "$RELEASE_DIR/node_modules"
install -o dailylog -g dailylog -m 0600 "$APP_DIR/.env" "$RELEASE_DIR/.env"
cp -a "$PAYLOAD_DIR/." "$RELEASE_DIR/"
while IFS= read -r rel || [[ -n "$rel" ]]; do
  [[ -z "$rel" ]] && continue
  rm -f -- "$RELEASE_DIR/$rel"
done < "$UPLOAD_DIR/removed-files.txt"
install -d -o dailylog -g dailylog "$RELEASE_DIR/data"
configure_work_discovery_off "$RELEASE_DIR/.env"
set_env_value "$RELEASE_DIR/.env" "DATA_DIR" "$RELEASE_DIR/data"
set_env_value "$RELEASE_DIR/.env" "UPLOADS_DIR" "$RELEASE_DIR/data/uploads"
set_env_value "$RELEASE_DIR/.env" "DWS_USERS_DIR" "$RELEASE_DIR/data/dws-users"
set_env_value "$RELEASE_DIR/.env" "DAILY_ASSISTANT_CONTEXT_DB" "$RELEASE_DIR/data/assistant-context.sqlite"
chown -R dailylog:dailylog "$RELEASE_DIR"
chmod 0600 "$RELEASE_DIR/.env"
verify_dependencies_unchanged

echo "[3/8] Snapshotting live data and running isolated preflight"
snapshot_sqlite "$APP_DIR/data/platform.sqlite" "$RELEASE_DIR/data/platform.sqlite"
if [[ -f "$APP_DIR/data/assistant-context.sqlite" ]]; then
  snapshot_sqlite "$APP_DIR/data/assistant-context.sqlite" "$RELEASE_DIR/data/assistant-context.sqlite"
fi
chown -R dailylog:dailylog "$RELEASE_DIR/data"
(
  cd "$RELEASE_DIR"
  sudo -u dailylog npm run migrate
  apply_context_migrations
  sudo -u dailylog npm run typecheck
  sudo -u dailylog npm test
  sudo -u dailylog npm run assistant-v2-conformance
  sudo -u dailylog npm run verify-daily-assistant-readiness
  sudo -u dailylog node --check public/app.js
)
read -r STAGED_MAIN_MIGRATION STAGED_CONTEXT_MIGRATION < <(
  cd "$RELEASE_DIR"
  schema_versions
)
[[ "$STAGED_MAIN_MIGRATION" =~ ^[0-9]+$ && "$STAGED_CONTEXT_MIGRATION" =~ ^[0-9]+$ ]]
test "$STAGED_MAIN_MIGRATION" = "$BASELINE_MAIN_MIGRATION" || {
  echo "work-discovery incremental release must not change the main database schema" >&2
  false
}
(( STAGED_CONTEXT_MIGRATION >= BASELINE_CONTEXT_MIGRATION )) || {
  echo "staged context schema regressed" >&2
  false
}

echo "[4/8] Rechecking production and creating complete rollback backups"
verify_baseline
verify_payload
install -d -o root -g root -m 0700 "$BACKUP_DIR"
cat "$UPLOAD_DIR/existing-files.txt" "$UPLOAD_DIR/removed-files.txt" | sort -u > "$BACKUP_DIR/code-files.txt"
tar -C "$APP_DIR" -cf "$BACKUP_DIR/app-files.tar" -T "$BACKUP_DIR/code-files.txt"
install -o root -g root -m 0600 "$UPLOAD_DIR/new-files.txt" "$BACKUP_DIR/new-files.txt"
install -o root -g root -m 0600 "$APP_DIR/.env" "$BACKUP_DIR/.env"
install -o root -g root -m 0600 /opt/dailylog/DEPLOYED_HOTFIX "$BACKUP_DIR/DEPLOYED_HOTFIX"
snapshot_sqlite "$APP_DIR/data/platform.sqlite" "$BACKUP_DIR/platform.online.snapshot.sqlite"
validate_sqlite_snapshot "$BACKUP_DIR/platform.online.snapshot.sqlite"
if [[ -f "$APP_DIR/data/assistant-context.sqlite" ]]; then
  touch "$BACKUP_DIR/CONTEXT_DB_PRESENT"
  snapshot_sqlite "$APP_DIR/data/assistant-context.sqlite" "$BACKUP_DIR/assistant-context.online.snapshot.sqlite"
  validate_sqlite_snapshot "$BACKUP_DIR/assistant-context.online.snapshot.sqlite"
fi

echo "[5/8] Applying the incremental release with work discovery disabled"
SERVICE_STOPPED=1
systemctl stop dailylog
if systemctl is-active --quiet dailylog; then
  echo "dailylog did not stop cleanly" >&2
  false
fi
systemctl is-active --quiet dailyreport
for name in \
  platform.sqlite platform.sqlite-wal platform.sqlite-shm \
  assistant-context.sqlite assistant-context.sqlite-wal assistant-context.sqlite-shm; do
  if [[ -f "$APP_DIR/data/$name" ]]; then
    install -o root -g root -m 0600 "$APP_DIR/data/$name" "$BACKUP_DIR/$name"
  fi
done
snapshot_sqlite "$APP_DIR/data/platform.sqlite" "$BACKUP_DIR/platform.snapshot.sqlite"
validate_sqlite_snapshot "$BACKUP_DIR/platform.snapshot.sqlite"
if [[ -f "$APP_DIR/data/assistant-context.sqlite" ]]; then
  touch "$BACKUP_DIR/CONTEXT_DB_PRESENT"
  snapshot_sqlite "$APP_DIR/data/assistant-context.sqlite" "$BACKUP_DIR/assistant-context.snapshot.sqlite"
  validate_sqlite_snapshot "$BACKUP_DIR/assistant-context.snapshot.sqlite"
elif [[ -f "$BACKUP_DIR/CONTEXT_DB_PRESENT" ]]; then
  echo "assistant context database disappeared before cutover" >&2
  false
fi
CUTOVER_STARTED=1

cp -a "$PAYLOAD_DIR/." "$APP_DIR/"
while IFS= read -r rel || [[ -n "$rel" ]]; do
  [[ -z "$rel" ]] && continue
  rm -f -- "$APP_DIR/$rel"
done < "$UPLOAD_DIR/removed-files.txt"
while IFS= read -r rel || [[ -n "$rel" ]]; do
  [[ -z "$rel" ]] && continue
  test -f "$APP_DIR/$rel"
  chown root:root "$APP_DIR/$rel"
  case "$rel" in
    *.sh) chmod 0755 "$APP_DIR/$rel" ;;
    *) chmod 0644 "$APP_DIR/$rel" ;;
  esac
done < "$UPLOAD_DIR/release-files.txt"
configure_work_discovery_off "$APP_DIR/.env"
chown dailylog:dailylog "$APP_DIR/.env"
chmod 0600 "$APP_DIR/.env"
(
  cd "$APP_DIR"
  sudo -u dailylog npm run migrate
  apply_context_migrations
)
chown -R dailylog:dailylog "$APP_DIR/data"
find "$APP_DIR/data" -maxdepth 1 -type f \
  \( -name 'platform.sqlite*' -o -name 'assistant-context.sqlite*' \) \
  -exec chmod 0640 {} +
verify_installed
DEPLOY_LOG_SINCE="$(date --iso-8601=seconds)"
if ! DEPLOY_JOURNAL_CURSOR="$(
  journalctl -u dailylog -n 1 --show-cursor --no-pager \
    | sed -n 's/^-- cursor: //p' \
    | tail -1
)"; then
  echo "failed to capture the pre-start journal cursor" >&2
  false
fi
systemctl start dailylog
SERVICE_STOPPED=0
wait_for_url "$LOCAL_BASE/healthz" 30
wait_for_url "$LOCAL_BASE/readyz" 30

echo "[6/8] Verifying disabled rollout and migrated schemas"
read -r LIVE_MAIN_MIGRATION LIVE_CONTEXT_MIGRATION < <(
  cd "$APP_DIR"
  schema_versions
)
test "$LIVE_MAIN_MIGRATION" = "$STAGED_MAIN_MIGRATION"
test "$LIVE_CONTEXT_MIGRATION" = "$STAGED_CONTEXT_MIGRATION"
(
  cd "$APP_DIR"
  sudo -u dailylog node --import tsx --input-type=module <<'TS'
import { CONFIG } from "./src/infra/config.ts";
const assistant = CONFIG.assistant;
if (assistant.workDiscoveryEnabled !== false) {
  throw new Error("work discovery must remain disabled after code deployment");
}
if (Array.isArray(assistant.workDiscoveryPilotUserids) && assistant.workDiscoveryPilotUserids.length !== 0) {
  throw new Error("work discovery pilot list must remain empty after code deployment");
}
console.log(JSON.stringify({ workDiscoveryEnabled: false, workDiscoveryPilotUserids: [] }));
TS
)

echo "[7/8] Verifying public service, legacy service, and startup logs"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport
wait_for_url "$PUBLIC_BASE/healthz" 15
wait_for_url "$PUBLIC_BASE/readyz" 15
wait_for_url "$LEGACY_BASE/healthz" 15
test "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/api/daily-assistant/context/status")" = "401"
if ! STARTUP_LOGS="$(deployment_logs)"; then
  echo "failed to read post-deployment dailylog journal" >&2
  false
fi
if grep -E '"evt":"(request_error|assistant_[^"]*_failed|config_warning)"' <<< "$STARTUP_LOGS"; then
  echo "new dailylog errors detected after startup" >&2
  false
fi

echo "[8/8] Recording immutable provenance and final status"
BASELINE_DIGEST="$(sha256sum "$UPLOAD_DIR/base.sha256" | awk '{print $1}')"
RELEASE_DIGEST="$(sha256sum "$UPLOAD_DIR/release.sha256" | awk '{print $1}')"
printf '%s\n' \
  "release=$RELEASE_ID" \
  "previous_release=$BASELINE_RELEASE" \
  "candidate_commit=$CANDIDATE_COMMIT" \
  "deployed_at=$(date --iso-8601=seconds)" \
  "scope=daily-assistant-work-discovery-v32" \
  "baseline_digest=$BASELINE_DIGEST" \
  "release_digest=$RELEASE_DIGEST" \
  "migration_version=main:${LIVE_MAIN_MIGRATION},context:${LIVE_CONTEXT_MIGRATION}" \
  "work_discovery=installed-disabled" \
  "backup=$BACKUP_DIR" \
  > "$BACKUP_DIR/DEPLOYED_HOTFIX.new"
install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX.new" /opt/dailylog/DEPLOYED_HOTFIX
cat /opt/dailylog/DEPLOYED_HOTFIX
curl -fsS "$PUBLIC_BASE/healthz"
printf '\n'
curl -fsS "$PUBLIC_BASE/readyz"
printf '\n'
trap - ERR INT TERM HUP
CUTOVER_STARTED=0
echo "DEPLOYMENT_OK $RELEASE_ID"
