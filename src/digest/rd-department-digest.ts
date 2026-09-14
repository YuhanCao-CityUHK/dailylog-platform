import type { EmployeeReports, OrgDigest } from "./daily-report-build";
import { loadDailyReportDigestConfig } from "./daily-report-config";
import { loadOrCollectUnifiedDay } from "./daily-report-day-partition-cache";
import {
  fallbackCtoRollupOverviewSummary,
  loadDailyReportMorningLlmConfig,
  summarizeProjectViewMorningForCtoRollup,
} from "./daily-report-project-view-morning-llm";
import {
  isOthersProjectView,
  listProjectViewsFromConfig,
  type DailyReportProjectViewConfig,
} from "./daily-report-project-views";
import type { ReportEntry } from "./dingtalk-report-client";
import { createDingTalkContactDirectory } from "./dingtalk-contact-search";
import { isBotLikeContactName } from "./daily-report-org-scan-contacts";
import type { ReportTimeRange } from "./daily-report-window";
import { CONFIG } from "../infra/config";
import { getDb } from "../infra/db";
import { normalizePublicPageUrl, wrapUrlForDingtalkClient } from "../infra/workbench-chat-link";
import { fetchSubmittedItems, type SubmittedItem } from "../platform/store";

export const RD_DIGEST_PROJECT_LABELS = [
  "半导体",
  "CLA",
  "OCT",
  "冲击波",
  "斑块减容",
  "其他",
  "静脉腔闭合系统",
  "水锤项目",
] as const;

export interface RdDigestProjectLine {
  viewId: string;
  label: string;
  peopleCount: number;
  hours: number;
  summary: string;
}

export interface RdDepartmentDigestData {
  dateYmd: string;
  dateLabel: string;
  departmentDisplayName: string;
  departmentTotal: number;
  departmentSubmitted: number;
  platformTotal: number;
  platformSubmitted: number;
  missingNames: string[];
  projects: RdDigestProjectLine[];
  distinctSubmittedCount: number;
  projectPersonTimes: number;
  totalHours: number;
  detailUrl: string;
}

interface ExternalUser {
  id: number;
  name: string;
}

