/**
 * 「日报汇总」工作台页面的可用性开关（实例级功能分叉）。
 *
 * 默认关闭：仅在 env 设置 DAILY_REPORTS_PAGE_ENABLED=1 时显示页面、API 与侧栏入口。
 * mingsibot 实例打开此开关即可提供日报页（含微光侧 projectViews）；managebot 不配则不出。
 */
export function isDailyReportsPageEnabled(): boolean {
  const raw = String(process.env.DAILY_REPORTS_PAGE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
