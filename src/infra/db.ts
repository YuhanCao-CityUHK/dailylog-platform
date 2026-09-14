/** 平台主数据库（node:sqlite，零外部依赖）。日报汇总(照搬模块)使用独立的 workbench.sqlite，互不干扰。 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config";
import { applyPlatformMigrations } from "./migrations";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const file = path.join(CONFIG.dataDir, "platform.sqlite");
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('dingtalk','local')),
    dd_userid TEXT UNIQUE,
    login_name TEXT UNIQUE,
    name TEXT NOT NULL,
    title TEXT DEFAULT '',
    dept TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'emp' CHECK (role IN ('emp','lead','mgr','exec','admin')),
    is_external INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_pw INTEGER NOT NULL DEFAULT 0,
    exempt_reminder INTEGER NOT NULL DEFAULT 0,
    should_submit INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS local_credentials (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    password_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    password_changed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT DEFAULT '',
    ua TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    owner_user_id INTEGER REFERENCES users(id),
    descr TEXT DEFAULT '',
    source TEXT NOT NULL DEFAULT 'user',
    active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS project_aliases (
    normalized_alias TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_project_aliases_project ON project_aliases(project_id);
  CREATE TABLE IF NOT EXISTS user_default_projects (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    project_id INTEGER NOT NULL REFERENCES projects(id)
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    use_count INTEGER NOT NULL DEFAULT 0,
    risk INTEGER NOT NULL DEFAULT 0,
    warm INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','deleted')),
    quality TEXT NOT NULL DEFAULT 'normal' CHECK (quality IN ('ex','vg','good','normal')),
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_user_date_active
    ON logs(user_id, date) WHERE status = 'submitted';
  CREATE TABLE IF NOT EXISTS log_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER NOT NULL REFERENCES logs(id),
    ord INTEGER NOT NULL,
    aff TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    hours REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_items_log ON log_items(log_id);
  CREATE TABLE IF NOT EXISTS item_cats (
    item_id INTEGER NOT NULL REFERENCES log_items(id),
    cat_id INTEGER NOT NULL REFERENCES categories(id),
    confirmed INTEGER NOT NULL DEFAULT 0,
    manual INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, cat_id)
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES log_items(id),
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS drafts (
    user_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  );
  CREATE TABLE IF NOT EXISTS pending_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS follows (
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('p','c')),
    target_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, target_id)
  );
  CREATE TABLE IF NOT EXISTS adopt_stats (
    user_id INTEGER NOT NULL REFERENCES users(id),
    week TEXT NOT NULL,
    auto_count INTEGER NOT NULL DEFAULT 0,
    confirmed_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, week)
  );
  CREATE TABLE IF NOT EXISTS qa_convos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL DEFAULT '新对话',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS qa_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    convo_id INTEGER NOT NULL REFERENCES qa_convos(id),
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agg_cache (
    kind TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (kind, cache_key)
  );
  CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY,
    name TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS workdays_extra (
    date TEXT PRIMARY KEY,
    name TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS reminder_log (
    date TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (date, user_id)
  );
  CREATE TABLE IF NOT EXISTS rd_department_digest_state (
    date_ymd TEXT NOT NULL,
    recipient_userid TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    robot_message_key TEXT DEFAULT '',
    PRIMARY KEY (date_ymd, recipient_userid)
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT DEFAULT ''
  );
  `);
  applyPlatformMigrations(d);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function audit(userId: number | null, action: string, detail = ""): void {
  try {
    getDb()
      .prepare("INSERT INTO audit (user_id, action, detail) VALUES (?, ?, ?)")
      .run(userId, action, detail.slice(0, 2000));
  } catch {
    /* 审计失败不阻断业务 */
  }
}
