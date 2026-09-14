/**
 * 自定义项目组视图名单：权限、列名单、增删、重新发现。
 * 供 assignment-workbench 的 HTTP 接口调用。
 */
import { loadDailyReportDigestConfig, type DailyReportDigestConfig } from "../digest/daily-report-config";
import { runProjectViewDiscovery } from "../digest/daily-report-project-view-discovery";
import {
  addProjectViewRosterMember,
  createProjectViewRosterStore,
  listProjectViewRoster,
  removeProjectViewRosterMember,
  type ProjectViewRosterMember,
} from "../digest/daily-report-project-view-roster-store";
import {
  findProjectViewById,
  listProjectViewsFromConfig,
  type WorkbenchDailyReportsCaps,
} from "../digest/daily-report-project-views";

export function canManageProjectViewRoster(
  userId: string,
  viewId: string,
  config: DailyReportDigestConfig,
  caps: WorkbenchDailyReportsCaps,
): boolean {
  if (caps.canAccessAdmin) return true;
  const view = findProjectViewById(config, viewId);
  return Boolean(view?.viewers.includes(userId));
}

/** 非 admin 的 custom 视图 viewer 可按组织搜人（加入项目组名单）。 */
export function canSearchProjectViewOrgContacts(
  userId: string,
  orgLabel: string,
  config: DailyReportDigestConfig,
  caps: WorkbenchDailyReportsCaps,
): boolean {
  if (caps.canAccessAdmin) return true;
  const label = orgLabel.trim();
  if (!label) return false;
  return listProjectViewsFromConfig(config.orgs).some(
    (v) => v.orgLabel === label && v.viewers.includes(userId),
  );
}

export interface ProjectViewRosterPayload {
  ok: boolean;
  viewId: string;
  label?: string;
  orgLabel?: string;
  members: ProjectViewRosterMember[];
  error?: string;
}

export function getProjectViewRosterPayload(viewId: string): ProjectViewRosterPayload {
  const cleanViewId = viewId.trim();
  const { config, errors } = loadDailyReportDigestConfig();
  if (errors.length > 0) {
    return { ok: false, viewId: cleanViewId, members: [], error: errors.join("；") };
  }
  const view = findProjectViewById(config, cleanViewId);
  if (!view) {
    return { ok: false, viewId: cleanViewId, members: [], error: `未知项目组视图：${cleanViewId}` };
  }
  const store = createProjectViewRosterStore();
  try {
    return {
      ok: true,
      viewId: cleanViewId,
      label: view.label,
      orgLabel: view.orgLabel,
      members: listProjectViewRoster(cleanViewId, store),
    };
  } finally {
    store.close();
  }
}

export async function mutateProjectViewRoster(input: {
  viewId: string;
  action: "add" | "remove";
  userid: string;
  name?: string;
}): Promise<ProjectViewRosterPayload> {
  const viewId = input.viewId.trim();
  const userid = input.userid.trim();
  if (!viewId) {
    return { ok: false, viewId: "", members: [], error: "viewId 不能为空" };
  }
  if (!userid) {
    return { ok: false, viewId, members: [], error: "userid 不能为空" };
  }

  const { config, errors } = loadDailyReportDigestConfig();
  if (errors.length > 0) {
    return { ok: false, viewId, members: [], error: errors.join("；") };
  }
  const view = findProjectViewById(config, viewId);
  if (!view) {
    return { ok: false, viewId, members: [], error: `未知项目组视图：${viewId}` };
  }

  const store = createProjectViewRosterStore();
  try {
    if (input.action === "add") {
      addProjectViewRosterMember(
        viewId,
        { userid, name: input.name?.trim() || undefined, source: "manual" },
        store,
      );
    } else if (input.action === "remove") {
      removeProjectViewRosterMember(viewId, userid, store);
    } else {
      return { ok: false, viewId, members: [], error: "action 必须为 add 或 remove" };
    }
    return {
      ok: true,
      viewId,
      label: view.label,
      orgLabel: view.orgLabel,
      members: listProjectViewRoster(viewId, store),
    };
  } finally {
    store.close();
  }
}

export interface RediscoverProjectViewRosterResult {
  ok: boolean;
  viewId: string;
  added?: number;
  totalRoster?: number;
  members?: ProjectViewRosterMember[];
  label?: string;
  orgLabel?: string;
  error?: string;
}

export async function rediscoverProjectViewRoster(
  viewId: string,
  deps?: { fetchImpl?: typeof fetch },
): Promise<RediscoverProjectViewRosterResult> {
  const cleanViewId = viewId.trim();
  const { config, errors } = loadDailyReportDigestConfig();
  if (errors.length > 0) {
    return { ok: false, viewId: cleanViewId, error: errors.join("；") };
  }
  const view = findProjectViewById(config, cleanViewId);
  if (!view) {
    return { ok: false, viewId: cleanViewId, error: `未知项目组视图：${cleanViewId}` };
  }

  const result = await runProjectViewDiscovery(cleanViewId, config, deps);
  const payload = getProjectViewRosterPayload(cleanViewId);
  return {
    ok: true,
    viewId: cleanViewId,
    added: result.added,
    totalRoster: result.totalRoster,
    members: payload.members,
    label: view.label,
    orgLabel: view.orgLabel,
  };
}

const PROJECT_VIEW_ROSTER_PATH_RE =
  /^\/api\/workbench(?:\/manager)?\/daily-reports\/project-views\/([^/]+)\/roster$/;

const PROJECT_VIEW_DISCOVER_PATH_RE =
  /^\/api\/workbench(?:\/manager)?\/daily-reports\/project-views\/([^/]+)\/discover$/;

export function parseDailyReportsProjectViewRosterPath(pathname: string): string | undefined {
  const m = PROJECT_VIEW_ROSTER_PATH_RE.exec(pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

export function parseDailyReportsProjectViewDiscoverPath(pathname: string): string | undefined {
  const m = PROJECT_VIEW_DISCOVER_PATH_RE.exec(pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}
