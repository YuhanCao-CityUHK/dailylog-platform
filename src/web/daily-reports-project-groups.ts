/**
 * 日报汇总项目组归属读写（config JSON orgs[].employees[].projectGroup）。
 */
import * as fs from "node:fs";
import {
  listProjectGroupAssignmentsFromConfig,
  normalizeProjectGroupId,
  PROJECT_GROUPS,
  resolveProjectGroup,
  type ProjectGroupAssignment,
  type ProjectGroupId,
} from "../digest/daily-report-project-groups";
import { loadDailyReportDigestConfig } from "../digest/daily-report-config";

interface RawOrg {
  label?: string;
  employees?: Array<{ userid?: string; name?: string; projectGroup?: string }>;
  [key: string]: unknown;
}

interface RawConfig {
  orgs?: RawOrg[];
  [key: string]: unknown;
}

function resolveConfigPath(explicit?: string): string {
  const p = (explicit ?? process.env.DAILY_REPORT_DIGEST_CONFIG_FILE ?? "").trim();
  if (!p) throw new Error("DAILY_REPORT_DIGEST_CONFIG_FILE 未配置");
  return p;
}

function readRaw(path: string): RawConfig {
  const text = fs.readFileSync(path, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("配置文件不是合法的 JSON 对象");
  }
  return parsed as RawConfig;
}

function writeRaw(path: string, obj: RawConfig): void {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, path);
}

function findOrg(raw: RawConfig, orgLabel: string): RawOrg {
  const target = orgLabel.trim();
  const orgs = Array.isArray(raw.orgs) ? raw.orgs : [];
  const org = orgs.find((o) => String(o.label ?? "").trim() === target);
  if (!org) {
    throw new Error(
      `未找到组织「${target}」（可选：${orgs.map((o) => o.label).join(" / ") || "无"}）`,
    );
  }
  return org;
}

export interface ProjectGroupMemberView {
  userid: string;
  name?: string;
  orgLabel: string;
  projectGroup: ProjectGroupId;
  projectGroupLabel: string;
}

export function listProjectGroupMembers(opts?: { filePath?: string }): ProjectGroupMemberView[] {
  const { config } = loadDailyReportDigestConfig({ filePath: opts?.filePath });
  const labelById = new Map(PROJECT_GROUPS.map((g) => [g.id, g.label]));
  return listProjectGroupAssignmentsFromConfig(config.orgs).map((a) => ({
    userid: a.userid,
    name: a.name,
    orgLabel: a.orgLabel,
    projectGroup: a.projectGroup,
    projectGroupLabel: labelById.get(a.projectGroup) ?? a.projectGroup,
  }));
}

export function updateProjectGroupAssignments(
  updates: Array<{ orgLabel: string; userid: string; projectGroup: ProjectGroupId }>,
  opts?: { filePath?: string },
): ProjectGroupMemberView[] {
  const path = resolveConfigPath(opts?.filePath);
  const raw = readRaw(path);
  let changed = false;

  for (const u of updates) {
    const group = normalizeProjectGroupId(u.projectGroup);
    if (!group) throw new Error(`非法项目组: ${u.projectGroup}`);
    const org = findOrg(raw, u.orgLabel);
    const employees = Array.isArray(org.employees) ? org.employees : [];
    const emp = employees.find((e) => String(e?.userid ?? "").trim() === u.userid.trim());
    if (!emp) {
      throw new Error(`组织「${u.orgLabel}」中未找到 userid=${u.userid}`);
    }
    if (emp.projectGroup !== group) {
      emp.projectGroup = group;
      changed = true;
    }
  }

  if (changed) writeRaw(path, raw);
  return listProjectGroupMembers({ filePath: path });
}

export function getResolvedAssignments(opts?: { filePath?: string }): ProjectGroupAssignment[] {
  const { config } = loadDailyReportDigestConfig({ filePath: opts?.filePath });
  return listProjectGroupAssignmentsFromConfig(config.orgs);
}

export { PROJECT_GROUPS, resolveProjectGroup };
