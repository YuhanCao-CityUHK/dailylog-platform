import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveWorkbenchSqlitePath } from "../infra/workbench-db-path";

export interface ProjectViewRosterMember {
  userid: string;
  name?: string;
  source?: "discovery" | "manual";
  addedAt?: string;
}

export interface ProjectViewRosterStore {
  db: DatabaseSync;
  close(): void;
}

interface RosterRow {
  user_id: string;
  name: string | null;
  source: string | null;
  added_at: string | null;
}

function ensureTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_report_project_view_roster (
      view_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      source TEXT,
      added_at TEXT,
      PRIMARY KEY (view_id, user_id)
    );
  `);
}

function rowToMember(row: RosterRow): ProjectViewRosterMember {
  const member: ProjectViewRosterMember = { userid: row.user_id };
  if (row.name) member.name = row.name;
  if (row.source === "discovery" || row.source === "manual") {
    member.source = row.source;
  }
  if (row.added_at) member.addedAt = row.added_at;
  return member;
}

export function createProjectViewRosterStore(
  dbPath = resolveWorkbenchSqlitePath(),
): ProjectViewRosterStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensureTable(db);
  return {
    db,
    close() {
      db.close();
    },
  };
}

export function listProjectViewRoster(
  viewId: string,
  store: ProjectViewRosterStore,
): ProjectViewRosterMember[] {
  const rows = store.db
    .prepare(
      `SELECT user_id, name, source, added_at
       FROM daily_report_project_view_roster
       WHERE view_id = ?
       ORDER BY added_at ASC, user_id ASC`,
    )
    .all(viewId.trim()) as unknown as RosterRow[];
  return rows.map(rowToMember);
}

export function addProjectViewRosterMember(
  viewId: string,
  member: ProjectViewRosterMember,
  store: ProjectViewRosterStore,
): void {
  const userid = member.userid.trim();
  if (!userid) return;
  const normalizedViewId = viewId.trim();
  if (!normalizedViewId) return;

  const addedAt = member.addedAt ?? new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO daily_report_project_view_roster (view_id, user_id, name, source, added_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(view_id, user_id) DO NOTHING`,
    )
    .run(
      normalizedViewId,
      userid,
      member.name?.trim() || null,
      member.source ?? null,
      addedAt,
    );
}

export function removeProjectViewRosterMember(
  viewId: string,
  userid: string,
  store: ProjectViewRosterStore,
): void {
  store.db
    .prepare(
      `DELETE FROM daily_report_project_view_roster
       WHERE view_id = ? AND user_id = ?`,
    )
    .run(viewId.trim(), userid.trim());
}

export function mergeDiscoveryMembers(
  viewId: string,
  members: ProjectViewRosterMember[],
  store: ProjectViewRosterStore,
): number {
  const normalizedViewId = viewId.trim();
  if (!normalizedViewId) return 0;

  const existsStmt = store.db.prepare(
    `SELECT 1 AS ok
     FROM daily_report_project_view_roster
     WHERE view_id = ? AND user_id = ?`,
  );
  let added = 0;
  for (const member of members) {
    const userid = member.userid.trim();
    if (!userid) continue;
    const existing = existsStmt.get(normalizedViewId, userid) as { ok?: number } | undefined;
    if (existing) continue;
    addProjectViewRosterMember(
      normalizedViewId,
      {
        ...member,
        source: member.source ?? "discovery",
      },
      store,
    );
    added += 1;
  }
  return added;
}
