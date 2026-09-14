import { DatabaseSync } from "node:sqlite";
import { applyPlatformMigrations } from "../src/infra/migrations";

export function createLegacyFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      dd_userid TEXT UNIQUE,
      login_name TEXT UNIQUE,
      name TEXT NOT NULL,
      title TEXT DEFAULT '',
      dept TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'emp',
      is_external INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_pw INTEGER NOT NULL DEFAULT 0,
      exempt_reminder INTEGER NOT NULL DEFAULT 0,
      should_submit INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      owner_user_id INTEGER REFERENCES users(id),
      descr TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (project_id, user_id)
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      quality TEXT NOT NULL DEFAULT 'normal',
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX idx_logs_user_date_active ON logs(user_id, date) WHERE status = 'submitted';
    CREATE TABLE log_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL REFERENCES logs(id),
      ord INTEGER NOT NULL,
      aff TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      hours REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE item_cats (
      item_id INTEGER NOT NULL REFERENCES log_items(id),
      cat_id INTEGER NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0,
      manual INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, cat_id)
    );
    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES log_items(id),
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function createMigratedFixtureDb(): DatabaseSync {
  const db = createLegacyFixtureDb();
  applyPlatformMigrations(db);
  return db;
}

export function addUser(
  db: DatabaseSync,
  input: { name: string; role?: string; dept?: string; external?: boolean },
): number {
  const result = db
    .prepare("INSERT INTO users (kind, name, role, dept, is_external) VALUES ('dingtalk', ?, ?, ?, ?)")
    .run(input.name, input.role ?? "emp", input.dept ?? "", input.external ? 1 : 0);
  return Number(result.lastInsertRowid);
}
