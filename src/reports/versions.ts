import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../infra/db";
import { readFormalReport } from "./service";

export type ReportVersionSource =
  | "migration"
  | "current_day_assistant"
  | "current_day_form"
  | "previous_workday_edit"
  | "admin_correction";

/** 在调用方事务内保存不含 Reference 的完整正式结构快照。 */
export function recordReportVersion(
  logId: number,
  actorUserId: number,
  source: ReportVersionSource,
  db: DatabaseSync,
): number {
  const report = readFormalReport(logId, db);
  if (!report) throw new Error("无法为不存在的正式日报创建版本");
  const current = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM log_versions WHERE log_id = ?")
    .get(logId) as { version: number };
  const version = current.version + 1;
  const stamp = nowIso();
  const snapshot = { ...report, currentVersion: version, updatedAt: stamp };
  db.prepare(
    `INSERT INTO log_versions
      (log_id, version, actor_user_id, source, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(logId, version, actorUserId, source, JSON.stringify(snapshot), stamp);
  db.prepare("UPDATE logs SET current_version = ?, total_hours = ?, updated_at = ? WHERE id = ?").run(
    version,
    report.totalHours,
    stamp,
    logId,
  );
  return version;
}
