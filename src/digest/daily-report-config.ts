import * as fs from "fs";
import { normalizeProjectGroupId, type ProjectGroupId } from "./daily-report-project-groups";
import {
  parseProjectViewConfig,
  type DailyReportProjectViewConfig,
} from "./daily-report-project-views";

/**
 * 单个钉钉组织的读取凭证 + 目标员工。
 * 每个组织是独立的钉钉企业，使用各自的企业内部应用 appKey/appSecret，
 * 且该应用需在开发者后台申请「查询企业员工日志权限」。
 *
 * 复用现网部署的应用（如明思 manage-robot 本身）时，可省略 appKey/appSecret，
 * 或显式 `useDeployedAppCredentials: true`，自动回退到部署进程的
 * DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET。
 */
export interface DailyReportOrgConfig {
  /** 组织展示名，如 "微光" / "明思"，仅用于群消息分组展示 */
  label: string;
  appKey: string;
  appSecret: string;
  /** 是否复用部署进程的 DINGTALK_CLIENT_ID/SECRET（明思本机器人）；缺省时若未填 appKey/appSecret 也会自动回退 */
  useDeployedAppCredentials?: boolean;
  /** 可选：仅统计该日志模板（如 "日报"）；留空=该员工当天所有日志都算 */
  templateName?: string;
  /** 需要汇总日报的目标员工（该组织内的 userid） */
  employees: Array<{ userid: string; name?: string; projectGroup?: "intracranial" | "brain" | "ops" }>;
  /** 可选：仅保留「成本归属项目」命中任一 filter 的工作模块（微光等多模块模板） */
  projectFilter?: string[];
  /** 可配置项目组视图（微光侧扩展；viewer 白名单 + 模块/项目成对 filter） */
  projectViews?: DailyReportProjectViewConfig[];
}

/** 明思群里「自定义群机器人」的 Webhook 凭证（与企业应用凭证无关）。 */
export interface DailyReportWebhookConfig {
  /** Webhook 地址里 access_token= 后面的值 */
  accessToken: string;
  /** 加签 secret（机器人安全设置里 SEC 开头的串）；留空=未开启加签 */
  secret?: string;
}

/** 钉钉知识库表格：每人创建一张 WORKBOOK 时使用。 */
export interface DailyReportDocConfig {
  workspaceId: string;
  operatorUnionId: string;
  parentNodeId?: string;
  /** 月归档文件夹的父节点；缺省为知识库根 */
  archiveBaseNodeId?: string;
  /** 是否按 YYYY-MM 自动归档；默认 true（手动 parentNodeId 优先） */
  monthArchive?: boolean;
}

export type DailyReportPushMode = "full" | "morning";

export interface DailyReportDigestConfig {
  enabled: boolean;
  scanIntervalMs: number;
  timezone: string;
  sendHour: number;
  sendMinute: number;
  weekdaysOnly: boolean;
  /**
   * 业务日截止时刻（本地时区小时，0–23）。默认 17。
   * 业务日 D 的日报 = 提交时间 ∈ [D cutoff, D+1 cutoff)。
   * 设为 0 退回自然日（00:00 ~ 次日 00:00）。
   */
  reportDayCutoffHour: number;
  /** 业务日截止时刻（分钟，0–59）。默认 0。 */
  reportDayCutoffMinute: number;
  /** 是否查询钉钉考勤并将全天请假（≥8h 或 1 天）从「未交」拆出；默认 true */
  leaveCheckEnabled: boolean;
  /** 群消息标题（钉钉 markdown 折叠摘要用） */
  title: string;
  /** full=原文拼接；morning=LLM 综述 + 个人表格链接 */
  pushMode: DailyReportPushMode;
  /** 早报模式下创建钉钉表格（可选；createWorkbookOnSend=true 且配置 doc 时才创建） */
  doc?: DailyReportDocConfig;
  /** morning 模式是否在发送时创建知识库总表；默认 false（群链改工作台） */
  createWorkbookOnSend?: boolean;
  /** 当日去重状态目录（文件标记，单实例假设） */
  stateDir: string;
  webhook: DailyReportWebhookConfig;
  orgs: DailyReportOrgConfig[];
}

