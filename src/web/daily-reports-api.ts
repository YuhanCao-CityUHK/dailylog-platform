import { loadDailyReportDigestConfig } from "../digest/daily-report-config";
import { collectOrgDigests } from "../digest/daily-report-run";
import type { OrgDigest } from "../digest/daily-report-build";
import {
  groupOrgDigestsByProject,
  listProjectGroupAssignmentsFromConfig,
  PROJECT_GROUPS,
  type ProjectGroupId,
} from "../digest/daily-report-project-groups";
import {
  createProjectViewCacheStore,
  deleteProjectViewCache,
  getProjectViewCache,
} from "../digest/daily-report-project-view-cache";
import {
  createDayPartitionCacheStore,
  deleteDayPartitionCache,
  loadOrCollectUnifiedDay,
} from "../digest/daily-report-day-partition-cache";
import { listProjectViewsFromConfig } from "../digest/daily-report-project-views";
import {
  findProjectViewById,
  resolveDailyReportsAccess,
  type DailyReportsAccessInfo,
  type WorkbenchDailyReportsCaps,
} from "../digest/daily-report-project-views";
import {
  createProjectViewRosterStore,
  listProjectViewRoster,
} from "../digest/daily-report-project-view-roster-store";
import {
  resolveDayRangeForYmd,
  resolveReportRange,
} from "../digest/daily-report-window";
import type { DailyReportsViewMode } from "../digest/daily-report-workbench-link";
import {
  buildOpenReportInDingtalkPayload,
} from "../digest/daily-report-dingtalk-report-link";
import type { ReportAttachment } from "../digest/daily-report-attachments";
import { reportHasResolvableImages } from "../digest/daily-report-attachments";
import type { ReportEntry } from "../digest/dingtalk-report-client";
import {
  catalogProjectViewId,
  parseCatalogProjectViewId,
} from "../digest/daily-report-day-partition";
import { getCanonicalProject } from "../platform/project-catalog";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyReportsReportPayload {
  reportId?: string;
  creatorUserId?: string;
  templateName: string;
  createTime: number;
  openInDingtalkUrl?: string;
  openInDingtalkOpenApp?: string;
  openInDingtalkH5Url?: string;
  openInDingtalkClientLink?: string;
  hasInlineImages?: boolean;
  contents: Array<{
    key: string;
    value: string;
    type?: string;
    attachments?: Array<{ name: string; url?: string; fileId?: string; spaceId?: string }>;
  }>;
  images?: Array<{ name: string; url?: string; fileId?: string; spaceId?: string }>;
}

export interface DailyReportsOrgPayload {
  label: string;
  submitted: Array<{
    userid: string;
    name: string;
    projectGroup?: ProjectGroupId;
    reports: DailyReportsReportPayload[];
  }>;
  missing: Array<{ userid: string; name: string; projectGroup?: ProjectGroupId }>;
  onLeave: Array<{ userid: string; name: string; projectGroup?: ProjectGroupId }>;
  errors: Array<{ userid: string; name: string; reason: string }>;
}

export interface DailyReportsProjectGroupPayload {
  id: ProjectGroupId;
  label: string;
  orgs: DailyReportsOrgPayload[];
}

export interface DailyReportsCustomProjectViewPayload {
  id: string;
  label: string;
  orgLabel: string;
  orgs: DailyReportsOrgPayload[];
}

export interface DailyReportsHttpPayload {
  ok: boolean;
  error?: string;
  configured?: boolean;
  view?: DailyReportsViewMode;
  access?: DailyReportsAccessInfo;
  date?: string;
  dateLabel?: string;
  generatedAt?: string;
  submittedCount?: number;
  missingCount?: number;
  onLeaveCount?: number;
  errorCount?: number;
  orgs?: DailyReportsOrgPayload[];
  projectGroups?: DailyReportsProjectGroupPayload[];
  customProjectView?: DailyReportsCustomProjectViewPayload;
  scanning?: boolean;
  rosterCount?: number;
  /** 本次完整日分桶实际枚举的组织员工数。 */
  scanContactCount?: number;
  /** 当日研发/关键词命中模板提交人数（统一日筛） */
  poolCount?: number;
  cacheScannedAt?: string;
  /** 本次为 roster 快扫（未写全员缓存）；点刷新可拉全量 */
  partialScan?: boolean;
  activity?: DailyReportsActivityPayload;
}

export interface DailyReportsActivityPayload {
  totalHours: number;
  participantCount: number;
  itemCount: number;
  reportCount: number;
}

const MODULE_INDEX_RE = /[①②③④⑤⑥⑦⑧⑨⑩]/;
const MODULE_FIELD_RE = /工作模块|成本归属项目|任务类型|事项-结果|工时统计/;

