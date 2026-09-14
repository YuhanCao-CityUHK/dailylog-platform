import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformLogCollector } from "../src/assistant/collectors/platform-log-collector";
import { addUser, createMigratedFixtureDb } from "./helpers";

test("平台我的日志采集最近工作日的结构化结果和延续线索", async () => {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "测试员工", dept: "研发部" });
  const logId = Number(
    db
      .prepare(
        `INSERT INTO logs
          (user_id, date, status, quality, submitted_at, updated_at, total_hours, current_version)
         VALUES (?, '2026-08-22', 'submitted', 'good', ?, ?, 2, 1)`,
      )
      .run(userId, "2026-08-22T10:00:00.000Z", "2026-08-22T10:00:00.000Z").lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO log_items
      (log_id, ord, aff, text, hours, scope_type, work_status, work_summary,
       result_text, blocker_text, next_action, support_people_json)
     VALUES (?, 1, 'dept', '兼容文本', 2, 'department_daily', 'blocked',
             '开发上下文任务', '完成任务表设计', '等待 DWS Schema', '继续用模拟夹具验证', '[]')`,
  ).run(logId);
  const result = await createPlatformLogCollector(db).collect({
    platformUserId: userId,
    ddUserid: "user-1",
    profile: "",
    workDate: "2026-08-25",
    historyWorkDates: ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-25"],
    now: new Date("2026-08-25T08:00:00.000Z"),
    run: async () => ({}),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.evidences.length, 1);
  assert.match(result.evidences[0].summary, /等待 DWS Schema/);
  assert.match(result.evidences[0].summary, /继续用模拟夹具验证/);
  assert.equal(result.evidences[0].privacyScope, "employee_only");
  db.close();
});
