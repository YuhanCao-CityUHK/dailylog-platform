/** 外部账号工作日志定向查看权限验证（不访问数据库）。 */
import assert from "node:assert/strict";
import type { SessionUser } from "../src/auth/types";

process.env.EXTERNAL_LOG_VIEWER_USERIDS = "example-user-1";

const { canViewExternalLogs } = await import("../src/platform/scope");

function user(overrides: Partial<SessionUser>): SessionUser {
  return {
    id: 1,
    kind: "dingtalk",
    name: "测试用户",
    title: "",
    dept: "",
    role: "emp",
    isExternal: false,
    mustChangePw: false,
    ...overrides,
  };
}

assert.equal(
  canViewExternalLogs(user({ name: "示例主管", ddUserid: "example-user-1" })),
  true,
  "配置名单中的内部用户应可查看外部账号日志",
);
assert.equal(
  canViewExternalLogs(user({ name: "普通员工", ddUserid: "unlisted-user" })),
  false,
  "未授权的普通员工不应获得外部账号日志权限",
);
assert.equal(
  canViewExternalLogs(
    user({ kind: "local", name: "外部账号", isExternal: true, ddUserid: "example-user-1" }),
  ),
  false,
  "外部账号不能通过查看人配置扩大自身权限",
);

console.log(JSON.stringify({ authorizedViewer: true, ordinaryEmployee: false, externalAccount: false }));
