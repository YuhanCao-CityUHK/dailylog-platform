import type { ReportContentField, ReportEntry } from "./dingtalk-report-client";

const MODULE_INDICES = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"] as const;
const SEPARATOR_KEY_RE = /^-+/;

export type ProjectViewRole = "project" | "others";

export interface ProjectViewFilter {
  role?: ProjectViewRole;
  keyword?: string;
  workModuleContains?: string;
  costProjectContains?: string;
}

/** @deprecated alias */
export type ModuleProjectPairFilter = Required<
  Pick<ProjectViewFilter, "workModuleContains" | "costProjectContains">
>;

function normalizeLabel(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
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
  kind: "work" | "project",
): ReportContentField | undefined {
  const needle = kind === "work" ? "工作模块" : "成本归属项目";
  return contents.find((f) => f.key.includes(needle) && f.key.includes(idx));
}

export function moduleBlockMatchesKeywordFilter(
  contents: ReportContentField[],
  idx: string,
  keyword: string,
): boolean {
  const needle = normalizeLabel(keyword);
  if (!needle) return false;
  const work = normalizeLabel(fieldForModule(contents, idx, "work")?.value ?? "");
  const project = normalizeLabel(fieldForModule(contents, idx, "project")?.value ?? "");
  return work.includes(needle) || project.includes(needle);
}

/** 同一模块序号内：工作模块含 workModuleContains 且成本项目含 costProjectContains。 */
export function moduleBlockMatchesPairFilter(
  contents: ReportContentField[],
  idx: string,
  filter: ModuleProjectPairFilter,
): boolean {
  const work = fieldForModule(contents, idx, "work");
  const project = fieldForModule(contents, idx, "project");
  const workNeedle = normalizeLabel(filter.workModuleContains);
  const projectNeedle = normalizeLabel(filter.costProjectContains);
  if (!workNeedle || !projectNeedle) return false;
  return (
    normalizeLabel(work?.value ?? "").includes(workNeedle)
    && normalizeLabel(project?.value ?? "").includes(projectNeedle)
  );
}

/** 同一模块序号内：仅成本归属项目包含指定文本。 */
export function moduleBlockMatchesCostProjectFilter(
  contents: ReportContentField[],
  idx: string,
  costProjectContains: string,
): boolean {
  const needle = normalizeLabel(costProjectContains);
  if (!needle) return false;
  return normalizeLabel(fieldForModule(contents, idx, "project")?.value ?? "").includes(needle);
}

export function filterReportEntryByKeyword(entry: ReportEntry, keyword: string): ReportEntry {
  const needle = normalizeLabel(keyword);
  if (!needle) return { ...entry, contents: [] };
  const kept = new Set<string>();
  for (const idx of MODULE_INDICES) {
    if (moduleBlockMatchesKeywordFilter(entry.contents, idx, needle)) kept.add(idx);
  }
  if (kept.size === 0) return { ...entry, contents: [] };
  const contents = entry.contents.filter((f) => {
    if (SEPARATOR_KEY_RE.test(f.key.trim())) return false;
    const idx = moduleIndexFromKey(f.key);
    if (!idx || !isModuleField(f.key)) return false;
    return kept.has(idx);
  });
  return { ...entry, contents };
}

/**
 * 微光多模块模板：保留命中 module+project 成对条件的工作块（任意 ①–⑥）。
 * 非模块字段在启用 filter 时不保留。
 */
export function filterReportEntryByModuleProjectPair(
  entry: ReportEntry,
  filter: ModuleProjectPairFilter,
): ReportEntry {
  const workNeedle = normalizeLabel(filter.workModuleContains);
  const projectNeedle = normalizeLabel(filter.costProjectContains);
  if (!workNeedle || !projectNeedle) return entry;

  const kept = new Set<string>();
  for (const idx of MODULE_INDICES) {
    if (moduleBlockMatchesPairFilter(entry.contents, idx, filter)) {
      kept.add(idx);
    }
  }

  if (kept.size === 0) {
    return { ...entry, contents: [] };
  }

  const contents = entry.contents.filter((f) => {
    if (SEPARATOR_KEY_RE.test(f.key.trim())) return false;
    const idx = moduleIndexFromKey(f.key);
    if (!idx || !isModuleField(f.key)) return false;
    return kept.has(idx);
  });

  return { ...entry, contents };
}

/**
 * 微光多模块模板：只按「成本归属项目」保留对应工作块。
 * 用于项目名称就是唯一口径的场景，避免工作模块或其它编号把无关日志混入。
 */
export function filterReportEntryByCostProject(
  entry: ReportEntry,
  costProjectContains: string,
): ReportEntry {
  const needle = normalizeLabel(costProjectContains);
  if (!needle) return { ...entry, contents: [] };

  const kept = new Set<string>();
  for (const idx of MODULE_INDICES) {
    if (moduleBlockMatchesCostProjectFilter(entry.contents, idx, needle)) kept.add(idx);
  }
  if (kept.size === 0) return { ...entry, contents: [] };

  const contents = entry.contents.filter((f) => {
    if (SEPARATOR_KEY_RE.test(f.key.trim())) return false;
    const idx = moduleIndexFromKey(f.key);
    return Boolean(idx && isModuleField(f.key) && kept.has(idx));
  });
  return { ...entry, contents };
}

export function filterReportEntryForView(entry: ReportEntry, filter: ProjectViewFilter): ReportEntry {
  const keyword = normalizeLabel(filter.keyword ?? "");
  if (keyword) return filterReportEntryByKeyword(entry, keyword);
  const work = normalizeLabel(filter.workModuleContains ?? "");
  const project = normalizeLabel(filter.costProjectContains ?? "");
  if (work && project) {
    return filterReportEntryByModuleProjectPair(
      entry,
      { workModuleContains: work, costProjectContains: project },
    );
  }
  if (project) return filterReportEntryByCostProject(entry, project);
  return { ...entry, contents: [] };
}
