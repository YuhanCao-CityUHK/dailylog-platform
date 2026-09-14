import { audit, getDb, nowIso } from "../src/infra/db";
import { fetchDdUserDetail } from "../src/auth/dingtalk";
import { roleForDdUser } from "../src/auth/routes";
import { applyOrganizationSnapshot } from "../src/projects/organization";

const db = getDb();
const users = db
  .prepare(
    `SELECT id, dd_userid, name, title, dept, role
       FROM users
      WHERE active = 1 AND kind = 'dingtalk' AND dd_userid IS NOT NULL
      ORDER BY id`,
  )
  .all() as unknown as Array<{
  id: number;
  dd_userid: string;
  name: string;
  title: string;
  dept: string;
  role: string;
}>;

let synced = 0;
const failed: Array<{ id: number; reason: string }> = [];
const snapshots: Array<{
  user: (typeof users)[number];
  detail: Awaited<ReturnType<typeof fetchDdUserDetail>>;
  managerDepartments: string[];
}> = [];

for (const user of users) {
  try {
    const detail = await fetchDdUserDetail(user.dd_userid);
    if (!detail.organizationResolved) throw new Error("钉钉未返回可用的组织关系");
    const managerDepartments = detail.departments
      .filter((department) => department.isManager)
      .map((department) => department.name);
    snapshots.push({ user, detail, managerDepartments });
  } catch (error) {
    failed.push({ id: user.id, reason: error instanceof Error ? error.message : "未知错误" });
  }
}

if (failed.length > 0) {
  console.log(JSON.stringify({ total: users.length, synced, failed }, null, 2));
  process.exitCode = 1;
} else {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { user, detail, managerDepartments } of snapshots) {
      const stamp = nowIso();
      applyOrganizationSnapshot(
        user.id,
        {
          departmentName: detail.dept || user.dept,
          managerDepartmentNames: managerDepartments,
          syncedAt: stamp,
        },
        db,
      );
      db.prepare("UPDATE users SET name = ?, title = ?, role = ? WHERE id = ?").run(
        detail.name || user.name,
        detail.title || user.title,
        roleForDdUser(user.dd_userid, detail.name || user.name, managerDepartments.length > 0),
        user.id,
      );
      audit(user.id, "organization.sync.rollout", stamp);
      synced += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ total: users.length, synced, failed }, null, 2));
}