export function summarizeDailyReportsActivity(
  orgs: DailyReportsOrgPayload[],
): DailyReportsActivityPayload {
  const participants = new Set<string>();
  let totalHours = 0;
  let itemCount = 0;
  let reportCount = 0;

  for (const org of orgs) {
    for (const person of org.submitted) {
      participants.add(person.userid || person.name);
      for (const report of person.reports) {
        reportCount += 1;
        const moduleIndices = new Set<string>();
        for (const field of report.contents) {
          if (field.key.includes("工时统计")) {
            const values = field.value.match(/\d+(?:\.\d+)?/g) ?? [];
            totalHours += values.reduce((sum, value) => sum + Number(value), 0);
          }
          if (MODULE_FIELD_RE.test(field.key)) {
            const index = field.key.match(MODULE_INDEX_RE)?.[0];
            if (index) moduleIndices.add(index);
          }
        }
        itemCount += moduleIndices.size || (report.contents.length > 0 ? 1 : 0);
      }
    }
  }

  return {
    totalHours: Math.round(totalHours * 10) / 10,
    participantCount: participants.size,
    itemCount,
    reportCount,
  };
}

function mapAttachment(a: ReportAttachment): ReportAttachment {
  return {
    name: a.name,
    ...(a.url ? { url: a.url } : {}),
    ...(a.fileId ? { fileId: a.fileId } : {}),
    ...(a.spaceId ? { spaceId: a.spaceId } : {}),
  };
}

function mapReportPayload(r: ReportEntry): DailyReportsReportPayload {
  const links = buildOpenReportInDingtalkPayload({
    reportId: r.reportId,
    creatorUserId: r.creatorUserId,
    createTime: r.createTime,
  });
  return {
    reportId: r.reportId,
    creatorUserId: r.creatorUserId,
    templateName: r.templateName,
    createTime: r.createTime,
    openInDingtalkUrl: links?.openInDingtalkUrl,
    openInDingtalkOpenApp: links?.openInDingtalkOpenApp,
    openInDingtalkH5Url: links?.openInDingtalkH5Url,
    openInDingtalkClientLink: links?.openInDingtalkClientLink,
    hasInlineImages: reportHasResolvableImages(r),
    contents: r.contents.map((c) => ({
      key: c.key,
      value: c.value,
      type: c.type,
      attachments: c.attachments?.map(mapAttachment),
    })),
    images: r.images?.map(mapAttachment),
  };
}

function mapOrgDigest(
  org: Awaited<ReturnType<typeof collectOrgDigests>>["orgDigests"][0],
  assignments: Map<string, ProjectGroupId>,
): DailyReportsOrgPayload {
  return {
    label: org.label,
    submitted: org.submitted.map((emp) => ({
      userid: emp.userid,
      name: emp.name,
      projectGroup: assignments.get(emp.userid),
      reports: emp.reports.map(mapReportPayload),
    })),
    missing: org.missing.map((m) => ({
      userid: m.userid,
      name: m.name,
      projectGroup: assignments.get(m.userid),
    })),
    onLeave: (org.onLeave ?? []).map((m) => ({
      userid: m.userid,
      name: m.name,
      projectGroup: assignments.get(m.userid),
    })),
    errors: org.errors,
  };
}

export function parseDailyReportsViewParam(raw: unknown): DailyReportsViewMode {
  const v = String(raw ?? "").trim();
  if (v.toLowerCase() === "company") return "company";
  if (v.startsWith("custom:")) return v as DailyReportsViewMode;
  if (v.startsWith("catalog:")) return v as DailyReportsViewMode;
  return "project";
}

function parseCustomViewId(view: DailyReportsViewMode): string | undefined {
  if (!view.startsWith("custom:")) return undefined;
  const id = view.slice("custom:".length).trim();
  return id || undefined;
}

function resolveDefaultView(access: DailyReportsAccessInfo): DailyReportsViewMode {
  if (access.customOnly && access.customViews[0]) {
    return `custom:${access.customViews[0].id}`;
  }
  return "project";
}

export function normalizeDailyReportsViewForAccess(
  requestedView: DailyReportsViewMode,
  access: DailyReportsAccessInfo,
  caps: WorkbenchDailyReportsCaps,
): DailyReportsViewMode {
  let view = requestedView;
  const catalogSelection = parseCatalogProjectViewId(view);
  const canViewRequestedCatalog =
    catalogSelection !== undefined && (caps.canViewCatalog === true || access.legacyAccess);
  if (access.customOnly && !canViewRequestedCatalog) {
    const allowed = new Set(access.customViews.map((v) => v.id));
    const customId = parseCustomViewId(view);
    if (!customId || !allowed.has(customId)) {
      view = resolveDefaultView(access);
    }
  } else if (!access.legacyAccess && parseCustomViewId(view) == null && !canViewRequestedCatalog) {
    view = resolveDefaultView(access);
  }
  return view;
}

