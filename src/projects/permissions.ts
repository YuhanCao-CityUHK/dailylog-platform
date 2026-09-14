import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";

interface ProjectOwnerRow {
  owner_user_id: number | null;
  owner_dept: string | null;
}

function managedDepartments(user: SessionUser, db: DatabaseSync): Set<string> {
  const departments = new Set<string>();
  const rows = db
    .prepare("SELECT department_name FROM department_managers WHERE manager_user_id = ?")
    .all(user.id) as unknown as Array<{ department_name: string }>;
  for (const row of rows) if (row.department_name.trim()) departments.add(row.department_name.trim());
  if (departments.size === 0 && user.role === "mgr" && user.dept.trim()) departments.add(user.dept.trim());
  return departments;
}

function projectOwner(projectId: number, db: DatabaseSync): ProjectOwnerRow | undefined {
  return db
    .prepare(
      `SELECT p.owner_user_id, u.dept AS owner_dept
         FROM projects p LEFT JOIN users u ON u.id = p.owner_user_id
        WHERE p.id = ? AND p.source <> 'dingtalk'`,
    )
    .get(projectId) as ProjectOwnerRow | undefined;
}

function isGlobalManager(user: SessionUser): boolean {
  return user.role === "admin" || user.role === "exec";
}

export function canCreateFormalProject(user: SessionUser, db: DatabaseSync): boolean {
  if (user.isExternal) return false;
  if (isGlobalManager(user) || user.role === "mgr" || user.role === "lead") return true;
  return Boolean(
    db
      .prepare("SELECT 1 AS x FROM projects WHERE owner_user_id = ? AND source <> 'dingtalk' LIMIT 1")
      .get(user.id),
  );
}

export function canAssignProjectOwner(user: SessionUser, ownerUserId: number, db: DatabaseSync): boolean {
  const owner = db
    .prepare("SELECT dept FROM users WHERE id = ? AND active = 1 AND is_external = 0")
    .get(ownerUserId) as { dept: string } | undefined;
  if (!owner) return false;
  if (ownerUserId === user.id && canCreateFormalProject(user, db)) return true;
  if (isGlobalManager(user)) return true;
  return managedDepartments(user, db).has(owner.dept.trim());
}

export function canManageProject(user: SessionUser, projectId: number, db: DatabaseSync): boolean {
  if (user.isExternal) return false;
  if (isGlobalManager(user)) return true;
  const project = projectOwner(projectId, db);
  if (!project) return false;
  if (project.owner_user_id === user.id) return true;
  return Boolean(project.owner_dept && managedDepartments(user, db).has(project.owner_dept.trim()));
}

/** 负责人、负责人部门主管、参与部门主管及全局管理角色可见项目全部正式事项。 */
export function canViewProjectReports(user: SessionUser, projectId: number, db: DatabaseSync): boolean {
  if (canManageProject(user, projectId, db)) return true;
  const departments = managedDepartments(user, db);
  if (departments.size === 0) return false;
  const placeholders = [...departments].map(() => "?").join(",");
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS x
           FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = ? AND u.dept IN (${placeholders}) LIMIT 1`,
      )
      .get(projectId, ...([...departments] as never[])),
  );
}

export function canAccessProjectCatalog(user: SessionUser, projectId: number, db: DatabaseSync): boolean {
  if (canViewProjectReports(user, projectId, db)) return true;
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS x FROM projects p
          LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE p.id = ? AND p.source <> 'dingtalk'
           AND (p.owner_user_id = ? OR pm.user_id IS NOT NULL)`,
      )
      .get(user.id, projectId, user.id),
  );
}

export function canReportToProject(user: SessionUser, projectId: number, db: DatabaseSync): boolean {
  if (user.isExternal) {
    return Boolean(
      db
        .prepare("SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?")
        .get(projectId, user.id),
    );
  }
  if (isGlobalManager(user)) return true;
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS x FROM projects p
          LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE p.id = ? AND p.source <> 'dingtalk'
           AND (p.owner_user_id = ? OR pm.user_id IS NOT NULL)`,
      )
      .get(user.id, projectId, user.id),
  );
}
