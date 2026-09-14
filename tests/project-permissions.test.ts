import assert from "node:assert/strict";
import test from "node:test";
import type { Role, SessionUser } from "../src/auth/types";
import { canManageProject, canViewProjectReports } from "../src/projects/permissions";
import {
  createFormalProject,
  listProjectAudit,
  ProjectServiceError,
  setFormalProjectStatus,
  transferFormalProject,
  updateFormalProject,
} from "../src/projects/service";
import { addUser, createMigratedFixtureDb } from "./helpers";

function session(id: number, name: string, role: Role, dept: string): SessionUser {
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

test("负责人部门主管可管理，参与部门主管仅可查看，转交后管理部门随负责人变化", () => {
  const db = createMigratedFixtureDb();
  const ownerId = addUser(db, { name: "研发负责人", role: "lead", dept: "研发部" });
  const rdManagerId = addUser(db, { name: "研发主管", role: "mgr", dept: "研发部" });
  const salesId = addUser(db, { name: "销售成员", dept: "销售部" });
  const salesManagerId = addUser(db, { name: "销售主管", role: "mgr", dept: "销售部" });
  const otherManagerId = addUser(db, { name: "市场主管", role: "mgr", dept: "市场部" });
  const owner = session(ownerId, "研发负责人", "lead", "研发部");
  const rdManager = session(rdManagerId, "研发主管", "mgr", "研发部");
  const salesManager = session(salesManagerId, "销售主管", "mgr", "销售部");
  const otherManager = session(otherManagerId, "市场主管", "mgr", "市场部");

  const project = createFormalProject(owner, { name: "跨部门日报项目", memberUserIds: [salesId] }, db);
  assert.equal(canManageProject(owner, project.id, db), true);
  assert.equal(canManageProject(rdManager, project.id, db), true);
  assert.equal(canViewProjectReports(salesManager, project.id, db), true);
  assert.equal(canManageProject(salesManager, project.id, db), false);
  assert.equal(canViewProjectReports(otherManager, project.id, db), false);

  assert.throws(
    () => updateFormalProject(salesManager, project.id, { name: "越权改名" }, db),
    (error: unknown) => error instanceof ProjectServiceError && error.statusCode === 403,
  );

  assert.throws(
    () => transferFormalProject(rdManager, project.id, salesId, db),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "owner_assignment_forbidden",
    "负责人部门主管不能越部门指定新负责人",
  );
  transferFormalProject(owner, project.id, salesId, db);
  assert.equal(canManageProject(salesManager, project.id, db), true);
  assert.equal(canManageProject(rdManager, project.id, db), false);
  assert.equal(canViewProjectReports(rdManager, project.id, db), true, "研发成员仍在项目中，研发主管保留查看权");

  setFormalProjectStatus(salesManager, project.id, "completed", db);
  const audits = listProjectAudit(salesManager, project.id, db);
  assert.deepEqual(
    audits.map((entry) => entry.action),
    ["status", "transfer", "create"],
  );
  db.close();
});

test("项目名称规范化禁止重复，部门主管只能指定本部门负责人", () => {
  const db = createMigratedFixtureDb();
  const managerId = addUser(db, { name: "研发主管", role: "mgr", dept: "研发部" });
  const rdId = addUser(db, { name: "研发员工", dept: "研发部" });
  const salesId = addUser(db, { name: "销售员工", dept: "销售部" });
  const manager = session(managerId, "研发主管", "mgr", "研发部");
  createFormalProject(manager, { name: "项目Ａ", ownerUserId: rdId }, db);
  assert.throws(
    () => createFormalProject(manager, { name: "  项目A  ", ownerUserId: rdId }, db),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "duplicate_name",
  );
  assert.throws(
    () => createFormalProject(manager, { name: "销售项目", ownerUserId: salesId }, db),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "owner_assignment_forbidden",
  );
  db.close();
});