/**
 * 工作台「跨组织日报」页面的数据源：实时拉取各组织目标员工某天的钉钉日志并聚合。
 */
export async function buildDailyReportsHttpPayload(input?: {
  date?: string;
  view?: DailyReportsViewMode;
  userId?: string;
  caps?: WorkbenchDailyReportsCaps;
  now?: Date;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
}): Promise<DailyReportsHttpPayload> {
  const { config, errors } = loadDailyReportDigestConfig();
  if (errors.length > 0) {
    return {
      ok: false,
      configured: false,
      error: `日报功能未配置或配置无效：${errors.join("；")}`,
    };
  }

  const caps: WorkbenchDailyReportsCaps = input?.caps ?? {
    canAccessAdmin: false,
    canManage: true,
    canViewCatalog: true,
  };
  const access = input?.userId
    ? resolveDailyReportsAccess(input.userId, config, caps)
    : { legacyAccess: true, customOnly: false, customViews: [] };

  const requestedView = input?.view ? parseDailyReportsViewParam(input.view) : resolveDefaultView(access);
  const view = normalizeDailyReportsViewForAccess(requestedView, access, caps);

  const now = input?.now ?? new Date();
  const date = input?.date?.trim();
  if (date && !YMD_RE.test(date)) {
    return { ok: false, error: `非法日期格式：${date}（应为 YYYY-MM-DD）` };
  }
  const cutoffOpts = {
    cutoffHour: config.reportDayCutoffHour,
    cutoffMinute: config.reportDayCutoffMinute,
  };
  const range = date
    ? resolveDayRangeForYmd(date, config.timezone, cutoffOpts)
    : resolveReportRange(now, config.timezone, cutoffOpts);

  const catalogSelection = parseCatalogProjectViewId(view);
  if (catalogSelection !== undefined) {
    if (!caps.canViewCatalog && !access.legacyAccess) {
      return { ok: false, error: "无权查看动态项目日报" };
    }
    const project =
      catalogSelection === "others" ? undefined : getCanonicalProject(catalogSelection);
    if (catalogSelection !== "others" && !project) {
      return { ok: false, error: `项目不存在：${catalogSelection}` };
    }

    const viewId =
      catalogSelection === "others"
        ? "catalog:others"
        : catalogProjectViewId(catalogSelection);
    const viewLabel = project?.name ?? "其他（未填写或未识别）";
    const refresh = input?.refresh === true;
    const cacheStore = createProjectViewCacheStore();
    const partitionStore = createDayPartitionCacheStore();
    const rosterStore = createProjectViewRosterStore();
    try {
      const orgPayloads: DailyReportsOrgPayload[] = [];
      let poolCount = 0;
      let scanContactCount = 0;
      let cacheScannedAt = "";
      let errorCount = 0;

      for (const org of config.orgs) {
        if (refresh) {
          deleteDayPartitionCache(org.label, range.labelYmd, partitionStore);
          deleteProjectViewCache(viewId, range.labelYmd, cacheStore);
        }
        const unified = await loadOrCollectUnifiedDay({
          org,
          range,
          refresh,
          scanMode: "full",
          partitionStore,
          projectViewCacheStore: cacheStore,
          rosterStore,
          ownsPartitionStore: false,
          ownsProjectViewCacheStore: false,
          ownsRosterStore: false,
          fetchImpl: input?.fetchImpl,
        });
        const digest: OrgDigest =
          unified.byViewId.get(viewId) ?? {
            label: org.label,
            submitted: [],
            missing: [],
            onLeave: [],
            errors: unified.errors,
          };
        const payload = mapOrgDigest(digest, new Map());
        orgPayloads.push(payload);
        poolCount += unified.poolCount;
        scanContactCount += unified.scanContactCount ?? 0;
        errorCount += payload.errors.length;
        if ((unified.scannedAt ?? "") > cacheScannedAt) {
          cacheScannedAt = unified.scannedAt ?? "";
        }
      }

      const submittedCount = orgPayloads.reduce((sum, org) => sum + org.submitted.length, 0);
      return {
        ok: true,
        configured: true,
        view,
        access,
        date: range.labelYmd,
        dateLabel: range.labelDisplay,
        generatedAt: now.toISOString(),
        submittedCount,
        missingCount: 0,
        onLeaveCount: 0,
        errorCount,
        rosterCount: 0,
        poolCount,
        scanContactCount,
        cacheScannedAt: cacheScannedAt || undefined,
        partialScan: false,
        scanning: false,
        activity: summarizeDailyReportsActivity(orgPayloads),
        customProjectView: {
          id: viewId,
          label: viewLabel,
          orgLabel: orgPayloads.map((org) => org.label).join(" / "),
          orgs: orgPayloads,
        },
      };
    } finally {
      rosterStore.close();
      partitionStore.close();
      cacheStore.close();
    }
  }

  const customViewId = parseCustomViewId(view);
  if (customViewId) {
    const viewDef = findProjectViewById(config, customViewId);
    if (!viewDef) {
      return { ok: false, error: `未知项目组视图：${customViewId}` };
    }
    if (
      input?.userId
      && !viewDef.viewers.includes(input.userId)
      && !caps.canAccessAdmin
      && !access.legacyAccess
    ) {
      return { ok: false, error: "无权查看此项目组视图" };
    }
    const org = config.orgs.find((o) => o.label === viewDef.orgLabel);
    if (!org) {
      return { ok: false, error: `视图关联组织不存在：${viewDef.orgLabel}` };
    }

    const refresh = input?.refresh === true;
    const cacheStore = createProjectViewCacheStore();
    const partitionStore = createDayPartitionCacheStore();
    const rosterStore = createProjectViewRosterStore();
    try {
      if (refresh) {
        deleteDayPartitionCache(org.label, range.labelYmd, partitionStore);
        for (const v of listProjectViewsFromConfig([org])) {
          deleteProjectViewCache(v.id, range.labelYmd, cacheStore);
        }
      }

      const rosterCount = listProjectViewRoster(customViewId, rosterStore).length;
      const unified = await loadOrCollectUnifiedDay({
        org,
        range,
        refresh,
        // 项目工作台把“是否抓全”作为可信度信息展示，因此缓存缺失时也必须
        // 枚举组织全员；名单快扫只能作为内部预览，不能作为正式页面结果。
        scanMode: "full",
        partitionStore,
        projectViewCacheStore: cacheStore,
        rosterStore,
        ownsPartitionStore: false,
        ownsProjectViewCacheStore: false,
        ownsRosterStore: false,
        fetchImpl: input?.fetchImpl,
      });

      const poolCount = unified.poolCount;
      const digest: OrgDigest =
        unified.byViewId.get(customViewId) ?? {
          label: org.label,
          submitted: [],
          missing: [],
          onLeave: [],
          errors: unified.errors,
        };

      const updatedCache = getProjectViewCache(customViewId, range.labelYmd, cacheStore);
      const orgPayload = mapOrgDigest(digest, new Map());
      return {
        ok: true,
        configured: true,
        view,
        access,
        date: range.labelYmd,
        dateLabel: range.labelDisplay,
        generatedAt: now.toISOString(),
        submittedCount: orgPayload.submitted.length,
        missingCount: 0,
        onLeaveCount: 0,
        errorCount: orgPayload.errors.length,
        rosterCount,
        poolCount,
        scanContactCount: unified.scanContactCount,
        cacheScannedAt: unified.scannedAt ?? updatedCache?.scannedAt,
        partialScan: false,
        scanning: false,
        activity: summarizeDailyReportsActivity([orgPayload]),
        customProjectView: {
          id: viewDef.id,
          label: viewDef.label,
          orgLabel: viewDef.orgLabel,
          orgs: [orgPayload],
        },
      };
    } finally {
      rosterStore.close();
      partitionStore.close();
      cacheStore.close();
    }
  }

  if (!access.legacyAccess) {
    return { ok: false, error: "无权查看公司/项目视图" };
  }

  const { orgDigests, errorCount } = await collectOrgDigests(config, range, {
    fetchImpl: input?.fetchImpl,
  });

  const assignmentsList = listProjectGroupAssignmentsFromConfig(config.orgs);
  const assignmentMap = new Map(assignmentsList.map((a) => [a.userid, a.projectGroup]));

  let submittedCount = 0;
  let missingCount = 0;
  let onLeaveCount = 0;
  const orgs = orgDigests.map((org) => {
    submittedCount += org.submitted.length;
    missingCount += org.missing.length;
    onLeaveCount += (org.onLeave ?? []).length;
    return mapOrgDigest(org, assignmentMap);
  });

  const grouped = groupOrgDigestsByProject(orgDigests, assignmentsList);
  const projectGroups: DailyReportsProjectGroupPayload[] = grouped.map((g) => ({
    id: g.id,
    label: g.label,
    orgs: g.orgs.map((org) => mapOrgDigest(org, assignmentMap)),
  }));

  return {
    ok: true,
    configured: true,
    view,
    access,
    date: range.labelYmd,
    dateLabel: range.labelDisplay,
    generatedAt: now.toISOString(),
    submittedCount,
    missingCount,
    onLeaveCount,
    errorCount,
    orgs: view === "company" ? orgs : undefined,
    projectGroups: view === "project" ? projectGroups : undefined,
  };
}

export { PROJECT_GROUPS };
