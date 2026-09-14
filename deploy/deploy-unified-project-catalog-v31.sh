#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_ID="20260901-external-project-member-owner-guard-v31c"
APP_DIR="/opt/dailylog/app"
UPLOAD_DIR="/tmp/${RELEASE_ID}"
PAYLOAD_DIR="${UPLOAD_DIR}/payload"
RELEASE_DIR="/opt/dailylog/releases/${RELEASE_ID}"
BACKUP_DIR="/opt/dailylog/backups/before-${RELEASE_ID}"
LOCK_FILE="/var/lock/dailylog-deploy.lock"
LOCAL_BASE="http://127.0.0.1:8100"
PUBLIC_BASE="https://dailylog.vivolightsales.com"
CUTOVER_STARTED=0
DEPLOY_STARTED_AT="$(date --iso-8601=seconds)"

wait_for_url() {
  local url="$1"
  local attempts="${2:-30}"
  local i
  for ((i=1; i<=attempts; i+=1)); do
    if curl -fsS --max-time 5 "$url" >/dev/null; then return 0; fi
    sleep 2
  done
  echo "health check failed: $url" >&2
  return 1
}

safe_manifest_path() {
  local rel="$1"
  [[ -n "$rel" && "$rel" != /* && "$rel" != *".."* ]]
}

verify_baseline() {
  (cd "$APP_DIR" && sha256sum --quiet -c "$UPLOAD_DIR/base.sha256")
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    safe_manifest_path "$rel"
    test -f "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/existing-files.txt"
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    safe_manifest_path "$rel"
    test ! -e "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/new-files.txt"
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    safe_manifest_path "$rel"
    test -f "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/removed-files.txt"
}

verify_payload() {
  (cd "$PAYLOAD_DIR" && sha256sum --quiet -c "$UPLOAD_DIR/release.sha256")
}

verify_installed() {
  (cd "$APP_DIR" && sha256sum --quiet -c "$UPLOAD_DIR/release.sha256")
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    safe_manifest_path "$rel"
    test ! -e "$APP_DIR/$rel"
  done < "$UPLOAD_DIR/removed-files.txt"
}

restore_backup() {
  trap - ERR
  set +e
  if [[ -f "$BACKUP_DIR/ROLLBACK_COMPLETED" ]]; then return; fi
  echo "Deployment failed; restoring $BACKUP_DIR" >&2
  systemctl stop dailylog
  tar -C "$APP_DIR" -xf "$BACKUP_DIR/app-files.tar"
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    if safe_manifest_path "$rel"; then rm -f -- "$APP_DIR/$rel"; fi
  done < "$UPLOAD_DIR/new-files.txt"
  install -o dailylog -g dailylog -m 0600 "$BACKUP_DIR/.env" "$APP_DIR/.env"
  for name in platform.sqlite platform.sqlite-wal platform.sqlite-shm; do
    rm -f -- "$APP_DIR/data/$name"
    if [[ -f "$BACKUP_DIR/$name" ]]; then
      install -o dailylog -g dailylog -m 0640 "$BACKUP_DIR/$name" "$APP_DIR/data/$name"
    fi
  done
  if [[ -f "$BACKUP_DIR/DEPLOYED_HOTFIX" ]]; then
    install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX" /opt/dailylog/DEPLOYED_HOTFIX
  fi
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
  if [[ "$CUTOVER_STARTED" == "1" && -d "$BACKUP_DIR" ]]; then restore_backup; fi
  exit "$rc"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

for manifest in base.sha256 release.sha256 existing-files.txt new-files.txt release-files.txt removed-files.txt; do
  sed -i 's/\r$//' "$UPLOAD_DIR/$manifest"
done

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another dailylog deployment holds $LOCK_FILE" >&2
  exit 1
fi

echo "[1/7] Verifying live baseline and uploaded payload"
test -d "$APP_DIR"
test -d "$PAYLOAD_DIR"
test -f "$APP_DIR/.env"
test -d "$APP_DIR/node_modules"
test ! -e "$RELEASE_DIR"
test ! -e "$BACKUP_DIR"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport
verify_baseline
verify_payload

echo "[2/7] Building and testing an isolated production-derived release"
install -d -o dailylog -g dailylog "$RELEASE_DIR"
tar --exclude='./node_modules' --exclude='./data' --exclude='./.env' -C "$APP_DIR" -cf - . | tar -C "$RELEASE_DIR" -xf -
ln -s "$APP_DIR/node_modules" "$RELEASE_DIR/node_modules"
install -o dailylog -g dailylog -m 0600 "$APP_DIR/.env" "$RELEASE_DIR/.env"
cp -a "$PAYLOAD_DIR/." "$RELEASE_DIR/"
while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  safe_manifest_path "$rel"
  rm -f -- "$RELEASE_DIR/$rel"
done < "$UPLOAD_DIR/removed-files.txt"
install -d -o dailylog -g dailylog "$RELEASE_DIR/data"
chown -R dailylog:dailylog "$RELEASE_DIR"
SOURCE_DB="$APP_DIR/data/platform.sqlite" SNAPSHOT_DB="$RELEASE_DIR/data/platform.sqlite" \
  sudo -u dailylog --preserve-env=SOURCE_DB,SNAPSHOT_DB node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const source = new DatabaseSync(process.env.SOURCE_DB);
source.exec(`VACUUM INTO '${String(process.env.SNAPSHOT_DB).replaceAll("'", "''")}'`);
source.close();
NODE
(
  cd "$RELEASE_DIR"
  export DATA_DIR="$RELEASE_DIR/data"
  sudo -u dailylog --preserve-env=DATA_DIR npm run migrate
  sudo -u dailylog --preserve-env=DATA_DIR npm run migrate-unified-project-catalog
  sudo -u dailylog --preserve-env=DATA_DIR npm run migrate-unified-project-catalog -- --apply
  sudo -u dailylog --preserve-env=DATA_DIR npm run verify-unified-project-catalog
  sudo -u dailylog npm run typecheck
  sudo -u dailylog npm test
  node --check public/app.js
)

echo "[3/7] Rechecking baseline and creating rollback backup"
verify_baseline
verify_payload
install -d -o root -g root -m 0700 "$BACKUP_DIR"
tar -C "$APP_DIR" -cf "$BACKUP_DIR/app-files.tar" -T "$UPLOAD_DIR/existing-files.txt"
install -o root -g root -m 0600 "$APP_DIR/.env" "$BACKUP_DIR/.env"
if [[ -f /opt/dailylog/DEPLOYED_HOTFIX ]]; then
  install -o root -g root -m 0600 /opt/dailylog/DEPLOYED_HOTFIX "$BACKUP_DIR/DEPLOYED_HOTFIX"
fi

echo "[4/7] Applying code and project migration"
CUTOVER_STARTED=1
systemctl stop dailylog
if systemctl is-active --quiet dailylog; then false; fi
systemctl is-active --quiet dailyreport
for name in platform.sqlite platform.sqlite-wal platform.sqlite-shm; do
  if [[ -f "$APP_DIR/data/$name" ]]; then install -o root -g root -m 0600 "$APP_DIR/data/$name" "$BACKUP_DIR/$name"; fi
done
BEFORE_DB="$APP_DIR/data/platform.sqlite" SNAPSHOT_DB="$BACKUP_DIR/platform.snapshot.sqlite" node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const source = new DatabaseSync(process.env.BEFORE_DB);
source.exec(`VACUUM INTO '${String(process.env.SNAPSHOT_DB).replaceAll("'", "''")}'`);
source.close();
NODE
cp -a "$PAYLOAD_DIR/." "$APP_DIR/"
while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  safe_manifest_path "$rel"
  rm -f -- "$APP_DIR/$rel"
done < "$UPLOAD_DIR/removed-files.txt"
while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  safe_manifest_path "$rel"
  chown dailylog:dailylog "$APP_DIR/$rel"
done < "$UPLOAD_DIR/release-files.txt"
(
  cd "$APP_DIR"
  sudo -u dailylog npm run migrate
  sudo -u dailylog npm run migrate-unified-project-catalog
  sudo -u dailylog npm run migrate-unified-project-catalog -- --apply
  sudo -u dailylog npm run verify-unified-project-catalog
)
verify_installed
systemctl start dailylog
wait_for_url "$LOCAL_BASE/healthz" 30
wait_for_url "$LOCAL_BASE/readyz" 30

echo "[5/7] Verifying data preservation and exact project assignments"
BEFORE_DB="$BACKUP_DIR/platform.snapshot.sqlite" AFTER_DB="$APP_DIR/data/platform.sqlite" node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const before = new DatabaseSync(process.env.BEFORE_DB, { readOnly: true });
const after = new DatabaseSync(process.env.AFTER_DB, { readOnly: true });
const ids = [2, 3, 48, 49, 51, 52, 53];
const marks = ids.map(() => "?").join(",");
const scalar = (db, sql, ...args) => Number(db.prepare(sql).get(...args).value);
for (const table of ["logs", "log_items", "project_aliases"]) {
  const left = scalar(before, `SELECT COUNT(*) AS value FROM ${table}`);
  const right = scalar(after, `SELECT COUNT(*) AS value FROM ${table}`);
  if (left !== right) throw new Error(`${table} count changed: ${left} -> ${right}`);
}
for (const id of ids) {
  const beforeItems = scalar(before, "SELECT COUNT(*) AS value FROM log_items WHERE project_id = ?", id);
  const afterItems = scalar(after, "SELECT COUNT(*) AS value FROM log_items WHERE project_id = ?", id);
  const beforeAliases = scalar(before, "SELECT COUNT(*) AS value FROM project_aliases WHERE project_id = ?", id);
  const afterAliases = scalar(after, "SELECT COUNT(*) AS value FROM project_aliases WHERE project_id = ?", id);
  if (beforeItems !== afterItems || beforeAliases !== afterAliases) throw new Error(`project ${id} history or aliases changed`);
}
const expected = new Map([
  [2, ["强轩轩", ["强轩轩", "翟少波", "朱志玮"]]],
  [3, ["强轩轩", ["强轩轩"]]],
  [48, ["胡文华", ["周毓凡", "胡文华"]]],
  [49, ["徐佳雨", ["徐佳雨", "闫思源"]]],
  [51, ["胡文华", ["周毓凡", "徐佳雨", "朱志玮", "胡文华", "闫思源"]]],
  [52, ["闫思源", ["周毓凡", "闫思源"]]],
  [53, ["闫思源", ["闫思源"]]],
]);
for (const id of ids) {
  const project = after.prepare("SELECT p.source, u.name AS owner FROM projects p JOIN users u ON u.id = p.owner_user_id WHERE p.id = ? AND p.active = 1 AND p.status = 'in_progress'").get(id);
  if (!project || project.source === "dingtalk") throw new Error(`project ${id} is not formal`);
  const members = after.prepare("SELECT u.name FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name").all(id).map((row) => row.name);
  const [owner, expectedMembers] = expected.get(id);
  if (project.owner !== owner || JSON.stringify(members) !== JSON.stringify([...expectedMembers].sort())) {
    throw new Error(`project ${id} assignment mismatch: ${project.owner}/${members.join(",")}`);
  }
}
const broken = scalar(after, `SELECT COUNT(*) AS value FROM log_items WHERE project_id IN (${marks}) AND (scope_type <> 'project' OR aff <> CAST(project_id AS TEXT) OR project_name_snapshot IS NULL)`, ...ids);
if (broken !== 0) throw new Error(`${broken} broken project log references`);
console.log(JSON.stringify({ projects: ids.length, preserved: ["logs", "log_items", "project_aliases"], broken }));
before.close();
after.close();
NODE

echo "[6/7] Verifying public service and startup logs"
systemctl is-active --quiet dailylog
systemctl is-active --quiet dailyreport
wait_for_url "$PUBLIC_BASE/healthz" 15
wait_for_url "$PUBLIC_BASE/readyz" 15
test "$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/api/fill/meta")" = "401"
grep -q '20260901-external-project-members-v31b' "$APP_DIR/public/index.html"
if grep -R -n -E 'autoMatchFillProjects|projectMatches|fill-project-matcher' "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/tests"; then
  echo "fill project auto-matching references remain" >&2
  false
fi
if journalctl -u dailylog --since "$DEPLOY_STARTED_AT" --no-pager | grep -E '"evt":"(request_error|config_warning)"'; then
  echo "new dailylog errors detected" >&2
  false
fi

echo "[7/7] Recording provenance"
BASELINE_DIGEST="$(sha256sum "$UPLOAD_DIR/base.sha256" | awk '{print $1}')"
RELEASE_DIGEST="$(sha256sum "$UPLOAD_DIR/release.sha256" | awk '{print $1}')"
printf '%s\n' \
  "release=$RELEASE_ID" \
  "deployed_at=$(date --iso-8601=seconds)" \
  "scope=exclude-external-project-owners" \
  "baseline_digest=$BASELINE_DIGEST" \
  "release_digest=$RELEASE_DIGEST" \
  "projects=2,3,48,49,51,52,53" \
  "backup=$BACKUP_DIR" \
  > "$BACKUP_DIR/DEPLOYED_HOTFIX.new"
install -o root -g root -m 0644 "$BACKUP_DIR/DEPLOYED_HOTFIX.new" /opt/dailylog/DEPLOYED_HOTFIX
cat /opt/dailylog/DEPLOYED_HOTFIX
trap - ERR
CUTOVER_STARTED=0
echo "DEPLOYMENT_OK $RELEASE_ID"
