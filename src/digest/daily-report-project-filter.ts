import type { ReportContentField, ReportEntry } from "./dingtalk-report-client";

const MODULE_INDICES = ["①", "②", "③", "④", "⑤", "⑥"] as const;
const SEPARATOR_KEY_RE = /^-+/;

function normalizeProjectLabel(value: string): string {
  return value.trim();
}

/** 成本归属项目字段是否与任一 filter 匹配（精确或互相包含）。 */
export function projectValueMatchesFilter(value: string, filters: string[]): boolean {
  const v = normalizeProjectLabel(value);
  if (!v) return false;
  return filters.some((raw) => {
    const f = normalizeProjectLabel(raw);
    if (!f) return false;
    return v === f || v.includes(f) || f.includes(v);
  });
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

function projectFieldForModule(contents: ReportContentField[], idx: string): ReportContentField | undefined {
  return contents.find((f) => f.key.includes("成本归属项目") && f.key.includes(idx));
}

/**
 * 微光类模板：按模块序号保留「成本归属项目」命中 filter 的工作块；
 * 非模块字段（如今日计划）在启用 projectFilter 时不保留。
 */
export function filterReportEntryByProject(
  entry: ReportEntry,
  projectFilters: string[],
): ReportEntry {
  if (projectFilters.length === 0) return entry;

  const kept = new Set<string>();
  for (const idx of MODULE_INDICES) {
    const projectField = projectFieldForModule(entry.contents, idx);
    if (projectField && projectValueMatchesFilter(projectField.value, projectFilters)) {
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
