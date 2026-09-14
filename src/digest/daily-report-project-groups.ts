import type { OrgDigest } from "./daily-report-build";

export type ProjectGroupId = "intracranial" | "brain" | "ops";

export interface ProjectGroupMeta {
  id: ProjectGroupId;
  label: string;
}

export const PROJECT_GROUPS: ProjectGroupMeta[] = [
  { id: "intracranial", label: "颅内项目组" },
  { id: "brain", label: "脑机项目组" },
  { id: "ops", label: "运营组" },
];

const DEFAULT_BRAIN_NAMES = new Set(["崔枭", "贾三祥"]);
const DEFAULT_OPS_NAMES = new Set(["薛婷"]);

export interface ProjectGroupAssignment {
  userid: string;
  orgLabel: string;
  name?: string;
  projectGroup: ProjectGroupId;
}

export function normalizeProjectGroupId(raw: unknown): ProjectGroupId | undefined {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "intracranial" || v === "brain" || v === "ops") return v;
  return undefined;
}

/** 解析员工项目组：配置优先，否则按姓名默认规则。 */
export function resolveProjectGroup(input: {
  userid: string;
  name?: string;
  configured?: ProjectGroupId;
}): ProjectGroupId {
  if (input.configured) return input.configured;
  const name = String(input.name ?? "").trim();
  if (DEFAULT_BRAIN_NAMES.has(name)) return "brain";
  if (DEFAULT_OPS_NAMES.has(name)) return "ops";
  return "intracranial";
}

export interface ProjectGroupDigest {
  id: ProjectGroupId;
  label: string;
  orgs: OrgDigest[];
}

function emptyOrg(label: string): OrgDigest {
  return { label, submitted: [], missing: [], onLeave: [], errors: [] };
}

/** 将 org 维度 digest 按项目组重新分组（每组内仍保留 org 子结构）。 */
export function groupOrgDigestsByProject(
  orgDigests: OrgDigest[],
  assignments: ProjectGroupAssignment[],
): ProjectGroupDigest[] {
  const assignmentByUser = new Map<string, ProjectGroupId>();
  for (const a of assignments) {
    assignmentByUser.set(a.userid, a.projectGroup);
  }

  const buckets = new Map<ProjectGroupId, Map<string, OrgDigest>>();
  for (const meta of PROJECT_GROUPS) {
    buckets.set(meta.id, new Map());
  }

  for (const org of orgDigests) {
    for (const emp of org.submitted) {
      const groupId =
        assignmentByUser.get(emp.userid)
        ?? resolveProjectGroup({ userid: emp.userid, name: emp.name });
      const orgMap = buckets.get(groupId)!;
      let target = orgMap.get(org.label);
      if (!target) {
        target = emptyOrg(org.label);
        orgMap.set(org.label, target);
      }
      target.submitted.push(emp);
    }
    for (const m of org.missing) {
      const groupId =
        assignmentByUser.get(m.userid)
        ?? resolveProjectGroup({ userid: m.userid, name: m.name });
      const orgMap = buckets.get(groupId)!;
      let target = orgMap.get(org.label);
      if (!target) {
        target = emptyOrg(org.label);
        orgMap.set(org.label, target);
      }
      target.missing.push(m);
    }
    for (const m of org.onLeave ?? []) {
      const groupId =
        assignmentByUser.get(m.userid)
        ?? resolveProjectGroup({ userid: m.userid, name: m.name });
      const orgMap = buckets.get(groupId)!;
      let target = orgMap.get(org.label);
      if (!target) {
        target = emptyOrg(org.label);
        orgMap.set(org.label, target);
      }
      target.onLeave!.push(m);
    }
    for (const e of org.errors) {
      const groupId =
        assignmentByUser.get(e.userid)
        ?? resolveProjectGroup({ userid: e.userid, name: e.name });
      const orgMap = buckets.get(groupId)!;
      let target = orgMap.get(org.label);
      if (!target) {
        target = emptyOrg(org.label);
        orgMap.set(org.label, target);
      }
      target.errors.push(e);
    }
  }

  return PROJECT_GROUPS.map((meta) => ({
    id: meta.id,
    label: meta.label,
    orgs: [...(buckets.get(meta.id)?.values() ?? [])],
  }));
}

export function listProjectGroupAssignmentsFromConfig(
  orgs: Array<{
    label: string;
    employees: Array<{ userid: string; name?: string; projectGroup?: ProjectGroupId }>;
  }>,
): ProjectGroupAssignment[] {
  const out: ProjectGroupAssignment[] = [];
  for (const org of orgs) {
    for (const emp of org.employees) {
      out.push({
        userid: emp.userid,
        orgLabel: org.label,
        name: emp.name,
        projectGroup: resolveProjectGroup({
          userid: emp.userid,
          name: emp.name,
          configured: emp.projectGroup,
        }),
      });
    }
  }
  return out;
}
