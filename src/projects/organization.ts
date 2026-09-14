import type { DatabaseSync } from "node:sqlite";

export interface OrganizationSnapshot {
  departmentName: string;
  managerDepartmentNames: string[];
  syncedAt: string;
}

/** 在调用方事务内写入一名用户的组织快照。 */
export function applyOrganizationSnapshot(
  userId: number,
  snapshot: OrganizationSnapshot,
  db: DatabaseSync,
): void {
  const departmentName = snapshot.departmentName.trim();
  const managerDepartments = [...new Set(snapshot.managerDepartmentNames.map((name) => name.trim()).filter(Boolean))];
  db.prepare("UPDATE users SET dept = COALESCE(NULLIF(?, ''), dept), org_synced_at = ? WHERE id = ?").run(
    departmentName,
    snapshot.syncedAt,
    userId,
  );
  db.prepare("DELETE FROM department_managers WHERE manager_user_id = ?").run(userId);
  const insert = db.prepare(
    "INSERT INTO department_managers (department_name, manager_user_id, synced_at) VALUES (?, ?, ?)",
  );
  for (const name of managerDepartments) insert.run(name, userId, snapshot.syncedAt);
}

/** 由钉钉组织 Schema 归一化后的快照写入；不接受前端传入的主管关系。 */
export function syncOrganizationSnapshot(
  userId: number,
  snapshot: OrganizationSnapshot,
  db: DatabaseSync,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    applyOrganizationSnapshot(userId, snapshot, db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
