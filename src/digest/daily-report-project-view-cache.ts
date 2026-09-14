import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveWorkbenchSqlitePath } from "../infra/workbench-db-path";
import type { OrgDigest } from "./daily-report-build";

export type ProjectViewCachePayload = {
  submitted: OrgDigest["submitted"];
  errors: OrgDigest["errors"];
  /** CTO 合并早报：每项目一行 plain text overview */
  ctoOverview?: string;
  ctoOverviewGeneratedAt?: string;
};

export interface ProjectViewCacheStore {
  db: DatabaseSync;
  close(): void;
}

interface CacheRow {
  payload_json: string;
  hit_count: number;
  scanned_at: string;
}

function ensureTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_report_project_view_cache (
      view_id TEXT NOT NULL,
      date_ymd TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY (view_id, date_ymd)
    );
  `);
}

export function createProjectViewCacheStore(
  dbPath = resolveWorkbenchSqlitePath(),
): ProjectViewCacheStore {
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

export function getProjectViewCache(
  viewId: string,
  dateYmd: string,
  store: ProjectViewCacheStore,
): { payload: ProjectViewCachePayload; scannedAt: string; hitCount: number } | null {
  const row = store.db
    .prepare(
      `SELECT payload_json, hit_count, scanned_at
       FROM daily_report_project_view_cache
       WHERE view_id = ? AND date_ymd = ?`,
    )
    .get(viewId.trim(), dateYmd.trim()) as CacheRow | undefined;
  if (!row) return null;

  const payload = JSON.parse(row.payload_json) as ProjectViewCachePayload;
  return {
    payload,
    scannedAt: row.scanned_at,
    hitCount: row.hit_count,
  };
}

export function putProjectViewCache(
  viewId: string,
  dateYmd: string,
  payload: ProjectViewCachePayload,
  store: ProjectViewCacheStore,
): void {
  const normalizedViewId = viewId.trim();
  const normalizedDateYmd = dateYmd.trim();
  if (!normalizedViewId || !normalizedDateYmd) return;

  const hitCount = payload.submitted.length;
  const scannedAt = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO daily_report_project_view_cache
         (view_id, date_ymd, payload_json, hit_count, scanned_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(view_id, date_ymd) DO UPDATE SET
         payload_json = excluded.payload_json,
         hit_count = excluded.hit_count,
         scanned_at = excluded.scanned_at`,
    )
    .run(
      normalizedViewId,
      normalizedDateYmd,
      JSON.stringify(payload),
      hitCount,
      scannedAt,
    );
}

export function deleteProjectViewCache(
  viewId: string,
  dateYmd: string,
  store: ProjectViewCacheStore,
): void {
  store.db
    .prepare(
      `DELETE FROM daily_report_project_view_cache
       WHERE view_id = ? AND date_ymd = ?`,
    )
    .run(viewId.trim(), dateYmd.trim());
}
