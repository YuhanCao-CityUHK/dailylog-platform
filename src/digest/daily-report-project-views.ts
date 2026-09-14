import type { DailyReportDigestConfig, DailyReportOrgConfig } from "./daily-report-config";
import { configHasLegacyDailyReportEmployees } from "./daily-report-config";
import type { ProjectViewFilter, ProjectViewRole } from "./daily-report-project-view-filter";
import { isDailyReportProjectViewsEnabled } from "./daily-report-project-view-flag";

export interface DailyReportProjectViewDigestConfig {
  /** 默认 true；显式 false 时 scheduler 跳过该视图 */
  enabled?: boolean;
  sendHour?: number;
  sendMinute?: number;
  /** 仅向这些 userid 发送；缺省 = viewers 减去 excludeUserIds */
  recipients?: string[];
  /** 不发早报的 viewer（如验收期暂排除示例主管） */
  excludeUserIds?: string[];
}

export interface DailyReportProjectViewConfig {
  id: string;
  label: string;
  /** 可查看此视图的用户 userid 白名单 */
  viewers: string[];
  /** 为 true 时 viewers 即使具备主管/admin 角色也不可见 legacy 公司/项目视图 */
  exclusiveForViewers?: boolean;
  /** org-wide 发现扫描近 N 自然日；默认 30 */
  discoveryDays?: number;
  filters: ProjectViewFilter;
  digest?: DailyReportProjectViewDigestConfig;
}

export interface DailyReportsAccessInfo {
  legacyAccess: boolean;
  customOnly: boolean;
  customViews: Array<{ id: string; label: string }>;
}

export interface WorkbenchDailyReportsCaps {
  canAccessAdmin: boolean;
  canManage: boolean;
  canViewCatalog?: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseDiscoveryDays(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

function parseDigestConfig(raw: unknown): DailyReportProjectViewDigestConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const excludeRaw = Array.isArray(d.excludeUserIds) ? d.excludeUserIds : [];
  const recipientsRaw = Array.isArray(d.recipients) ? d.recipients : [];
  const sendHour = Number(d.sendHour);
  const sendMinute = Number(d.sendMinute);
  return {
    enabled: d.enabled === false ? false : true,
    ...(Number.isFinite(sendHour) ? { sendHour: Math.floor(sendHour) } : {}),
    ...(Number.isFinite(sendMinute) ? { sendMinute: Math.floor(sendMinute) } : {}),
    ...(recipientsRaw.length
      ? { recipients: recipientsRaw.map((v) => asString(v)).filter(Boolean) }
      : {}),
    ...(excludeRaw.length
      ? { excludeUserIds: excludeRaw.map((v) => asString(v)).filter(Boolean) }
      : {}),
  };
}

export const OTHERS_PROJECT_VIEW_ID = "others";

export function isOthersProjectView(
  view: Pick<DailyReportProjectViewConfig, "id" | "filters">,
): boolean {
  return view.id === OTHERS_PROJECT_VIEW_ID || view.filters.role === "others";
}

export function listKeywordProjectViews(
  views: Array<DailyReportProjectViewConfig & { orgLabel?: string }>,
): Array<DailyReportProjectViewConfig & { orgLabel?: string }> {
  return views.filter((v) => !isOthersProjectView(v));
}

export function parseProjectViewConfig(raw: unknown, orgLabel: string): DailyReportProjectViewConfig | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = asString(o.id);
  const label = asString(o.label);
  const viewersRaw = Array.isArray(o.viewers) ? o.viewers : [];
  const viewers = viewersRaw.map((v) => asString(v)).filter(Boolean);
  const filtersRaw = (o.filters ?? {}) as Record<string, unknown>;
  const roleRaw = asString(filtersRaw.role);
  const role: ProjectViewRole | undefined =
    roleRaw === "others" || id === OTHERS_PROJECT_VIEW_ID ? "others" : roleRaw === "project" ? "project" : undefined;
  const keyword = asString(filtersRaw.keyword);
  const workModuleContains = asString(filtersRaw.workModuleContains);
  const costProjectContains = asString(filtersRaw.costProjectContains);
  if (!id || !label || viewers.length === 0) return null;
  const isOthers = role === "others" || id === OTHERS_PROJECT_VIEW_ID;
  if (!isOthers && !keyword && !workModuleContains && !costProjectContains) return null;
  const digest = parseDigestConfig(o.digest);
  return {
    id,
    label,
    viewers,
    exclusiveForViewers: o.exclusiveForViewers === true,
    discoveryDays: parseDiscoveryDays(o.discoveryDays),
    filters: {
      ...(isOthers ? { role: "others" as const } : {}),
      ...(keyword ? { keyword } : {}),
      ...(workModuleContains ? { workModuleContains } : {}),
      ...(costProjectContains ? { costProjectContains } : {}),
    },
    ...(digest ? { digest } : {}),
  };
}

