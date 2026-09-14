import { CONFIG } from "../infra/config";

export type Role = "emp" | "lead" | "mgr" | "exec" | "admin";

export interface SessionUser {
  id: number;
  kind: "dingtalk" | "local";
  ddUserid?: string;
  loginName?: string;
  name: string;
  title: string;
  dept: string;
  role: Role;
  isExternal: boolean;
  mustChangePw: boolean;
}

/** 普通员工/项目负责人可写个人日志；显式配置的钉钉管理员同时保留个人日志能力。 */
export function canUsePersonalLogs(
  user: Pick<SessionUser, "kind" | "ddUserid" | "name" | "role">,
): boolean {
  if (user.role === "emp" || user.role === "lead") return true;
  if (user.role !== "admin" || user.kind !== "dingtalk") return false;
  return Boolean(
    (user.ddUserid && CONFIG.roles.admins.includes(user.ddUserid)) ||
      CONFIG.roles.adminNames.includes(user.name.trim()),
  );
}

/** 对话式日报助手已正式开放给全部钉钉员工；本地外部账号仍不接入个人 DWS。 */
export function canUseDwsAssistant(
  user: Pick<SessionUser, "kind" | "ddUserid">,
  _allowedUserids: readonly string[] = CONFIG.assistant.pilotUserids,
  enabled = CONFIG.assistant.enabled,
): boolean {
  return enabled && user.kind === "dingtalk" && Boolean(user.ddUserid);
}

export function canViewDailyReports(u: SessionUser): boolean {
  if (u.isExternal) return false;
  return u.role === "admin" || u.role === "exec" || u.role === "mgr" || u.role === "lead";
}

export function isManagerRole(role: Role): boolean {
  return role === "lead" || role === "mgr" || role === "exec" || role === "admin";
}
