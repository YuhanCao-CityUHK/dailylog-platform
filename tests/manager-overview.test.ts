import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../src/auth/types";
import { buildManagerOverview } from "../src/manager/overview-service";
import { createFormalProject } from "../src/projects/service";
import { addUser, createMigratedFixtureDb } from "./helpers";

function sessionUser(id: number, name: string, role: SessionUser["role"], dept: string): SessionUser {
  return {
    id,
    kind: "dingtalk",
    ddUserid: `dd-${id}`,
    name,
    title: "",
    dept,
    role,
    isExternal: false,
    mustChangePw: false,
  };
}

function insertReport(
  db: DatabaseSync,
  userId: number,
  date: string,
  items: Array<{
    projectId?: number;
    summary: string;
    result: string;
    hours: number;
    status?: string;
    blocker?: string;
    support?: string;
  }>,
): void {
  const logId = Number(
    db.prepare(
      `INSERT INTO logs (user_id, date, status, quality, submitted_at, updated_at, total_hours, current_version)
       VALUES (?, ?, 'submitted', 'normal', ?, ?, ?, 1)`,
    ).run(userId, date, `${date}T10:00:00.000Z`, `${date}T10:00:00.000Z`, items.reduce((sum, item) => sum + item.hours, 0)).lastInsertRowid,
  );
  items.forEach((item, index) => {
    const projectName = item.projectId
      ? (db.prepare("SELECT name FROM projects WHERE id = ?").get(item.projectId) as { name: string }).name
      : null;
    db.prepare(
      `INSERT INTO log_items
        (log_id, ord, aff, text, hours, scope_type, project_id, project_name_snapshot,
         work_status, work_summary, result_text, blocker_text, support_needed, support_people_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    ).run(
      logId,
      index + 1,
      item.projectId ? String(item.projectId) : "dept",
      item.result,
      item.hours,
      item.projectId ? "project" : "department_daily",
      item.projectId ?? null,
      projectName,
      item.status ?? "completed",
      item.summary,
      item.result,
      item.blocker ?? null,
      item.support ?? null,
    );
  });
}

test("参与部门主管可看跨部门项目全部正式事项，但不能扩展到其他部门日常或其他项目", () => {
  const db = createMigratedFixtureDb();
  const managerId = addUser(db, { name: "甲部主管", role: "mgr", dept: "甲部" });
  const employeeAId = addUser(db, { name: "甲部员工", role: "emp", dept: "甲部" });
  const ownerBId = addUser(db, { name: "乙部负责人", role: "lead", dept: "乙部" });
  const ownerCId = addUser(db, { name: "丙部负责人", role: "lead", dept: "丙部" });
  db.prepare("UPDATE users SET should_submit = 0 WHERE id = ?").run(managerId);
  const manager = sessionUser(managerId, "甲部主管", "mgr", "甲部");
  const ownerB = sessionUser(ownerBId, "乙部负责人", "lead", "乙部");
  const ownerC = sessionUser(ownerCId, "丙部负责人", "lead", "丙部");
  const cross = createFormalProject(ownerB, { name: "跨部门项目", memberUserIds: [employeeAId] }, db);
  const hidden = createFormalProject(ownerC, { name: "丙部项目" }, db);

  insertReport(db, employeeAId, "2026-08-25", [
    { projectId: cross.id, summary: "甲部交付", result: "完成甲部交付", hours: 2 },
    { summary: "甲部日常", result: "完成甲部日常", hours: 1 },
  ]);
  insertReport(db, ownerBId, "2026-08-25", [
    { projectId: cross.id, summary: "乙部交付", result: "推进乙部交付", hours: 3, status: "blocked", blocker: "等待接口", support: "需要甲部确认" },
    { summary: "乙部日常", result: "完成乙部日常", hours: 2 },
  ]);
  insertReport(db, ownerCId, "2026-08-25", [
    { projectId: hidden.id, summary: "丙部项目事项", result: "完成丙部项目事项", hours: 4 },
  ]);

  const overview = buildManagerOverview(manager, "2026-08-25", db);
  assert.equal(overview.projects.length, 1);
  assert.equal(overview.projects[0].projectName, "跨部门项目");
  assert.equal(overview.projects[0].participantCount, 2);
  assert.equal(overview.projects[0].totalHours, 5);
  assert.deepEqual(overview.departmentDaily.map((row) => row.employeeName), ["甲部员工"]);
  assert.equal(overview.departmentDaily[0].totalHours, 1);
  assert.deepEqual(overview.hoursByDepartment, [{ department: "甲部", hours: 3 }]);
  assert.equal(overview.submission.expected, 1);
  assert.equal(overview.submission.submitted, 1);
  assert.equal(overview.totals.resultItems, 3);
  assert.equal(overview.totals.blockedItems, 1);
  assert.equal(overview.needsAttention.some((item) => item.type === "blocked"), true);
  assert.equal(overview.needsAttention.some((item) => item.type === "support"), true);
  const serialized = JSON.stringify(overview);
  assert.doesNotMatch(serialized, /Reference|referenceIds|contextJob|sourceSummary|rawContext/i);
  assert.doesNotMatch(serialized, /乙部日常|丙部项目事项/);
  db.prepare(
    "INSERT INTO employee_day_status (user_id, work_date, status, source, updated_at) VALUES (?, '2026-08-25', 'full_leave', 'fixture', ?)",
  ).run(employeeAId, new Date().toISOString());
  const leaveOverview = buildManagerOverview(manager, "2026-08-25", db);
  assert.equal(leaveOverview.submission.expected, 0);
  assert.equal(leaveOverview.submission.submitted, 0);
  db.close();
});

test("公司级主管按员工当前部门归属工时且项目事项不重复", () => {
  const db = createMigratedFixtureDb();
  const execId = addUser(db, { name: "公司主管", role: "exec", dept: "管理层" });
  const aId = addUser(db, { name: "甲员工", role: "lead", dept: "甲部" });
  const bId = addUser(db, { name: "乙员工", role: "emp", dept: "乙部" });
  db.prepare("UPDATE users SET should_submit = 0 WHERE id = ?").run(execId);
  const a = sessionUser(aId, "甲员工", "lead", "甲部");
  const project = createFormalProject(a, { name: "公司项目", memberUserIds: [bId] }, db);
  insertReport(db, aId, "2026-08-25", [{ projectId: project.id, summary: "事项 A", result: "完成 A", hours: 2 }]);
  insertReport(db, bId, "2026-08-25", [{ projectId: project.id, summary: "事项 B", result: "完成 B", hours: 3 }]);
  const overview = buildManagerOverview(sessionUser(execId, "公司主管", "exec", "管理层"), "2026-08-25", db);
  assert.equal(overview.projects[0].totalHours, 5);
  assert.equal(overview.projects[0].employeeItems.length, 2);
  assert.deepEqual(overview.hoursByDepartment, [
    { department: "甲部", hours: 2 },
    { department: "乙部", hours: 3 },
  ]);
  db.close();
});
