/**
 * 日报汇总可见性：管理角色（lead/mgr/exec/admin）直接可见；
 * 此外，凡在日报汇总配置 projectViews[].viewers 里出现的钉钉 userid（如示例主管这类看板用户），
 * 即使角色是普通员工也可见——与原任务工作台的授权行为保持一致（随配置文件自动继承，无需额外设置）。
 */
import type { SessionUser } from "../auth/types";
import { canViewDailyReports } from "../auth/types";
import { loadDailyReportDigestConfig } from "../digest/daily-report-config";
import { listProjectViewsFromConfig } from "../digest/daily-report-project-views";

export interface DailyReportProjectLink {
  id: string;
  name: string;
}

/** 项目页使用的日报项目组入口；只返回当前用户实际有权查看的项目组。 */
export function listDailyReportProjectsForUser(user: SessionUser): DailyReportProjectLink[] {
  if (user.isExternal) return [];
  try {
    const { config } = loadDailyReportDigestConfig();
    const views = listProjectViewsFromConfig(config.orgs);
    const allowed = user.role === "admin"
      ? views
      : user.ddUserid
        ? views.filter((view) => view.viewers.includes(user.ddUserid!))
        : [];
    return allowed.map((view) => ({ id: view.id, name: view.label }));
  } catch {
    return [];
  }
}

export function userCanViewDailyReports(user: SessionUser): boolean {
  if (canViewDailyReports(user)) return true;
  return listDailyReportProjectsForUser(user).length > 0;
}
