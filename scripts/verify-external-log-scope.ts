/** 使用当前平台库验证指定内部用户的完整日志可见范围。 */
import assert from "node:assert/strict";
import { getDb } from "../src/infra/db";
import { listEmployeesInScope, resolveScope } from "../src/platform/scope";
import type { Role, SessionUser } from "../src/auth/types";

interface UserRow {
  id: number;
  kind: "dingtalk" | "local";
  dd_userid: string | null;
  login_name: string | null;
  name: string;
  title: string;
  dept: string;
  role: Role;
  is_external: number;
  must_change_pw: number;
}

const viewerUserid = String(process.env.VERIFY_EXTERNAL_LOG_VIEWER_USERID ?? "").trim();
assert.ok(viewerUserid, "必须提供 VERIFY_EXTERNAL_LOG_VIEWER_USERID");

const db = getDb();
const row = db
  .prepare(
    `SELECT id, kind, dd_userid, login_name, name, title, dept, role, is_external, must_change_pw
     FROM users WHERE active = 1 AND dd_userid = ?`,
  )
  .get(viewerUserid) as unknown as UserRow | undefined;
assert.ok(row, `平台库中不存在已启用的查看人 ${viewerUserid}`);

const viewer: SessionUser = {
  id: row.id,
  kind: row.kind,
  ...(row.dd_userid ? { ddUserid: row.dd_userid } : {}),
  ...(row.login_name ? { loginName: row.login_name } : {}),
  name: row.name,
  title: row.title,
  dept: row.dept,
  role: row.role,
  isExternal: row.is_external === 1,
  mustChangePw: row.must_change_pw === 1,
};

const externalUsers = db
  .prepare("SELECT id, login_name, name FROM users WHERE active = 1 AND is_external = 1 ORDER BY id")
  .all() as unknown as Array<{ id: number; login_name: string | null; name: string }>;
assert.ok(externalUsers.length > 0, "平台库中没有已启用的外部账号，无法验证");

const scope = resolveScope(viewer);
assert.ok(scope.userIds, "定向查看人不应被扩大为不受限的全公司范围");
const visibleEmployees = listEmployeesInScope(scope);
for (const external of externalUsers) {
  assert.ok(scope.userIds.includes(external.id), `查看范围缺少外部账号 ${external.login_name ?? external.name}`);
  assert.ok(
    visibleEmployees.some((employee) => employee.id === external.id),
    `员工视角缺少外部账号 ${external.login_name ?? external.name}`,
  );
}

console.log(
  JSON.stringify({
    viewer: { id: viewer.id, name: viewer.name, ddUserid: viewer.ddUserid },
    externalUsers,
    visibleEmployeeCount: visibleEmployees.length,
    scopeUserCount: scope.userIds.length,
    scopeLabel: scope.label,
  }),
);
