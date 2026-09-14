import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { capabilitiesForUser } from "../src/auth/capabilities";
import { canUseDwsAssistant, type SessionUser } from "../src/auth/types";
import { CONFIG } from "../src/infra/config";
import { canAssignProjectOwner, canCreateFormalProject, canManageProject } from "../src/projects/permissions";
import { resolveScope } from "../src/platform/scope";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, dept TEXT, active INTEGER, is_external INTEGER);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, owner_user_id INTEGER, source TEXT, status TEXT);
    CREATE TABLE project_members (project_id INTEGER, user_id INTEGER);
    CREATE TABLE department_managers (department_name TEXT, manager_user_id INTEGER);
    INSERT INTO users VALUES
      (1, '普通员工', '研发部', 1, 0),
      (2, '部门主管', '研发部', 1, 0),
      (3, '项目负责人', '产品部', 1, 0),
      (4, '管理员', '管理层', 1, 0),
      (5, '外部工程师', '外部', 1, 1);
    INSERT INTO department_managers VALUES ('研发部', 2);
    INSERT INTO projects VALUES (10, 3, 'user', 'in_progress');
    INSERT INTO projects VALUES (11, 5, 'external', 'in_progress');
    INSERT INTO project_members VALUES (10, 3);
    INSERT INTO project_members VALUES (11, 5);
  `);
  return db;
}

function user(id: number, role: SessionUser["role"] = "emp", isExternal = false): SessionUser {
  return {
    id,
    kind: isExternal ? "local" : "dingtalk",
    ddUserid: isExternal ? undefined : `dd-${id}`,
    name: `用户${id}`,
    title: "",
    dept: id === 2 ? "研发部" : id === 4 ? "管理层" : "产品部",
    role,
    isExternal,
    mustChangePw: false,
  };
}

test("日报助手面向全部钉钉员工，不再受旧试用名单限制", () => {
  assert.equal(canUseDwsAssistant({ kind: "dingtalk", ddUserid: "any-employee" }, [], true), true);
  assert.equal(canUseDwsAssistant({ kind: "local" }, ["any-employee"], true), false);

  const db = database();
  const previousEnabled = CONFIG.assistant.enabled;
  CONFIG.assistant.enabled = true;
  try {
    const manager = capabilitiesForUser(user(2, "mgr"), db);
    assert.equal(manager.personalLogs, false);
    assert.equal(manager.assistant, true);
  } finally {
    CONFIG.assistant.enabled = previousEnabled;
  }
});

test("无下属普通员工只保留个人功能", () => {
  const db = database();
  const capabilities = capabilitiesForUser(user(1), db);
  assert.equal(capabilities.personalLogs, true);
  assert.equal(capabilities.supervisor, false);
  assert.equal(capabilities.projects, false);
  assert.equal(capabilities.admin, false);
  assert.equal(canCreateFormalProject(user(1), db), false);
});

test("钉钉组织主管获得主管功能，项目负责人只额外获得项目功能", () => {
  const db = database();
  assert.equal(capabilitiesForUser(user(2), db).supervisor, true);
  const owner = capabilitiesForUser(user(3), db);
  assert.equal(owner.projects, true);
  assert.equal(owner.supervisor, false);
  assert.equal(canCreateFormalProject(user(3), db), true);
});

test("管理功能只向管理员开放，外部账号不能管理正式项目", () => {
  const db = database();
  const admin = capabilitiesForUser(user(4, "admin"), db);
  assert.equal(admin.admin, true);
  assert.equal(admin.supervisor, true);
  assert.equal(canAssignProjectOwner(user(4, "admin"), 5, db), false);
  assert.equal(canManageProject(user(5, "emp", true), 11, db), false);
});

test("多部门员工只按钉钉标记为主管的部门取得范围", () => {
  const db = database();
  const manager = { ...user(2, "mgr"), dept: "产品部" };
  assert.equal(canAssignProjectOwner(manager, 3, db), false);
  assert.deepEqual(resolveScope(manager, db).userIds, [1, 2]);
});
