import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { nowIso } from "../infra/db";
import { cleanProjectName, normalizeProjectName } from "./name";
import {
  canAccessProjectCatalog,
  canAssignProjectOwner,
  canCreateFormalProject,
  canManageProject,
} from "./permissions";

export type ProjectStatus = "in_progress" | "completed";

export interface ProjectMember {
  id: number;
  name: string;
  dept: string;
}

export interface FormalProject {
  id: number;
  name: string;
  owner: ProjectMember;
  members: ProjectMember[];
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export class ProjectServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function projectRow(projectId: number, db: DatabaseSync): {
  id: number;
  name: string;
  owner_user_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
} | undefined {
  return db
    .prepare(
      `SELECT id, name, owner_user_id, status, created_at, updated_at
         FROM projects WHERE id = ? AND source <> 'dingtalk'`,
    )
    .get(projectId) as
    | { id: number; name: string; owner_user_id: number | null; status: string; created_at: string; updated_at: string }
    | undefined;
}

function memberRows(projectId: number, db: DatabaseSync): ProjectMember[] {
  return db
    .prepare(
      `SELECT u.id, u.name, u.dept FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ? AND u.active = 1 ORDER BY u.id`,
    )
    .all(projectId) as unknown as ProjectMember[];
}

export function getFormalProject(projectId: number, db: DatabaseSync): FormalProject {
  const row = projectRow(projectId, db);
  if (!row || !row.owner_user_id) throw new ProjectServiceError(404, "project_not_found", "项目不存在");
  const owner = db
    .prepare("SELECT id, name, dept FROM users WHERE id = ? AND active = 1")
    .get(row.owner_user_id) as ProjectMember | undefined;
  if (!owner) throw new ProjectServiceError(409, "owner_unavailable", "项目负责人已不可用");
  return {
    id: row.id,
    name: row.name,
    owner,
    members: memberRows(row.id, db),
    status: row.status === "completed" ? "completed" : "in_progress",
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function snapshot(projectId: number, db: DatabaseSync): Record<string, unknown> {
  const project = getFormalProject(projectId, db);
  return {
    id: project.id,
    name: project.name,
    ownerUserId: project.owner.id,
    memberUserIds: project.members.map((member) => member.id),
    status: project.status,
  };
}

function auditProject(
  db: DatabaseSync,
  projectId: number,
  actorUserId: number,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO project_audit_log
      (project_id, actor_user_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, actorUserId, action, JSON.stringify(before), JSON.stringify(after), nowIso());
}

function requireActiveInternalUsers(userIds: number[], db: DatabaseSync): void {
  if (userIds.length === 0) return;
  const ids = [...new Set(userIds)];
  const rows = db
    .prepare(
      `SELECT id FROM users WHERE active = 1 AND is_external = 0
        AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...(ids as never[])) as unknown as Array<{ id: number }>;
  if (rows.length !== ids.length) {
    throw new ProjectServiceError(400, "invalid_owner", "负责人必须是在职组织成员");
  }
}

function requireActiveUsers(userIds: number[], db: DatabaseSync): void {
  if (userIds.length === 0) return;
  const ids = [...new Set(userIds)];
  const rows = db
    .prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${ids.map(() => "?").join(",")})`)
    .all(...(ids as never[])) as unknown as Array<{ id: number }>;
  if (rows.length !== ids.length) {
    throw new ProjectServiceError(400, "invalid_members", "项目成员必须是启用的平台账号");
  }
}

function requireUniqueName(name: string, excludeProjectId: number | null, db: DatabaseSync): string {
  const normalized = normalizeProjectName(name);
  if (!normalized) throw new ProjectServiceError(400, "invalid_name", "请输入项目名称");
  const duplicate = db
    .prepare("SELECT id FROM projects WHERE normalized_name = ? AND id <> COALESCE(?, -1)")
    .get(normalized, excludeProjectId) as { id: number } | undefined;
  if (duplicate) throw new ProjectServiceError(409, "duplicate_name", "项目名称已存在");
  return normalized;
}

function replaceMembers(projectId: number, memberUserIds: number[], ownerUserId: number, db: DatabaseSync): void {
  const ids = [...new Set([...memberUserIds, ownerUserId])];
  requireActiveUsers(ids, db);
  db.prepare("DELETE FROM project_members WHERE project_id = ?").run(projectId);
  const insert = db.prepare("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)");
  for (const userId of ids) insert.run(projectId, userId);
}

export function listFormalProjects(
  user: SessionUser,
  db: DatabaseSync,
  includeCompleted = false,
): FormalProject[] {
  const rows = db
    .prepare(
      `SELECT id FROM projects
        WHERE source <> 'dingtalk' AND (? = 1 OR status = 'in_progress')
        ORDER BY status, id`,
    )
    .all(includeCompleted ? 1 : 0) as unknown as Array<{ id: number }>;
  return rows
    .filter((row) => canAccessProjectCatalog(user, row.id, db))
    .map((row) => getFormalProject(row.id, db));
}

export function createFormalProject(
  user: SessionUser,
  input: { name: string; ownerUserId?: number; memberUserIds?: number[] },
  db: DatabaseSync,
): FormalProject {
  if (!canCreateFormalProject(user, db)) {
    throw new ProjectServiceError(403, "project_create_forbidden", "无权创建正式项目");
  }
  const name = cleanProjectName(input.name);
  if (name.length > 120) throw new ProjectServiceError(400, "invalid_name", "项目名称不能超过 120 个字符");
  const normalized = requireUniqueName(name, null, db);
  const ownerUserId = Number(input.ownerUserId) || user.id;
  requireActiveInternalUsers([ownerUserId], db);
  if (!canAssignProjectOwner(user, ownerUserId, db)) {
    throw new ProjectServiceError(403, "owner_assignment_forbidden", "无权指定该员工为项目负责人");
  }
  const memberUserIds = Array.isArray(input.memberUserIds) ? input.memberUserIds.map(Number).filter(Number.isSafeInteger) : [];
  const stamp = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db
      .prepare(
        `INSERT INTO projects
          (name, normalized_name, owner_user_id, status, source, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', 'user', 1, ?, ?, ?)`,
      )
      .run(name, normalized, ownerUserId, user.id, stamp, stamp);
    const projectId = Number(result.lastInsertRowid);
    replaceMembers(projectId, memberUserIds, ownerUserId, db);
    const after = snapshot(projectId, db);
    auditProject(db, projectId, user.id, "create", {}, after);
    db.exec("COMMIT");
    return getFormalProject(projectId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateFormalProject(
  user: SessionUser,
  projectId: number,
  input: { name?: string; memberUserIds?: number[] },
  db: DatabaseSync,
): FormalProject {
  if (!canManageProject(user, projectId, db)) {
    throw new ProjectServiceError(403, "project_manage_forbidden", "无权管理该项目");
  }
  const current = getFormalProject(projectId, db);
  const before = snapshot(projectId, db);
  const name = input.name === undefined ? current.name : cleanProjectName(input.name);
  if (!name || name.length > 120) throw new ProjectServiceError(400, "invalid_name", "项目名称应为 1 至 120 个字符");
  const normalized = requireUniqueName(name, projectId, db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE projects SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?").run(
      name,
      normalized,
      nowIso(),
      projectId,
    );
    if (input.memberUserIds !== undefined) {
      replaceMembers(projectId, input.memberUserIds.map(Number).filter(Number.isSafeInteger), current.owner.id, db);
    }
    const after = snapshot(projectId, db);
    auditProject(db, projectId, user.id, "update", before, after);
    db.exec("COMMIT");
    return getFormalProject(projectId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function transferFormalProject(
  user: SessionUser,
  projectId: number,
  newOwnerUserId: number,
  db: DatabaseSync,
): FormalProject {
  if (!canManageProject(user, projectId, db)) {
    throw new ProjectServiceError(403, "project_transfer_forbidden", "无权转交该项目");
  }
  requireActiveInternalUsers([newOwnerUserId], db);
  const current = getFormalProject(projectId, db);
  if (current.owner.id !== user.id && !canAssignProjectOwner(user, newOwnerUserId, db)) {
    throw new ProjectServiceError(403, "owner_assignment_forbidden", "无权将项目转交给该员工");
  }
  const before = snapshot(projectId, db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE projects SET owner_user_id = ?, updated_at = ? WHERE id = ?").run(
      newOwnerUserId,
      nowIso(),
      projectId,
    );
    db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)").run(
      projectId,
      newOwnerUserId,
    );
    const after = snapshot(projectId, db);
    auditProject(db, projectId, user.id, "transfer", before, after);
    db.exec("COMMIT");
    return getFormalProject(projectId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setFormalProjectStatus(
  user: SessionUser,
  projectId: number,
  status: ProjectStatus,
  db: DatabaseSync,
): FormalProject {
  if (!canManageProject(user, projectId, db)) {
    throw new ProjectServiceError(403, "project_status_forbidden", "无权修改该项目状态");
  }
  if (status !== "in_progress" && status !== "completed") {
    throw new ProjectServiceError(400, "invalid_status", "项目状态无效");
  }
  const before = snapshot(projectId, db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), projectId);
    const after = snapshot(projectId, db);
    auditProject(db, projectId, user.id, "status", before, after);
    db.exec("COMMIT");
    return getFormalProject(projectId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listProjectAudit(user: SessionUser, projectId: number, db: DatabaseSync): Array<Record<string, unknown>> {
  if (!canManageProject(user, projectId, db)) {
    throw new ProjectServiceError(403, "project_audit_forbidden", "无权查看该项目审计记录");
  }
  return (
    db
      .prepare(
        `SELECT a.id, a.action, a.before_json, a.after_json, a.created_at,
                u.id AS actor_user_id, u.name AS actor_name
           FROM project_audit_log a JOIN users u ON u.id = a.actor_user_id
          WHERE a.project_id = ? ORDER BY a.id DESC`,
      )
      .all(projectId) as unknown as Array<{
      id: number;
      action: string;
      before_json: string;
      after_json: string;
      created_at: string;
      actor_user_id: number;
      actor_name: string;
    }>
  ).map((row) => ({
    id: row.id,
    action: row.action,
    before: JSON.parse(row.before_json) as unknown,
    after: JSON.parse(row.after_json) as unknown,
    createdAt: row.created_at,
    actor: { id: row.actor_user_id, name: row.actor_name },
  }));
}