export interface DailyReportConfigParseResult {
  config: DailyReportDigestConfig;
  errors: string[];
}

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (raw === "") return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envInt(name: string, defaultValue: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

function clampHour(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(23, Math.max(0, Math.floor(n)));
}

function clampMinute(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(59, Math.max(0, Math.floor(n)));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析配置 JSON（纯函数，便于测试）。
 * schedule 类字段优先取 JSON，缺省回退到默认值；`enabled` 由调用方按 env 主开关叠加。
 */
export function parseDailyReportDigestConfig(raw: unknown): DailyReportConfigParseResult {
  const errors: string[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;

  // webhook 仅定时群推需要；只看工作台页面时可不填（见 loadDailyReportDigestConfig 的 enabled 门禁）。
  const webhookRaw = (obj.webhook ?? {}) as Record<string, unknown>;
  const webhook: DailyReportWebhookConfig = {
    accessToken: asString(webhookRaw.accessToken),
    secret: asString(webhookRaw.secret) || undefined,
  };

  const orgsRaw = Array.isArray(obj.orgs) ? obj.orgs : [];
  const orgs: DailyReportOrgConfig[] = [];
  const deployedAppKey = env("DINGTALK_CLIENT_ID");
  const deployedAppSecret = env("DINGTALK_CLIENT_SECRET");
  orgsRaw.forEach((entry, idx) => {
    const o = (entry ?? {}) as Record<string, unknown>;
    const label = asString(o.label) || `组织${idx + 1}`;
    let appKey = asString(o.appKey);
    let appSecret = asString(o.appSecret);
    const wantsDeployed =
      o.useDeployedAppCredentials === true || (!appKey && !appSecret);
    let useDeployedAppCredentials = false;
    if (wantsDeployed) {
      if (deployedAppKey && deployedAppSecret) {
        appKey = deployedAppKey;
        appSecret = deployedAppSecret;
        useDeployedAppCredentials = true;
      }
    }
    const templateName = asString(o.templateName) || undefined;
    const employeesRaw = Array.isArray(o.employees) ? o.employees : [];
    const employees = employeesRaw
      .map((e) => {
        const er = (e ?? {}) as Record<string, unknown>;
        const projectGroup = normalizeProjectGroupId(er.projectGroup);
        return {
          userid: asString(er.userid),
          name: asString(er.name) || undefined,
          ...(projectGroup ? { projectGroup } : {}),
        };
      })
      .filter((e) => e.userid.length > 0);
    if (!appKey || !appSecret) {
      errors.push(
        wantsDeployed
          ? `orgs[${idx}] (${label}) 复用部署应用凭证失败：DINGTALK_CLIENT_ID/SECRET 未配置`
          : `orgs[${idx}] (${label}) 缺少 appKey/appSecret`,
      );
    }
    const projectFilterRaw = o.projectFilter;
    let projectFilter: string[] | undefined;
    if (projectFilterRaw != null) {
      const list = Array.isArray(projectFilterRaw)
        ? projectFilterRaw
        : [projectFilterRaw];
      projectFilter = list.map((x) => asString(x)).filter((x) => x.length > 0);
      if (projectFilter.length === 0) projectFilter = undefined;
    }
    const projectViewsRaw = Array.isArray(o.projectViews) ? o.projectViews : [];
    const projectViews: DailyReportProjectViewConfig[] = [];
    projectViewsRaw.forEach((raw, vIdx) => {
      const parsed = parseProjectViewConfig(raw, label);
      if (parsed) {
        projectViews.push(parsed);
      } else if (raw != null) {
        errors.push(`orgs[${idx}] (${label}) projectViews[${vIdx}] 无效（需 id/label/viewers/filters 全名）`);
      }
    });
    if (employees.length === 0 && projectViews.length === 0) {
      errors.push(`orgs[${idx}] (${label}) employees 为空（需要至少一个 userid，或配置 projectViews）`);
    }
    orgs.push({
      label,
      appKey,
      appSecret,
      useDeployedAppCredentials,
      templateName,
      employees,
      projectFilter,
      ...(projectViews.length > 0 ? { projectViews } : {}),
    });
  });
  if (orgs.length === 0) {
    errors.push("orgs 为空（至少配置一个组织）");
  }

  const pushModeRaw = asString(obj.pushMode).toLowerCase();
  const pushMode: DailyReportPushMode = pushModeRaw === "morning" ? "morning" : "full";

  const docRaw = (obj.doc ?? {}) as Record<string, unknown>;
  const docWorkspaceId = asString(docRaw.workspaceId);
  const docOperatorUnionId = asString(docRaw.operatorUnionId);
  let doc: DailyReportDocConfig | undefined;
  if (docWorkspaceId || docOperatorUnionId) {
    if (!docWorkspaceId || !docOperatorUnionId) {
      errors.push("doc 需同时配置 workspaceId 与 operatorUnionId");
    } else {
      const monthArchiveRaw = docRaw.monthArchive;
      const monthArchive =
        typeof monthArchiveRaw === "boolean" ? monthArchiveRaw : monthArchiveRaw == null ? true : Boolean(monthArchiveRaw);
      doc = {
        workspaceId: docWorkspaceId,
        operatorUnionId: docOperatorUnionId,
        parentNodeId: asString(docRaw.parentNodeId) || undefined,
        archiveBaseNodeId: asString(docRaw.archiveBaseNodeId) || undefined,
        monthArchive,
      };
    }
  }

  const createWorkbookOnSend =
    typeof obj.createWorkbookOnSend === "boolean"
      ? obj.createWorkbookOnSend
      : envFlag("DAILY_REPORT_CREATE_WORKBOOK_ON_SEND", false);

  const config: DailyReportDigestConfig = {
    enabled: false,
    scanIntervalMs: envInt("DAILY_REPORT_DIGEST_SCAN_INTERVAL_MS", 300_000),
    timezone: asString(obj.timezone) || env("DAILY_REPORT_DIGEST_TIMEZONE") || "Asia/Shanghai",
    sendHour: clampHour(obj.sendHour ?? (env("DAILY_REPORT_DIGEST_HOUR") || 7), 7),
    sendMinute: clampMinute(obj.sendMinute ?? (env("DAILY_REPORT_DIGEST_MINUTE") || 0), 0),
    reportDayCutoffHour: clampHour(
      obj.reportDayCutoffHour ?? (env("DAILY_REPORT_DAY_CUTOFF_HOUR") || 17),
      17,
    ),
    reportDayCutoffMinute: clampMinute(
      obj.reportDayCutoffMinute ?? (env("DAILY_REPORT_DAY_CUTOFF_MINUTE") || 0),
      0,
    ),
    leaveCheckEnabled:
      typeof obj.leaveCheckEnabled === "boolean"
        ? obj.leaveCheckEnabled
        : envFlag("DAILY_REPORT_LEAVE_CHECK_ENABLED", true),
    weekdaysOnly:
      typeof obj.weekdaysOnly === "boolean"
        ? obj.weekdaysOnly
        : envFlag("DAILY_REPORT_DIGEST_WEEKDAYS_ONLY", true),
    title: asString(obj.title) || "每日日报汇总",
    pushMode,
    doc,
    createWorkbookOnSend,
    stateDir:
      asString(obj.stateDir) ||
      env("DAILY_REPORT_DIGEST_STATE_DIR") ||
      "data/daily-report-digest",
    webhook,
    orgs,
  };

  return { config, errors };
}

/**
 * 从 DAILY_REPORT_DIGEST_CONFIG_FILE 指向的 JSON 文件加载配置。
 * - `enabled` = env 主开关 DAILY_REPORT_DIGEST_ENABLED && 文件解析无致命错误。
 * - 文件缺失/解析失败 → 返回 enabled:false（不抛异常，调度器静默不启动）。
 */
export function loadDailyReportDigestConfig(opts?: {
  filePath?: string;
  readFileImpl?: (path: string) => string;
}): DailyReportConfigParseResult {
  const masterEnabled = envFlag("DAILY_REPORT_DIGEST_ENABLED", false);
  const filePath = opts?.filePath ?? env("DAILY_REPORT_DIGEST_CONFIG_FILE");

  if (!filePath) {
    const fallback = parseDailyReportDigestConfig({});
    return {
      config: { ...fallback.config, enabled: false },
      errors: ["DAILY_REPORT_DIGEST_CONFIG_FILE 未配置"],
    };
  }

  let rawText: string;
  try {
    const reader = opts?.readFileImpl ?? ((p: string) => fs.readFileSync(p, "utf8"));
    rawText = reader(filePath);
  } catch (err) {
    const fallback = parseDailyReportDigestConfig({});
    return {
      config: { ...fallback.config, enabled: false },
      errors: [`读取配置文件失败: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const fallback = parseDailyReportDigestConfig({});
    return {
      config: { ...fallback.config, enabled: false },
      errors: [`配置文件 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const result = parseDailyReportDigestConfig(parsed);
  // 群推（scheduler）额外要求 webhook；只看页面不需要 webhook（页面只读 config.orgs）。
  const pushEnabled =
    masterEnabled && result.errors.length === 0 && Boolean(result.config.webhook.accessToken);
  return {
    config: { ...result.config, enabled: pushEnabled },
    errors: result.errors,
  };
}

/** legacy 日报页（公司/项目视图、6 人名单）是否已配置。managebot 仅 projectViews 时为 false。 */
export function configHasLegacyDailyReportEmployees(
  orgs: DailyReportOrgConfig[],
): boolean {
  return orgs.some((o) => o.employees.length > 0);
}