export function listProjectViewsFromConfig(
  orgs: DailyReportOrgConfig[],
): Array<DailyReportProjectViewConfig & { orgLabel: string }> {
  if (!isDailyReportProjectViewsEnabled()) return [];
  const out: Array<DailyReportProjectViewConfig & { orgLabel: string }> = [];
  for (const org of orgs) {
    for (const raw of org.projectViews ?? []) {
      const parsed = parseProjectViewConfig(raw, org.label);
      if (parsed) out.push({ ...parsed, orgLabel: org.label });
    }
  }
  return out;
}

export function isExclusiveCustomViewer(
  userId: string,
  views: Array<DailyReportProjectViewConfig & { orgLabel?: string }>,
): boolean {
  return views.some((v) => v.exclusiveForViewers && v.viewers.includes(userId));
}

export function resolveDailyReportsAccess(
  userId: string,
  config: DailyReportDigestConfig,
  caps: WorkbenchDailyReportsCaps,
): DailyReportsAccessInfo {
  const allViews = listProjectViewsFromConfig(config.orgs);
  const hasLegacy = configHasLegacyDailyReportEmployees(config.orgs);
  const customViews = (caps.canAccessAdmin
    ? allViews
    : allViews.filter((v) => v.viewers.includes(userId))
  ).map((v) => ({ id: v.id, label: v.label }));
  const exclusive = isExclusiveCustomViewer(userId, allViews);
  const legacyAccess =
    hasLegacy && (caps.canAccessAdmin || (caps.canManage && !exclusive));
  const customOnly = !legacyAccess && customViews.length > 0;
  return { legacyAccess, customOnly, customViews };
}

export function findProjectViewById(
  config: DailyReportDigestConfig,
  viewId: string,
): (DailyReportProjectViewConfig & { orgLabel: string }) | undefined {
  return listProjectViewsFromConfig(config.orgs).find((v) => v.id === viewId);
}

/** 定时早报收件人：viewers / recipients 减去 exclude + env 排除项。 */
export function resolveProjectViewDigestRecipients(
  view: DailyReportProjectViewConfig,
  envExcludeUserIds: string[] = [],
): string[] {
  const exclude = new Set([
    ...(view.digest?.excludeUserIds ?? []),
    ...envExcludeUserIds,
  ]);
  const base =
    view.digest?.recipients && view.digest.recipients.length > 0
      ? view.digest.recipients
      : view.viewers;
  return base.filter((id) => id && !exclude.has(id));
}

export function isProjectViewDigestEnabledForView(view: DailyReportProjectViewConfig): boolean {
  return view.digest?.enabled === true;
}

/** 工作台「全部项目」总览 Tab（非真实 projectView id）。 */
export const PROJECT_VIEW_OVERVIEW_ID = "overview";

export interface ProjectViewDigestPlan {
  view: DailyReportProjectViewConfig & { orgLabel: string };
  sendHour: number;
  sendMinute: number;
}

/** 按收件人聚合 digest 计划（同一 userid 可能对应多个 projectView）。 */
export function groupProjectViewDigestPlansByUser(
  config: DailyReportDigestConfig,
  envExcludeUserIds: string[] = [],
): Map<string, ProjectViewDigestPlan[]> {
  const out = new Map<string, ProjectViewDigestPlan[]>();
  for (const view of listProjectViewsFromConfig(config.orgs)) {
    if (!isProjectViewDigestEnabledForView(view)) continue;
    const recipients = resolveProjectViewDigestRecipients(view, envExcludeUserIds);
    const plan: ProjectViewDigestPlan = {
      view,
      sendHour: view.digest?.sendHour ?? 8,
      sendMinute: view.digest?.sendMinute ?? 0,
    };
    for (const userId of recipients) {
      const existing = out.get(userId) ?? [];
      existing.push(plan);
      out.set(userId, existing);
    }
  }
  return out;
}

export { collectProjectViewDigestForRange } from "./daily-report-project-view-collect";
