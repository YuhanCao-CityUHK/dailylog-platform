import assert from "node:assert/strict";
import test from "node:test";
import { fetchDdUserDetail } from "../src/auth/dingtalk";
import { syncOrganizationSnapshot } from "../src/projects/organization";
import { addUser, createMigratedFixtureDb } from "./helpers";

test("钉钉组织 Schema 解析部门主管并保存带时间的组织快照", async () => {
  const responses = [
    { accessToken: "test-token", expireIn: 7200 },
    {
      errcode: 0,
      result: {
        name: "研发主管",
        title: "部门主管",
        dept_id_list: [101],
        leader_in_dept: [{ dept_id: 101, leader: true }],
      },
    },
    { errcode: 0, result: { name: "研发部" } },
  ];
  const fetchMock: typeof fetch = async () => {
    const body = responses.shift();
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const detail = await fetchDdUserDetail("manager-userid", fetchMock);
  assert.equal(detail.organizationResolved, true);
  assert.equal(detail.dept, "研发部");
  assert.equal(detail.departments[0].isManager, true);

  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: detail.name, role: "mgr" });
  const syncedAt = "2026-08-25T08:00:00.000Z";
  syncOrganizationSnapshot(
    userId,
    {
      departmentName: detail.dept,
      managerDepartmentNames: detail.departments.filter((department) => department.isManager).map((department) => department.name),
      syncedAt,
    },
    db,
  );
  const user = db.prepare("SELECT dept, org_synced_at FROM users WHERE id = ?").get(userId) as {
    dept: string;
    org_synced_at: string;
  };
  assert.equal(user.dept, "研发部");
  assert.equal(user.org_synced_at, syncedAt);
  const relation = db
    .prepare("SELECT department_name, synced_at FROM department_managers WHERE manager_user_id = ?")
    .get(userId) as { department_name: string; synced_at: string };
  assert.equal(relation.department_name, "研发部");
  assert.equal(relation.synced_at, syncedAt);
  db.close();
});
