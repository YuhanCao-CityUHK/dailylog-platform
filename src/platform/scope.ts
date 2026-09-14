/** 权限范围：检索、分析、回答、引用共用同一边界（规格 §3.3 / PRD 6.5）。 */
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../infra/db";
import type { SessionUser } from "../auth/types";
import { CONFIG } from "../infra/config";

export interface Scope {
  /** 可见的员工 user_id 集合；null = 全部（公司范围） */
  userIds: number[] | null;
  label: string;
}

export interface EmployeeInScope {
  id: number;
  name: string;
  title: string;
}

interface IdRow {
  id: number;
}

export function canViewExternalLogs(user: SessionUser): boolean {
  return Boolean(
    !user.isExternal &&
      user.ddUserid &&
      CONFIG.externalLogViewerUserids.includes(user.ddUserid),
  );
}

/**
 * 全员正式使用统一最小权限，助手开关不再改变日志可见范围：
 * - 外部账号（isExternal）：仅本人。
 * - emp/lead：本人；显式外部日志查看人另保留既有外部账号范围。
 * - mgr：本人管理部门的内部员工；跨部门项目通过 projects/permissions 单独放行。
 * - exec/admin：公司范围全部。
 */
export function resolveScope(user: SessionUser, db: DatabaseSync = getDb()): Scope {
  if (user.isExternal) {
    return { userIds: [user.id], label: "当前可检索：本人日志" };
  }
  if (user.role === "emp") {
    const includeExternal = canViewExternalLogs(user);
    const rows = db
      .prepare("SELECT id FROM users WHERE active = 1 AND (id = ? OR (? = 1 AND is_external = 1))")
      .all(user.id, includeExternal ? 1 : 0) as unknown as IdRow[];
    return {
      userIds: rows.map((r) => r.id),
      label: includeExternal
        ? "当前可检索：本人日志 + 显式授权的外部账号日志"
        : "当前可检索：本人日志",
    };
  }
  if (user.role === "lead") {
    return { userIds: [user.id], label: "当前可检索：本人日志；负责项目在项目视角按事项授权" };
  }
  if (user.role === "mgr") {
    const managedRows = db
      .prepare("SELECT department_name FROM department_managers WHERE manager_user_id = ?")
      .all(user.id) as unknown as Array<{ department_name: string }>;
    const departments = [...new Set(managedRows.map((row) => row.department_name.trim()).filter(Boolean))];
    if (departments.length === 0 && user.dept.trim()) departments.push(user.dept.trim());
    if (departments.length === 0) return { userIds: [user.id], label: "当前可检索：本人日志（尚未同步管理部门）" };
    const rows = db
      .prepare(
        `SELECT id FROM users WHERE active = 1 AND is_external = 0
          AND dept IN (${departments.map(() => "?").join(",")})`,
      )
      .all(...(departments as never[])) as unknown as IdRow[];
    return { userIds: rows.map((row) => row.id), label: `当前可检索：${departments.join("、")}正式日志` };
  }
  return { userIds: null, label: "当前可检索：公司范围内已授权日志" };
}

/** 员工视角必须复用日志检索范围，避免已授权人员只能在汇总中看到员工、却无法进入详情。 */
export function listEmployeesInScope(scope: Scope): EmployeeInScope[] {
  const db = getDb();
  if (scope.userIds === null) {
    return db
      .prepare("SELECT id, name, title FROM users WHERE active = 1 ORDER BY is_external, id")
      .all() as unknown as EmployeeInScope[];
  }
  return db
    .prepare(
      `SELECT id, name, title FROM users WHERE active = 1 AND id IN (${scope.userIds.map(() => "?").join(",") || "0"}) ORDER BY is_external, id`,
    )
    .all(...(scope.userIds as never[])) as unknown as EmployeeInScope[];
}

/** lead 是否有权查看某项目 */
export function leadOwnsProject(user: SessionUser, projectId: number): boolean {
  if (user.role !== "lead") return true;
  const row = getDb()
    .prepare("SELECT 1 AS x FROM projects WHERE id = ? AND owner_user_id = ?")
    .get(projectId, user.id);
  return Boolean(row);
}

export function scopeUserIdsForQuery(scope: Scope): number[] | undefined {
  return scope.userIds === null ? undefined : scope.userIds;
}
