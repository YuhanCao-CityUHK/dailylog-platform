import type { DatabaseSync } from "node:sqlite";
import { normalizeProjectName } from "../projects/name";
import { ensureFinanceProjectCodeTable, seedFinanceProjectCodes } from "../platform/finance-project-codes";

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumn(db: DatabaseSync, table: string, column: string, sql: string): void {
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
}

function seedInitialLogVersions(db: DatabaseSync): void {
  const logs = db
    .prepare(
      `SELECT id, user_id, date, status, quality, submitted_at, updated_at
         FROM logs WHERE status = 'submitted' AND current_version = 0 ORDER BY id`,
    )
    .all() as unknown as Array<{
    id: number;
    user_id: number;
    date: string;
    status: string;
    quality: string;
    submitted_at: string;
    updated_at: string;
  }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO log_versions
      (log_id, version, actor_user_id, source, snapshot_json, created_at)
     VALUES (?, 1, ?, 'migration', ?, ?)`,
  );
  const update = db.prepare("UPDATE logs SET current_version = 1, total_hours = ? WHERE id = ?");
  for (const log of logs) {
    const items = db
      .prepare(
        `SELECT id, ord, scope_type, project_id, project_name_snapshot, work_status,
                work_summary, result_text, hours, blocker_text, next_action,
                support_needed, support_people_json, tomorrow_plan
           FROM log_items WHERE log_id = ? ORDER BY ord`,
      )
      .all(log.id) as unknown as Array<Record<string, unknown>>;
    const totalHours = Math.round(
      items.reduce((sum, item) => sum + (Number(item.hours) || 0), 0) * 100,
    ) / 100;
    insert.run(
      log.id,
      log.user_id,
      JSON.stringify({
        id: log.id,
        userId: log.user_id,
        workDate: log.date,
        status: log.status,
        quality: log.quality,
        totalHours,
        submittedAt: log.submitted_at,
        updatedAt: log.updated_at,
        version: 1,
        items,
      }),
      log.updated_at,
    );
    update.run(totalHours, log.id);
  }
}

function migrateDailyAssistantFoundation(db: DatabaseSync): void {
  addColumn(db, "projects", "normalized_name", "normalized_name TEXT");
  addColumn(db, "projects", "status", "status TEXT NOT NULL DEFAULT 'in_progress'");
  addColumn(db, "projects", "updated_at", "updated_at TEXT NOT NULL DEFAULT ''");

  db.exec(`
    UPDATE projects
       SET owner_user_id = COALESCE(
             owner_user_id,
             created_by,
             (SELECT MIN(pm.user_id) FROM project_members pm WHERE pm.project_id = projects.id)
           )
     WHERE source <> 'dingtalk' AND owner_user_id IS NULL;
  `);

  const projects = db
    .prepare("SELECT id, name, active FROM projects ORDER BY id")
    .all() as unknown as Array<{ id: number; name: string; active: number }>;
  const used = new Set<string>();
  const updateProject = db.prepare(
    "UPDATE projects SET normalized_name = ?, status = ?, updated_at = COALESCE(NULLIF(updated_at, ''), created_at, datetime('now')) WHERE id = ?",
  );
  for (const project of projects) {
    const canonical = normalizeProjectName(project.name) || `project-${project.id}`;
    const stored = used.has(canonical) ? `${canonical}#legacy-${project.id}` : canonical;
    used.add(stored);
    updateProject.run(stored, project.active === 1 ? "in_progress" : "completed", project.id);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_normalized_name ON projects(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_projects_owner_status ON projects(owner_user_id, status);

    CREATE TABLE IF NOT EXISTS department_managers (
      department_name TEXT NOT NULL,
      manager_user_id INTEGER NOT NULL REFERENCES users(id),
      synced_at TEXT NOT NULL,
      PRIMARY KEY (department_name, manager_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_department_managers_user ON department_managers(manager_user_id);

    CREATE TABLE IF NOT EXISTS project_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      before_json TEXT NOT NULL DEFAULT '{}',
      after_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_audit_project ON project_audit_log(project_id, id);

    CREATE TABLE IF NOT EXISTS project_match_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL,
      feature_hash TEXT NOT NULL,
      suggested_project_id INTEGER REFERENCES projects(id),
      suggested_score REAL,
      confirmed_scope_type TEXT NOT NULL,
      confirmed_project_id INTEGER REFERENCES projects(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_match_feedback_user_date
      ON project_match_feedback(user_id, work_date);
  `);

  addColumn(db, "logs", "total_hours", "total_hours REAL NOT NULL DEFAULT 0");
  addColumn(db, "logs", "current_version", "current_version INTEGER NOT NULL DEFAULT 0");

  addColumn(db, "log_items", "scope_type", "scope_type TEXT");
  addColumn(db, "log_items", "project_id", "project_id INTEGER REFERENCES projects(id)");
  addColumn(db, "log_items", "project_name_snapshot", "project_name_snapshot TEXT");
  addColumn(db, "log_items", "work_status", "work_status TEXT");
  addColumn(db, "log_items", "work_summary", "work_summary TEXT");
  addColumn(db, "log_items", "result_text", "result_text TEXT");
  addColumn(db, "log_items", "blocker_text", "blocker_text TEXT");
  addColumn(db, "log_items", "next_action", "next_action TEXT");
  addColumn(db, "log_items", "support_needed", "support_needed TEXT");
  addColumn(db, "log_items", "support_people_json", "support_people_json TEXT");
  addColumn(db, "log_items", "tomorrow_plan", "tomorrow_plan TEXT");

  db.exec(`
    UPDATE log_items
       SET scope_type = CASE
             WHEN aff <> 'dept' AND EXISTS (SELECT 1 FROM projects p WHERE CAST(p.id AS TEXT) = log_items.aff)
               THEN 'project'
             ELSE 'department_daily'
           END
     WHERE scope_type IS NULL OR scope_type = '';
    UPDATE log_items
       SET project_id = CAST(aff AS INTEGER)
     WHERE scope_type = 'project' AND project_id IS NULL;
    UPDATE log_items
       SET project_name_snapshot = (SELECT p.name FROM projects p WHERE p.id = log_items.project_id)
     WHERE scope_type = 'project' AND (project_name_snapshot IS NULL OR project_name_snapshot = '');
    UPDATE log_items
       SET work_status = COALESCE(NULLIF(work_status, ''), 'in_progress'),
           work_summary = COALESCE(NULLIF(work_summary, ''), text),
           result_text = COALESCE(NULLIF(result_text, ''), text),
           support_people_json = COALESCE(NULLIF(support_people_json, ''), '[]');
    UPDATE logs
       SET total_hours = COALESCE((SELECT ROUND(SUM(i.hours), 2) FROM log_items i WHERE i.log_id = logs.id), 0);

    CREATE INDEX IF NOT EXISTS idx_log_items_project ON log_items(project_id);
    CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date);

    CREATE TABLE IF NOT EXISTS log_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL REFERENCES logs(id),
      version INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      source TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (log_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_log_versions_log ON log_versions(log_id, version);
  `);
  seedInitialLogVersions(db);
}

function migrateOrganizationSyncAndRepair(db: DatabaseSync): void {
  addColumn(db, "users", "org_synced_at", "org_synced_at TEXT");
  db.exec(`
    UPDATE projects
       SET owner_user_id = COALESCE(
             owner_user_id,
             created_by,
             (SELECT MIN(pm.user_id) FROM project_members pm WHERE pm.project_id = projects.id)
           )
     WHERE source <> 'dingtalk' AND owner_user_id IS NULL;
  `);
  seedInitialLogVersions(db);
}

function migrateAssistantConversations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL,
      context_job_id TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('complete','partial','manual')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','submitted','abandoned')),
      outside_work_asked INTEGER NOT NULL DEFAULT 0,
      outside_work_answered INTEGER NOT NULL DEFAULT 0,
      force_draft INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (user_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_sessions_user_date
      ON assistant_sessions(user_id, work_date);

    CREATE TABLE IF NOT EXISTS assistant_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      kind TEXT NOT NULL DEFAULT 'message',
      content TEXT NOT NULL,
      structured_json TEXT NOT NULL DEFAULT '{}',
      client_message_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, client_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_messages_session
      ON assistant_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS assistant_session_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      ord INTEGER NOT NULL,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('project','department_daily','unconfirmed')),
      project_id INTEGER REFERENCES projects(id),
      project_name_snapshot TEXT,
      work_status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (work_status IN ('completed','in_progress','blocked','no_progress')),
      work_summary TEXT NOT NULL,
      result_text TEXT NOT NULL DEFAULT '',
      hours REAL,
      blocker_text TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      support_needed TEXT NOT NULL DEFAULT '',
      support_people_json TEXT NOT NULL DEFAULT '[]',
      tomorrow_plan TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL CHECK (source_kind IN ('candidate','employee')),
      reference_ids_json TEXT NOT NULL DEFAULT '[]',
      needs_confirmation_json TEXT NOT NULL DEFAULT '[]',
      employee_confirmed INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_session_items_session
      ON assistant_session_items(session_id, deleted, ord);
  `);
}

function migrateAssistantSubmissionIdempotency(db: DatabaseSync): void {
  addColumn(db, "assistant_sessions", "submitted_log_id", "submitted_log_id INTEGER REFERENCES logs(id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_submission_idempotency (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      log_id INTEGER NOT NULL REFERENCES logs(id),
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, work_date, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_submission_log
      ON assistant_submission_idempotency(log_id, version);
  `);
}

function migrateAssistantAutomation(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_day_status (
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('normal','full_leave','partial_leave','business_trip','outing')),
      source TEXT NOT NULL DEFAULT 'attendance_approval',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS idx_employee_day_status_date
      ON employee_day_status(work_date, status);

    CREATE TABLE IF NOT EXISTS assistant_schedule_runs (
      kind TEXT NOT NULL,
      work_date TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (kind, work_date, user_id)
    );

    CREATE TABLE IF NOT EXISTS assistant_notification_log (
      kind TEXT NOT NULL CHECK (kind IN ('today','overdue')),
      work_date TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK (status IN ('sent','skipped_full_leave')),
      sent_at TEXT NOT NULL,
      PRIMARY KEY (kind, work_date, user_id)
    );
  `);
}

function migrateAssistantCandidateSemantics(db: DatabaseSync): void {
  addColumn(db, "assistant_sessions", "analysis_mode", "analysis_mode TEXT NOT NULL DEFAULT 'manual'");
  addColumn(db, "assistant_session_items", "candidate_origin", "candidate_origin TEXT NOT NULL DEFAULT 'today'");
  // 旧版本可能把历史日志正文保存为系统候选。仅删除从未被员工确认的候选，
  // 员工补充、确认/修改过的事项和正式日报完全不在清理范围内。
  db.exec(`
    DELETE FROM assistant_session_items
     WHERE source_kind = 'candidate' AND employee_confirmed = 0;
  `);
}

function migrateAssistantV2Harness(db: DatabaseSync): void {
  addColumn(db, "assistant_messages", "focus_json", "focus_json TEXT NOT NULL DEFAULT 'null'");
  addColumn(db, "assistant_messages", "tool_trace_json", "tool_trace_json TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, "assistant_sessions", "prepared_hash", "prepared_hash TEXT");
  addColumn(db, "assistant_sessions", "prepared_revision", "prepared_revision INTEGER");
  addColumn(db, "assistant_sessions", "prepared_message_id", "prepared_message_id INTEGER REFERENCES assistant_messages(id)");
  addColumn(db, "assistant_sessions", "prepared_at", "prepared_at TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_changes (
      change_id TEXT PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      op TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      source_message_id INTEGER NOT NULL REFERENCES assistant_messages(id),
      created_at TEXT NOT NULL,
      undone_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_changes_session_revision
      ON assistant_changes(session_id, revision);
    CREATE INDEX IF NOT EXISTS idx_assistant_changes_source_message
      ON assistant_changes(source_message_id);
  `);
}

function migrateAssistantV2ChangeReceipts(db: DatabaseSync): void {
  // 变更账本保存人类可读回执（投影“最近变更”与模型上下文）和模型实际请求的操作（评测与审计精确还原）。
  addColumn(db, "assistant_changes", "receipts_json", "receipts_json TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, "assistant_changes", "operations_json", "operations_json TEXT NOT NULL DEFAULT '[]'");
}

function migrateAssistantEventProjection(db: DatabaseSync): void {
  addColumn(db, "assistant_session_items", "source_completeness", "source_completeness TEXT NOT NULL DEFAULT 'complete'");
  addColumn(db, "assistant_session_items", "candidate_confidence", "candidate_confidence REAL NOT NULL DEFAULT 1");
  addColumn(db, "assistant_session_items", "missing_facts_json", "missing_facts_json TEXT NOT NULL DEFAULT '[]'");
}

function migrateFinanceProjectCodes(db: DatabaseSync): void {
  ensureFinanceProjectCodeTable(db);
  addColumn(db, "log_items", "finance_project_code_id", "finance_project_code_id INTEGER REFERENCES finance_project_codes(id)");
  addColumn(db, "assistant_session_items", "finance_project_code_id", "finance_project_code_id INTEGER REFERENCES finance_project_codes(id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_log_items_finance_project_code ON log_items(finance_project_code_id);");
  seedFinanceProjectCodes(db);
}

const MIGRATIONS: Migration[] = [
  { version: 2, name: "daily_assistant_foundation", up: migrateDailyAssistantFoundation },
  { version: 3, name: "organization_sync_and_version_repair", up: migrateOrganizationSyncAndRepair },
  { version: 4, name: "assistant_conversations", up: migrateAssistantConversations },
  { version: 5, name: "assistant_submission_idempotency", up: migrateAssistantSubmissionIdempotency },
  { version: 6, name: "assistant_automation", up: migrateAssistantAutomation },
  { version: 7, name: "assistant_temporal_candidates", up: migrateAssistantCandidateSemantics },
  { version: 8, name: "assistant_v2_harness", up: migrateAssistantV2Harness },
  { version: 9, name: "assistant_v2_change_receipts", up: migrateAssistantV2ChangeReceipts },
  { version: 10, name: "assistant_event_projection", up: migrateAssistantEventProjection },
  { version: 11, name: "finance_project_codes", up: migrateFinanceProjectCodes },
];

/** 旧表由 db.ts 先兼容创建；这里仅执行可追踪、事务化的增量迁移。 */
export function applyPlatformMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, 'legacy_baseline', ?)",
  ).run(new Date().toISOString());

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as unknown as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function listAppliedMigrations(db: DatabaseSync): Array<{ version: number; name: string; applied_at: string }> {
  return db
    .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
    .all() as unknown as Array<{ version: number; name: string; applied_at: string }>;
}
