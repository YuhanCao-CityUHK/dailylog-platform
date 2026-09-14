import type { OrgDigest } from "./daily-report-build";
import { filterReportEntry } from "./daily-report-content-filter";
import {
  moduleBlockMatchesCostProjectFilter,
  moduleBlockMatchesKeywordFilter,
  moduleBlockMatchesPairFilter,
} from "./daily-report-project-view-filter";
import type { DailyReportProjectViewConfig } from "./daily-report-project-views";
import { isOthersProjectView } from "./daily-report-project-views";
import type { ReportContentField, ReportEntry } from "./dingtalk-report-client";

const MODULE_INDICES = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"] as const;
const SEPARATOR_KEY_RE = /^-+/;

export const CATALOG_PROJECT_VIEW_PREFIX = "catalog:";
export const CATALOG_OTHERS_VIEW_ID = `${CATALOG_PROJECT_VIEW_PREFIX}others`;

export interface ResolvedCostProject {
  id: number;
  name: string;
}

export type CostProjectResolver = (rawName: string) => ResolvedCostProject | null;

export function catalogProjectViewId(projectId: number): string {
  return `${CATALOG_PROJECT_VIEW_PREFIX}${projectId}`;
}

export function parseCatalogProjectViewId(viewId: string): number | "others" | undefined {
  if (!viewId.startsWith(CATALOG_PROJECT_VIEW_PREFIX)) return undefined;
  const raw = viewId.slice(CATALOG_PROJECT_VIEW_PREFIX.length).trim();
  if (raw === "others") return "others";
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function moduleIndexFromKey(key: string): string | undefined {
  for (const idx of MODULE_INDICES) {
    if (key.includes(idx)) return idx;
  }
  return undefined;
}

function isModuleField(key: string): boolean {
  if (SEPARATOR_KEY_RE.test(key.trim())) return false;
  const idx = moduleIndexFromKey(key);
  if (!idx) return false;
  return (
    key.includes("工作模块") ||
    key.includes("成本归属项目") ||
    key.includes("任务类型") ||
    key.includes("事项-结果") ||
    key.includes("工时统计")
  );
}

function fieldForModule(
  contents: ReportContentField[],
  idx: string,
  kind: "work" | "project" | "result",
): ReportContentField | undefined {
  const needle =
    kind === "work" ? "工作模块" : kind === "project" ? "成本归属项目" : "事项-结果";
  return contents.find((f) => f.key.includes(needle) && f.key.includes(idx));
}

function moduleBlockHasBody(contents: ReportContentField[], idx: string): boolean {
  const work = fieldForModule(contents, idx, "work")?.value?.trim() ?? "";
  const project = fieldForModule(contents, idx, "project")?.value?.trim() ?? "";
  const result = fieldForModule(contents, idx, "result")?.value?.trim() ?? "";
  return Boolean(work || project || result);
}

export function reportHasProjectWorkBlock(entry: ReportEntry): boolean {
  return MODULE_INDICES.some((idx) => moduleBlockHasBody(entry.contents, idx));
}

function sliceEntryBlocks(entry: ReportEntry, keptIndices: Set<string>): ReportEntry {
  if (keptIndices.size === 0) return { ...entry, contents: [] };
  const contents = entry.contents.filter((f) => {
    if (SEPARATOR_KEY_RE.test(f.key.trim())) return false;
    const idx = moduleIndexFromKey(f.key);
    if (!idx || !isModuleField(f.key)) return false;
    return keptIndices.has(idx);
  });
  return { ...entry, contents };
}

/** 与 filterReportEntryForView 同口径：keyword 优先，否则成对 filter。 */
export function blockMatchesProjectView(
  contents: ReportContentField[],
  idx: string,
  view: DailyReportProjectViewConfig & { orgLabel?: string },
): boolean {
  if (isOthersProjectView(view)) return false;
  const keyword = view.filters.keyword?.trim();
  if (keyword) {
    return moduleBlockMatchesKeywordFilter(contents, idx, keyword);
  }
  const work = view.filters.workModuleContains?.trim();
  const project = view.filters.costProjectContains?.trim();
  if (work && project) {
    return moduleBlockMatchesPairFilter(contents, idx, {
      workModuleContains: work,
      costProjectContains: project,
    });
  }
  if (project) {
    return moduleBlockMatchesCostProjectFilter(contents, idx, project);
  }
  return false;
}

export function findAllMatchingProjectViewsForBlock(
  contents: ReportContentField[],
  idx: string,
  projectViews: Array<DailyReportProjectViewConfig & { orgLabel?: string }>,
): string[] {
  const matched: string[] = [];
  for (const view of projectViews) {
    if (blockMatchesProjectView(contents, idx, view)) {
      matched.push(view.id);
    }
  }
  return matched;
}

export interface PartitionReportResult {
  byViewId: Map<string, ReportEntry[]>;
  others: ReportEntry[];
}

export function partitionReportEntry(
  entry: ReportEntry,
  projectViewsOrdered: Array<DailyReportProjectViewConfig & { orgLabel?: string }>,
  othersViewId = "others",
): PartitionReportResult {
  const byViewId = new Map<string, ReportEntry[]>();
  const othersIndices = new Set<string>();
  const projectIndicesByView = new Map<string, Set<string>>();

  for (const idx of MODULE_INDICES) {
    if (!moduleBlockHasBody(entry.contents, idx)) continue;
    const matchedViewIds = findAllMatchingProjectViewsForBlock(
      entry.contents,
      idx,
      projectViewsOrdered,
    );
    if (matchedViewIds.length === 0) {
      othersIndices.add(idx);
    } else {
      for (const viewId of matchedViewIds) {
        let set = projectIndicesByView.get(viewId);
        if (!set) {
          set = new Set<string>();
          projectIndicesByView.set(viewId, set);
        }
        set.add(idx);
      }
    }
  }

  for (const [viewId, indices] of projectIndicesByView) {
    const sliced = filterReportEntry(sliceEntryBlocks(entry, indices));
    if (sliced.contents.length > 0) {
      const list = byViewId.get(viewId) ?? [];
      list.push(sliced);
      byViewId.set(viewId, list);
    }
  }

  const othersReports: ReportEntry[] = [];
  if (othersIndices.size > 0) {
    const sliced = filterReportEntry(sliceEntryBlocks(entry, othersIndices));
    if (sliced.contents.length > 0) {
      othersReports.push(sliced);
      const existing = byViewId.get(othersViewId) ?? [];
      byViewId.set(othersViewId, [...existing, sliced]);
    }
  }

  return { byViewId, others: othersReports };
}

/**
 * 动态项目目录：仅以同一工作块的“成本归属项目”为项目来源。
 * 非空值交给后台别名表解析/创建标准项目；空值或无法解析的值进入其他。
 */
export function partitionReportEntryByCostProject(
  entry: ReportEntry,
  resolveProject: CostProjectResolver,
): Map<string, ReportEntry[]> {
  const indicesByView = new Map<string, Set<string>>();

  for (const idx of MODULE_INDICES) {
    if (!moduleBlockHasBody(entry.contents, idx)) continue;
    const rawProject = fieldForModule(entry.contents, idx, "project")?.value?.trim() ?? "";
    const resolved = rawProject ? resolveProject(rawProject) : null;
    const viewId = resolved ? catalogProjectViewId(resolved.id) : CATALOG_OTHERS_VIEW_ID;
    const indices = indicesByView.get(viewId) ?? new Set<string>();
    indices.add(idx);
    indicesByView.set(viewId, indices);
  }

  const byViewId = new Map<string, ReportEntry[]>();
  for (const [viewId, indices] of indicesByView) {
    const sliced = filterReportEntry(sliceEntryBlocks(entry, indices));
    if (sliced.contents.length > 0) byViewId.set(viewId, [sliced]);
  }
  return byViewId;
}

export interface UnifiedDayPartitionResult {
  poolUserIds: Set<string>;
  byViewId: Map<string, OrgDigest>;
}

export function mergePartitionedReports(
  orgLabel: string,
  partitioned: Iterable<{
    userid: string;
    name: string;
    byViewId: Map<string, ReportEntry[]>;
  }>,
  viewIds: string[],
): UnifiedDayPartitionResult {
  const poolUserIds = new Set<string>();
  const submittedByView = new Map<string, Map<string, OrgDigest["submitted"][number]>>();

  for (const viewId of viewIds) {
    submittedByView.set(viewId, new Map());
  }

  for (const row of partitioned) {
    poolUserIds.add(row.userid);
    for (const viewId of viewIds) {
      const reports = row.byViewId.get(viewId);
      if (!reports?.length) continue;
      const filtered = reports.filter((r) => r.contents.length > 0);
      if (filtered.length === 0) continue;
      const bucket = submittedByView.get(viewId)!;
      const existing = bucket.get(row.userid);
      if (existing) {
        existing.reports.push(...filtered);
      } else {
        bucket.set(row.userid, {
          userid: row.userid,
          name: row.name,
          reports: filtered,
        });
      }
    }
  }

  const byViewId = new Map<string, OrgDigest>();
  for (const viewId of viewIds) {
    const submitted = [...(submittedByView.get(viewId)?.values() ?? [])];
    submitted.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    byViewId.set(viewId, {
      label: orgLabel,
      submitted,
      missing: [],
      onLeave: [],
      errors: [],
    });
  }

  return { poolUserIds, byViewId };
}

function viewParticipatesInPartition(view: DailyReportProjectViewConfig): boolean {
  if (isOthersProjectView(view)) return false;
  if (view.filters.keyword?.trim()) return true;
  const work = view.filters.workModuleContains?.trim();
  const project = view.filters.costProjectContains?.trim();
  return Boolean(project);
}

export function listProjectViewIdsForPartition(
  views: Array<DailyReportProjectViewConfig & { orgLabel?: string }>,
): string[] {
  const ids: string[] = [];
  for (const v of views) {
    if (viewParticipatesInPartition(v)) {
      ids.push(v.id);
    }
  }
  const others = views.find((v) => isOthersProjectView(v));
  if (others) ids.push(others.id);
  return ids;
}
