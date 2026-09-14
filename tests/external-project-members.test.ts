import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionUser } from "../src/auth/types";
import { createFormalProject, ProjectServiceError, updateFormalProject } from "../src/projects/service";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT, dept TEXT, active INTEGER, is_external INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, normalized_name TEXT UNIQUE,
      owner_user_id INTEGER, status TEXT, source TEXT, active INTEGER, created_by INTEGER,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE project_members (project_id INTEGER, user_id INTEGER, PRIMARY KEY (project_id, user_id));
    CREATE TABLE department_managers (department_name TEXT, manager_user_id INTEGER);
    CREATE TABLE project_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, actor_user_id INTEGER, action TEXT,
      before_json TEXT, after_json TEXT, created_at TEXT
    );
    INSERT INTO users VALUES
      (1, '管理员', '管理层', 1, 0),
      (2, '内部负责人', '研发部', 1, 0),
      (3, '外部成员', '', 1, 1),
      (4, '停用外部成员', '', 0, 1);
  `);
  return db;
}

function admin(): SessionUser {
  return {
    id: 1,
    kind: "dingtalk",
    ddUserid: "admin",
    name: "管理员",
    title: "",
    dept: "管理层",
    role: "admin",
    isExternal: false,
    mustChangePw: false,
  };
}

test("新建和编辑项目时可选择启用的外部账号作为成员", () => {
  const db = database();
  const created = createFormalProject(admin(), { name: "外部协作项目", ownerUserId: 2, memberUserIds: [3] }, db);
  assert.deepEqual(created.members.map((member) => member.id).sort((a, b) => a - b), [2, 3]);
  const updated = updateFormalProject(admin(), created.id, { memberUserIds: [3] }, db);
  assert.deepEqual(updated.members.map((member) => member.id).sort((a, b) => a - b), [2, 3]);
});

test("外部账号不能成为负责人，停用外部账号不能成为成员", () => {
  const db = database();
  assert.throws(
    () => createFormalProject(admin(), { name: "错误负责人", ownerUserId: 3, memberUserIds: [] }, db),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "invalid_owner",
  );
  assert.throws(
    () => createFormalProject(admin(), { name: "停用成员", ownerUserId: 2, memberUserIds: [4] }, db),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "invalid_members",
  );
});

test("编辑历史外部负责人项目时可保留原负责人", () => {
  const db = database();
  db.exec(`
    INSERT INTO projects
      (id, name, normalized_name, owner_user_id, status, source, active, created_by, created_at, updated_at)
    VALUES (10, '历史外部项目', '历史外部项目', 3, 'in_progress', 'external', 1, 1, '2026-01-01', '2026-01-01');
    INSERT INTO project_members VALUES (10, 3);
  `);
  const updated = updateFormalProject(admin(), 10, { memberUserIds: [2, 3] }, db);
  assert.equal(updated.owner.id, 3);
  assert.deepEqual(updated.members.map((member) => member.id).sort((a, b) => a - b), [2, 3]);
});
