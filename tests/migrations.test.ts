import assert from "node:assert/strict";
import test from "node:test";
import { applyPlatformMigrations, listAppliedMigrations } from "../src/infra/migrations";
import { addUser, createLegacyFixtureDb } from "./helpers";
import { listFinanceProjectCodes, seedFinanceProjectCodes } from "../src/platform/finance-project-codes";

test("旧项目和日志无损升级，重复迁移安全", () => {
  const db = createLegacyFixtureDb();
  const userId = addUser(db, { name: "测试员工", role: "lead", dept: "研发部" });
  const projectId = Number(
    db.prepare("INSERT INTO projects (name, owner_user_id, created_by) VALUES (?, ?, ?)").run("  日报Ａ项目  ", userId, userId)
      .lastInsertRowid,
  );
  db.prepare("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)").run(projectId, userId);
  const logId = Number(
    db
      .prepare(
        "INSERT INTO logs (user_id, date, status, quality, submitted_at, updated_at) VALUES (?, '2026-08-25', 'submitted', 'good', ?, ?)",
      )
      .run(userId, "2026-08-25T09:00:00.000Z", "2026-08-25T09:00:00.000Z").lastInsertRowid,
  );
  db.prepare("INSERT INTO log_items (log_id, ord, aff, text, hours) VALUES (?, 1, ?, '完成迁移验证', 2.5)").run(
    logId,
    String(projectId),
  );

  applyPlatformMigrations(db);
  applyPlatformMigrations(db);

  assert.deepEqual(
    listAppliedMigrations(db).map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  const project = db
    .prepare("SELECT normalized_name, status, owner_user_id FROM projects WHERE id = ?")
    .get(projectId) as { normalized_name: string; status: string; owner_user_id: number };
  assert.equal(project.normalized_name, "日报a项目");
  assert.equal(project.status, "in_progress");
  assert.equal(project.owner_user_id, userId);

  const item = db
    .prepare(
      "SELECT scope_type, project_id, project_name_snapshot, work_summary, result_text FROM log_items WHERE log_id = ?",
    )
    .get(logId) as Record<string, unknown>;
  assert.equal(item.scope_type, "project");
  assert.equal(item.project_id, projectId);
  assert.equal(item.project_name_snapshot, "  日报Ａ项目  ");
  assert.equal(item.work_summary, "完成迁移验证");
  assert.equal(item.result_text, "完成迁移验证");

  const log = db.prepare("SELECT total_hours, current_version FROM logs WHERE id = ?").get(logId) as {
    total_hours: number;
    current_version: number;
  };
  assert.equal(log.total_hours, 2.5);
  assert.equal(log.current_version, 1);
  const version = db.prepare("SELECT snapshot_json FROM log_versions WHERE log_id = ?").get(logId) as {
    snapshot_json: string;
    };
    assert.doesNotMatch(version.snapshot_json, /reference|chat|document/i);
    const messageColumns = db.prepare("PRAGMA table_info(assistant_messages)").all() as unknown as Array<{ name: string }>;
  assert.equal(messageColumns.some((column) => column.name === "focus_json"), true);
  assert.equal(messageColumns.some((column) => column.name === "tool_trace_json"), true);
  assert.equal(
    Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'assistant_changes'").get()),
      true,
    );
  db.close();
});

test("规范化项目名唯一索引阻止全半角重复", () => {
  const db = createLegacyFixtureDb();
  applyPlatformMigrations(db);
  const userId = addUser(db, { name: "负责人", role: "lead" });
  db.prepare(
    `INSERT INTO projects
      (name, normalized_name, owner_user_id, status, source, active, created_by, updated_at)
     VALUES ('项目A', '项目a', ?, 'in_progress', 'user', 1, ?, ?)`,
  ).run(userId, userId, new Date().toISOString());
  assert.throws(() => {
    db.prepare(
      `INSERT INTO projects
        (name, normalized_name, owner_user_id, status, source, active, created_by, updated_at)
       VALUES ('项目Ａ', '项目a', ?, 'in_progress', 'user', 1, ?, ?)`,
    ).run(userId, userId, new Date().toISOString());
  });
  db.close();
});

test("财务项目编码表可幂等同步并按大项目隔离", () => {
  const db = createLegacyFixtureDb();
  applyPlatformMigrations(db);
  const octId = Number(db.prepare("INSERT INTO projects (name, source, active) VALUES ('OCT', 'user', 1)").run().lastInsertRowid);
  const claId = Number(db.prepare("INSERT INTO projects (name, source, active) VALUES ('CLA', 'user', 1)").run().lastInsertRowid);
  seedFinanceProjectCodes(db);
  seedFinanceProjectCodes(db);
  const oct = listFinanceProjectCodes(octId, db);
  const cla = listFinanceProjectCodes(claId, db);
  assert.ok(oct.some((row) => row.name.includes("2401-血管内光学相干影像系统-ZERO（ODM）")));
  assert.ok(cla.some((row) => row.name.startsWith("2105-CLA-2105")));
  assert.equal(new Set(oct.map((row) => row.code)).size, oct.length);
  assert.equal(oct.every((row) => row.projectId === octId), true);
  db.close();
});
