import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../infra/db";
import { normalizeProjectName } from "./name";

export interface ProjectCatalogMigrationSpec {
  projectId: number;
  name: string;
  ownerName: string;
  memberNames: string[];
  formalizeDingtalkProject?: boolean;
}

export const UNIFIED_PROJECT_CATALOG: ProjectCatalogMigrationSpec[] = [
  { projectId: 2, name: "水锤项目", ownerName: "强轩轩", memberNames: ["强轩轩", "翟少波", "朱志玮"] },
  { projectId: 3, name: "伤口荧光项目", ownerName: "强轩轩", memberNames: ["强轩轩"] },
  {
    projectId: 48,
    name: "OCT",
    ownerName: "胡文华",
    memberNames: ["胡文华", "周毓凡"],
    formalizeDingtalkProject: true,
  },
  {
    projectId: 49,
    name: "CLA",
    ownerName: "徐佳雨",
    memberNames: ["徐佳雨", "闫思源"],
    formalizeDingtalkProject: true,
  },
  {
    projectId: 51,
    name: "静脉腔闭合系统",
    ownerName: "胡文华",
    memberNames: ["胡文华", "周毓凡", "闫思源", "徐佳雨", "朱志玮"],
    formalizeDingtalkProject: true,
  },
  { projectId: 52, name: "AFD", ownerName: "闫思源", memberNames: ["闫思源", "周毓凡"] },
  {
    projectId: 53,
    name: "冲击波",
    ownerName: "闫思源",
    memberNames: ["闫思源"],
    formalizeDingtalkProject: true,
  },
];

interface ProjectRow {
  id: number;
  name: string;
  source: string;
  active: number;
  status: string;
  owner_user_id: number | null;
}

interface UserRow {
  id: number;
  name: string;
  role: string;
  is_external: number;
}

interface ResolvedSpec {
  spec: ProjectCatalogMigrationSpec;
  project: ProjectRow;
  owner: UserRow;
  members: UserRow[];
  currentMemberIds: number[];
}

export interface ProjectCatalogMigrationResult {
  applied: boolean;
  actor: { id: number; name: string };
  projects: Array<{
    id: number;
    name: string;
    sourceBefore: string;
    sourceAfter: string;
    owner: string;
    members: string[];
    changed: boolean;
  }>;
}

function oneActiveUser(name: string, db: DatabaseSync): UserRow {
  const rows = db
    .prepare("SELECT id, name, role, is_external FROM users WHERE name = ? AND active = 1 ORDER BY id")
    .all(name) as unknown as UserRow[];
  if (rows.length !== 1) throw new Error(`启用中的平台账号“${name}”应唯一，实际找到 ${rows.length} 人`);
  return rows[0];
}

function resolveSpecs(specs: ProjectCatalogMigrationSpec[], db: DatabaseSync): ResolvedSpec[] {
  return specs.map((spec) => {
    const project = db
      .prepare("SELECT id, name, source, active, status, owner_user_id FROM projects WHERE id = ?")
      .get(spec.projectId) as ProjectRow | undefined;
    if (!project) throw new Error(`缺少历史项目 ${spec.projectId}（${spec.name}）`);
    if (project.name !== spec.name) {
      throw new Error(`历史项目 ${spec.projectId} 名称不符：预期“${spec.name}”，实际“${project.name}”`);
    }
    if (spec.formalizeDingtalkProject && project.source !== "dingtalk" && project.source !== "user") {
      throw new Error(`历史项目 ${spec.projectId} 来源异常：${project.source}`);
    }
    const owner = oneActiveUser(spec.ownerName, db);
    const members = [...new Set([...spec.memberNames, spec.ownerName])].map((name) => oneActiveUser(name, db));
    const currentMemberIds = (
      db.prepare("SELECT user_id FROM project_members WHERE project_id = ? ORDER BY user_id").all(spec.projectId) as unknown as Array<{
        user_id: number;
      }>
    ).map((row) => row.user_id);
    return { spec, project, owner, members, currentMemberIds };
  });
}

function sameIds(left: number[], right: number[]): boolean {
  return [...left].sort((a, b) => a - b).join(",") === [...right].sort((a, b) => a - b).join(",");
}

/**
 * 将历史自动识别项目原地转成正式项目。项目 ID、别名和日报引用全部保留；重复执行不会重复写审计记录。
 */
export function migrateUnifiedProjectCatalog(
  actorName: string,
  db: DatabaseSync,
  apply = false,
  specs: ProjectCatalogMigrationSpec[] = UNIFIED_PROJECT_CATALOG,
): ProjectCatalogMigrationResult {
  const actor = oneActiveUser(actorName, db);
  if (actor.role !== "admin" || actor.is_external === 1) throw new Error(`执行人“${actorName}”不是内部管理员`);
  const resolved = resolveSpecs(specs, db);
  const projects = resolved.map(({ spec, project, owner, members, currentMemberIds }) => {
    const memberIds = members.map((member) => member.id);
    const sourceAfter = spec.formalizeDingtalkProject ? "user" : project.source;
    const changed =
      project.source !== sourceAfter ||
      project.active !== 1 ||
      project.status !== "in_progress" ||
      project.owner_user_id !== owner.id ||
      !sameIds(currentMemberIds, memberIds);
    return {
      id: project.id,
      name: project.name,
      sourceBefore: project.source,
      sourceAfter,
      owner: owner.name,
      members: members.map((member) => member.name),
      changed,
    };
  });
  if (!apply) return { applied: false, actor: { id: actor.id, name: actor.name }, projects };

  db.exec("BEGIN IMMEDIATE");
  try {
    const stamp = nowIso();
    for (let index = 0; index < resolved.length; index += 1) {
      const { spec, project, owner, members } = resolved[index];
      const summary = projects[index];
      if (!summary.changed) continue;
      const before = {
        id: project.id,
        name: project.name,
        source: project.source,
        active: project.active,
        status: project.status,
        ownerUserId: project.owner_user_id,
        memberUserIds: resolved[index].currentMemberIds,
      };
      db.prepare(
        `UPDATE projects
            SET source = ?, active = 1, status = 'in_progress', owner_user_id = ?,
                normalized_name = ?, updated_at = ?
          WHERE id = ?`,
      ).run(summary.sourceAfter, owner.id, normalizeProjectName(spec.name), stamp, spec.projectId);
      db.prepare("DELETE FROM project_members WHERE project_id = ?").run(spec.projectId);
      const insertMember = db.prepare("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)");
      for (const member of members) insertMember.run(spec.projectId, member.id);
      db.prepare(
        `UPDATE log_items
            SET aff = ?, scope_type = 'project', project_id = ?, project_name_snapshot = ?
          WHERE project_id = ? OR aff = ?`,
      ).run(String(spec.projectId), spec.projectId, spec.name, spec.projectId, String(spec.projectId));
      const after = {
        id: project.id,
        name: project.name,
        source: summary.sourceAfter,
        active: 1,
        status: "in_progress",
        ownerUserId: owner.id,
        memberUserIds: members.map((member) => member.id),
      };
      db.prepare(
        `INSERT INTO project_audit_log
          (project_id, actor_user_id, action, before_json, after_json, created_at)
         VALUES (?, ?, 'catalog_migration', ?, ?, ?)`,
      ).run(spec.projectId, actor.id, JSON.stringify(before), JSON.stringify(after), stamp);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { applied: true, actor: { id: actor.id, name: actor.name }, projects };
}
