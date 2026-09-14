/**
 * 「日报汇总」名单的读写：直接操作 DAILY_REPORT_DIGEST_CONFIG_FILE 指向的 JSON 文件。
 *
 * 关键约束：
 * - 写回时只改 orgs[*].employees，**完整保留**其余字段（尤其是微光那组的
 *   appKey/appSecret 等密钥），所以基于「原始 JSON 对象」做最小改动后整体写回，
 *   不经过 parseDailyReportDigestConfig（后者会把明思的部署凭证解析进来）。
 * - 原子写：写临时文件后 rename，避免半截文件。
 * - 只能往**已存在的组织**里增删（明思/微光），不支持在此新增组织。
 */
import * as fs from "node:fs";

import {
  normalizeProjectGroupId,
  type ProjectGroupId,
} from "./daily-report-project-groups";

export interface RosterEmployee {
  userid: string;
  name?: string;
  projectGroup?: ProjectGroupId;
}

export interface RosterOrgView {
  label: string;
  /** true=复用部署应用凭证（明思）；false=配置内独立 appKey/appSecret（微光） */
  usesDeployedCredentials: boolean;
  employees: RosterEmployee[];
}

interface RawOrg {
  label?: string;
  appKey?: string;
  appSecret?: string;
  useDeployedAppCredentials?: boolean;
  employees?: Array<{ userid?: string; name?: string; projectGroup?: string }>;
  [key: string]: unknown;
}

interface RawConfig {
  orgs?: RawOrg[];
  [key: string]: unknown;
}

export interface RosterStoreOptions {
  filePath?: string;
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

function usesDeployed(org: RawOrg): boolean {
  return org.useDeployedAppCredentials === true || (!org.appKey && !org.appSecret);
}

function toView(orgs: RawOrg[]): RosterOrgView[] {
  return orgs.map((o) => ({
    label: String(o.label ?? "").trim() || "(未命名)",
    usesDeployedCredentials: usesDeployed(o),
    employees: (Array.isArray(o.employees) ? o.employees : [])
      .map((e) => {
        const projectGroup = normalizeProjectGroupId(e?.projectGroup);
        return {
          userid: String(e?.userid ?? "").trim(),
          name: String(e?.name ?? "").trim() || undefined,
          ...(projectGroup ? { projectGroup } : {}),
        };
      })
      .filter((e) => e.userid.length > 0),
  }));
}

function findOrg(raw: RawConfig, label: string): RawOrg {
  const target = label.trim();
  const orgs = Array.isArray(raw.orgs) ? raw.orgs : [];
  const org = orgs.find((o) => String(o.label ?? "").trim() === target);
  if (!org) {
    throw new Error(
      `未找到组织「${target}」（可选：${orgs.map((o) => o.label).join(" / ") || "无"}）`,
    );
  }
  return org;
}

export function listRoster(opts?: RosterStoreOptions): RosterOrgView[] {
  const raw = readRaw(resolveConfigPath(opts?.filePath));
  return toView(Array.isArray(raw.orgs) ? raw.orgs : []);
}

export function addRosterEmployee(
  orgLabel: string,
  emp: RosterEmployee,
  opts?: RosterStoreOptions,
): RosterOrgView[] {
  const userid = emp.userid.trim();
  if (!userid) throw new Error("userid 不能为空");
  const path = resolveConfigPath(opts?.filePath);
  const raw = readRaw(path);
  const org = findOrg(raw, orgLabel);
  if (!Array.isArray(org.employees)) org.employees = [];
  const exists = org.employees.some((e) => String(e?.userid ?? "").trim() === userid);
  if (!exists) {
    org.employees.push({ userid, name: emp.name?.trim() || undefined });
    writeRaw(path, raw);
  }
  return toView(Array.isArray(raw.orgs) ? raw.orgs : []);
}

export function removeRosterEmployee(
  orgLabel: string,
  userid: string,
  opts?: RosterStoreOptions,
): RosterOrgView[] {
  const target = userid.trim();
  if (!target) throw new Error("userid 不能为空");
  const path = resolveConfigPath(opts?.filePath);
  const raw = readRaw(path);
  const org = findOrg(raw, orgLabel);
  const before = Array.isArray(org.employees) ? org.employees : [];
  const after = before.filter((e) => String(e?.userid ?? "").trim() !== target);
  if (after.length !== before.length) {
    org.employees = after;
    writeRaw(path, raw);
  }
  return toView(Array.isArray(raw.orgs) ? raw.orgs : []);
}
