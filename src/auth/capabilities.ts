import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "./types";
import { canUseDwsAssistant, canUsePersonalLogs } from "./types";
import { canCreateFormalProject } from "../projects/permissions";

export interface UserCapabilities {
  personalLogs: boolean;
  assistant: boolean;
  supervisor: boolean;
  projects: boolean;
  admin: boolean;
}

export function hasManagedDepartment(user: SessionUser, db: DatabaseSync): boolean {
  if (user.isExternal) return false;
  if (user.role === "admin" || user.role === "exec" || user.role === "mgr") return true;
  return Boolean(
    db
      .prepare("SELECT 1 AS x FROM department_managers WHERE manager_user_id = ? LIMIT 1")
      .get(user.id),
  );
}

export function capabilitiesForUser(user: SessionUser, db: DatabaseSync): UserCapabilities {
  const supervisor = hasManagedDepartment(user, db);
  return {
    personalLogs: canUsePersonalLogs(user),
    assistant: canUseDwsAssistant(user),
    supervisor,
    projects: !user.isExternal && (supervisor || canCreateFormalProject(user, db)),
    admin: user.role === "admin",
  };
}
