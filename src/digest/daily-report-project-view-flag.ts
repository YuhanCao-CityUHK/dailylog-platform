/**
 * 微光侧可配置项目组视图（managebot 实例级开关）。
 * 与 legacy 日报 digest 群推（mingsibot）解耦：仅 managebot 设 1。
 */
export function isDailyReportProjectViewsEnabled(): boolean {
  const raw = String(process.env.DAILY_REPORT_PROJECT_VIEWS_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