type ProjectViewWithOrg = DailyReportProjectViewConfig & { orgLabel: string };

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max = 180): string {
  const text = compact(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function sumDigestHours(digest: OrgDigest): number {
  let total = 0;
  for (const person of digest.submitted) {
    for (const report of person.reports) {
      for (const field of report.contents) {
        if (!field.key.includes("工时统计")) continue;
        const values = field.value.match(/\d+(?:\.\d+)?/g) ?? [];
        total += values.reduce((sum, value) => sum + Number(value), 0);
      }
    }
  }
  return roundHours(total);
}

function listExternalUsers(): ExternalUser[] {
  return getDb()
    .prepare(
      `SELECT id, name FROM users
       WHERE active = 1 AND should_submit = 1 AND is_external = 1
       ORDER BY id`,
    )
    .all() as unknown as ExternalUser[];
}

function listExternalSubmittedUserIds(dateYmd: string, userIds: number[]): Set<number> {
  if (userIds.length === 0) return new Set();
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT user_id FROM logs
       WHERE status = 'submitted' AND date = ?
         AND user_id IN (${userIds.map(() => "?").join(",")})`,
    )
    .all(dateYmd, ...(userIds as never[])) as unknown as Array<{ user_id: number }>;
  return new Set(rows.map((row) => row.user_id));
}

function normalizedLabel(value: string): string {
  return compact(value).toLocaleLowerCase("zh-CN");
}

export function mapPlatformItemToProjectViewId(
  item: Pick<SubmittedItem, "aff" | "affName">,
  views: ProjectViewWithOrg[],
): string {
  const others = views.find(isOthersProjectView);
  if (item.aff === "dept") return others?.id ?? "others";
  const target = normalizedLabel(item.affName);
  const exact = views.find(
    (view) => !isOthersProjectView(view) && normalizedLabel(view.label) === target,
  );
  return exact?.id ?? others?.id ?? "others";
}

function syntheticPlatformReport(
  user: ExternalUser,
  items: SubmittedItem[],
  dateYmd: string,
): ReportEntry {
  return {
    reportId: `platform:${dateYmd}:${user.id}`,
    creatorUserId: `platform:${user.id}`,
    creatorName: user.name,
    templateName: "平台工作日志",
    createTime: Date.parse(`${dateYmd}T12:00:00+08:00`),
    contents: items.flatMap((item, index) => [
      { key: `事项-结果${index + 1}`, value: item.text, type: "text" },
      { key: `工时统计${index + 1}`, value: String(item.hours), type: "text" },
    ]),
  };
}

function mergePlatformItems(
  digest: OrgDigest,
  items: SubmittedItem[],
  externalUsers: ExternalUser[],
  dateYmd: string,
): OrgDigest {
  const usersById = new Map(externalUsers.map((user) => [user.id, user]));
  const itemsByUser = new Map<number, SubmittedItem[]>();
  for (const item of items) {
    const list = itemsByUser.get(item.userId) ?? [];
    list.push(item);
    itemsByUser.set(item.userId, list);
  }
  const platformSubmitted: EmployeeReports[] = [];
  for (const [userId, userItems] of itemsByUser) {
    const user = usersById.get(userId);
    if (!user) continue;
    platformSubmitted.push({
      userid: `platform:${user.id}`,
      name: user.name,
      reports: [syntheticPlatformReport(user, userItems, dateYmd)],
    });
  }
  return { ...digest, submitted: [...digest.submitted, ...platformSubmitted] };
}

function validateProjectViews(views: ProjectViewWithOrg[]): void {
  const labels = new Set(views.map((view) => view.label));
  const missing = RD_DIGEST_PROJECT_LABELS.filter((label) => !labels.has(label));
  if (missing.length > 0) {
    throw new Error(`研发部门日报缺少项目分类：${missing.join("、")}`);
  }
}

function buildDetailUrl(dateYmd: string): string {
  const params = new URLSearchParams({ date: dateYmd, view: "custom:overview" });
  const direct = `${CONFIG.publicBaseUrl.replace(/\/$/, "")}/workbench/daily-reports?${params}`;
  return wrapUrlForDingtalkClient(normalizePublicPageUrl(direct));
}

export async function buildRdDepartmentDigest(
  range: ReportTimeRange,
  deps?: { fetchImpl?: typeof fetch; refresh?: boolean },
): Promise<RdDepartmentDigestData> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const { config, errors } = loadDailyReportDigestConfig();
  if (errors.length > 0) throw new Error(`日报配置错误：${errors.join("；")}`);
  const views = listProjectViewsFromConfig(config.orgs);
  validateProjectViews(views);
  const org = config.orgs.find((candidate) =>
    views.some((view) => view.orgLabel === candidate.label),
  );
  if (!org) throw new Error("未找到研发日报组织配置");
  const orgViews = views.filter((view) => view.orgLabel === org.label);

  const directory = createDingTalkContactDirectory({ fetchImpl });
  const [departmentRoster, unified] = await Promise.all([
    directory.listDepartmentTree(
      org.appKey,
      org.appSecret,
      CONFIG.rdDepartmentDigest.departmentName,
      5000,
    ),
    loadOrCollectUnifiedDay({
      org,
      range,
      scanMode: "full",
      refresh: deps?.refresh,
      fetchImpl,
    }),
  ]);
  const roster = departmentRoster.filter((member) => !isBotLikeContactName(member.name));
  if (roster.length === 0) {
    throw new Error(`研发部门通讯录为空：${CONFIG.rdDepartmentDigest.departmentName}`);
  }
  if (!unified.fromCache && unified.scanContactCount === 0) {
    throw new Error("钉钉日报全员扫描结果为空");
  }
  const rosterUserIds = new Set(roster.map((member) => member.userid));
  const relevantErrors = unified.errors.filter((error) => rosterUserIds.has(error.userid));
  if (relevantErrors.length > 0) {
    throw new Error(`研发部门日报读取失败：${relevantErrors.map((e) => e.name).join("、")}`);
  }

  const externalUsers = listExternalUsers();
  const externalUserIds = externalUsers.map((user) => user.id);
  const externalSubmittedIds = listExternalSubmittedUserIds(range.labelYmd, externalUserIds);
  const externalItems = fetchSubmittedItems({ dates: [range.labelYmd], userIds: externalUserIds });
  const externalItemsByView = new Map<string, SubmittedItem[]>();
  for (const item of externalItems) {
    const viewId = mapPlatformItemToProjectViewId(item, orgViews);
    const list = externalItemsByView.get(viewId) ?? [];
    list.push(item);
    externalItemsByView.set(viewId, list);
  }

  const submittedDingTalkUserIds = new Set<string>();
  const dateLabel = `${range.labelDisplay}（${range.labelYmd}）`;
  const llmConfig = loadDailyReportMorningLlmConfig();
  const projects = await Promise.all(
    orgViews.map(async (view) => {
      const sourceDigest = unified.byViewId.get(view.id) ?? {
        label: org.label,
        submitted: [],
        missing: [],
        onLeave: [],
        errors: [],
      };
      const filteredDigest: OrgDigest = {
        ...sourceDigest,
        submitted: sourceDigest.submitted.filter((person) => {
          const included = rosterUserIds.has(person.userid);
          if (included) submittedDingTalkUserIds.add(person.userid);
          return included;
        }),
        errors: sourceDigest.errors.filter((error) => rosterUserIds.has(error.userid)),
      };
      const merged = mergePlatformItems(
        filteredDigest,
        externalItemsByView.get(view.id) ?? [],
        externalUsers,
        range.labelYmd,
      );
      const summary =
        merged.submitted.length === 0
          ? "暂无相关记录"
          : llmConfig
            ? (
                await summarizeProjectViewMorningForCtoRollup(
                  view.label,
                  dateLabel,
                  roster.length + externalUsers.length,
                  merged,
                  llmConfig,
                  fetchImpl,
                )
              ).overview
            : fallbackCtoRollupOverviewSummary(
                view.label,
                roster.length + externalUsers.length,
                merged,
              ).overview;
      return {
        viewId: view.id,
        label: view.label,
        peopleCount: merged.submitted.length,
        hours: sumDigestHours(merged),
        summary: clip(summary || "详见工作台日报汇总"),
      } satisfies RdDigestProjectLine;
    }),
  );

  const missingNames = [
    ...roster
      .filter((member) => !submittedDingTalkUserIds.has(member.userid))
      .map((member) => member.name),
    ...externalUsers
      .filter((user) => !externalSubmittedIds.has(user.id))
      .map((user) => user.name),
  ];
  const projectPersonTimes = projects.reduce((sum, project) => sum + project.peopleCount, 0);
  const totalHours = roundHours(projects.reduce((sum, project) => sum + project.hours, 0));
  const distinctSubmittedCount = submittedDingTalkUserIds.size + externalSubmittedIds.size;

  return {
    dateYmd: range.labelYmd,
    dateLabel,
    departmentDisplayName: CONFIG.rdDepartmentDigest.displayName,
    departmentTotal: roster.length,
    departmentSubmitted: submittedDingTalkUserIds.size,
    platformTotal: externalUsers.length,
    platformSubmitted: externalSubmittedIds.size,
    missingNames,
    projects,
    distinctSubmittedCount,
    projectPersonTimes,
    totalHours,
    detailUrl: buildDetailUrl(range.labelYmd),
  };
}

function formatHours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

export function renderRdDepartmentDigestMarkdown(
  digest: RdDepartmentDigestData,
  options?: { preview?: boolean },
): { title: string; markdown: string } {
  const title = `${digest.departmentDisplayName} · 昨日项目日报`;
  const lines = [`## ${title}`, `> ${digest.dateLabel}`];
  if (options?.preview) lines.push("> 模拟预览 · 不影响正式推送记录");
  lines.push(
    "",
    "### 提交概况",
    `- ${digest.departmentDisplayName}：${digest.departmentSubmitted}/${digest.departmentTotal} 已提交`,
    `- 平台人员：${digest.platformSubmitted}/${digest.platformTotal} 已提交`,
    `- **未提交**：${digest.missingNames.length > 0 ? digest.missingNames.join("、") : "无"}`,
    "",
    "### 各项目昨日",
  );
  for (const project of digest.projects) {
    const hours = project.hours > 0 ? ` · ${formatHours(project.hours)}小时` : "";
    lines.push(
      `- **${project.label}** · ${project.peopleCount}人${hours} · ${project.summary}`,
    );
  }
  lines.push(
    "",
    `**合计**：${digest.projects.length}个项目 · ${digest.projectPersonTimes}项目人次 / ${digest.distinctSubmittedCount}人提交 · ${formatHours(digest.totalHours)}小时`,
    "",
    "### 查看详情",
    `- [工作台 · 全部项目](${digest.detailUrl})`,
  );
  return { title, markdown: lines.join("\n") };
}
