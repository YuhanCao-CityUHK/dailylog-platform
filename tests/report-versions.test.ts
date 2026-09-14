import assert from "node:assert/strict";
import test from "node:test";
import { readFormalReport } from "../src/reports/service";
import { recordReportVersion } from "../src/reports/versions";
import { addUser, createMigratedFixtureDb } from "./helpers";

test("正式日报保存结构化版本且快照不包含 Reference", () => {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "日报员工", role: "lead", dept: "研发部" });
  const projectId = Number(
    db
      .prepare(
        `INSERT INTO projects
          (name, normalized_name, owner_user_id, status, source, active, created_by, updated_at)
         VALUES ('日报项目', '日报项目', ?, 'in_progress', 'user', 1, ?, ?)`,
      )
      .run(userId, userId, new Date().toISOString()).lastInsertRowid,
  );
  db.prepare("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)").run(projectId, userId);
  const logId = Number(
    db
      .prepare(
        `INSERT INTO logs
          (user_id, date, status, quality, submitted_at, updated_at, total_hours, current_version)
         VALUES (?, '2026-08-25', 'submitted', 'good', ?, ?, 0, 0)`,
      )
      .run(userId, "2026-08-25T10:00:00.000Z", "2026-08-25T10:00:00.000Z").lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO log_items
      (log_id, ord, aff, text, hours, scope_type, project_id, project_name_snapshot,
       work_status, work_summary, result_text, blocker_text, next_action, support_people_json)
     VALUES (?, 1, ?, '旧兼容文本', 3, 'project', ?, '日报项目', 'blocked',
             '完成日报结构开发', '迁移与权限测试通过', '等待接口 Schema', '使用模拟夹具继续验证', '[]')`,
  ).run(logId, String(projectId), projectId);

  assert.equal(recordReportVersion(logId, userId, "current_day_form", db), 1);
  db.prepare("UPDATE log_items SET result_text = '补充集成测试通过' WHERE log_id = ?").run(logId);
  assert.equal(recordReportVersion(logId, userId, "current_day_form", db), 2);

  const report = readFormalReport(logId, db);
  assert.equal(report?.currentVersion, 2);
  assert.equal(report?.totalHours, 3);
  assert.equal(report?.items[0].status, "blocked");
  assert.equal(report?.items[0].resultText, "补充集成测试通过");
  const versions = db
    .prepare("SELECT version, snapshot_json FROM log_versions WHERE log_id = ? ORDER BY version")
    .all(logId) as unknown as Array<{ version: number; snapshot_json: string }>;
  assert.deepEqual(versions.map((version) => version.version), [1, 2]);
  for (const version of versions) assert.doesNotMatch(version.snapshot_json, /referenceIds|chat_private|sourceSummary/);
  db.close();
});
