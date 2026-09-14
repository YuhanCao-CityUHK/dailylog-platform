import { filterReportEntryForView } from "./daily-report-project-view-filter";
import {
  isOthersProjectView,
  type DailyReportProjectViewConfig,
} from "./daily-report-project-views";
import type { ReportEntry } from "./dingtalk-report-client";
import { reportHasProjectWorkBlock } from "./daily-report-day-partition";

/** 微光 CTO 日报统计：三类研发模板优先参与统一日筛与分桶。 */
export const RD_DAILY_TEMPLATE_MATCHERS = [
  "研发中心日志",
  "研发管理者日志",
  "研发试用期日志",
] as const;

export function isRdDailyTemplate(templateName: string): boolean {
  const n = String(templateName ?? "").trim();
  if (!n) return false;
  return RD_DAILY_TEMPLATE_MATCHERS.some((m) => n.includes(m));
}

export function isMedicalAffairsTemplate(templateName: string): boolean {
  return String(templateName ?? "").trim().includes("医学事务");
}

export function reportMatchesAnyProjectKeyword(
  entry: ReportEntry,
  projectViews: Array<DailyReportProjectViewConfig & { orgLabel?: string }>,
): boolean {
  for (const view of projectViews) {
    if (isOthersProjectView(view)) continue;
    const hasFilter =
      view.filters.keyword?.trim()
      || view.filters.costProjectContains?.trim();
    if (!hasFilter) continue;
    const filtered = filterReportEntryForView(entry, view.filters);
    if (filtered.contents.length > 0) return true;
  }
  return false;
}

/**
 * 统一日筛准入：三类研发模板全收；其余模板（含医学事务部）
 * 仅当模块命中任一项目 keyword/成对 filter 时纳入。
 */
export function reportEligibleForUnifiedPartition(
  entry: ReportEntry,
  projectViews: Array<DailyReportProjectViewConfig & { orgLabel?: string }>,
): boolean {
  if (isRdDailyTemplate(entry.templateName)) return true;
  if (reportHasProjectWorkBlock(entry)) return true;
  return reportMatchesAnyProjectKeyword(entry, projectViews);
}
