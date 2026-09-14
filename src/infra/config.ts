/** 平台配置：全部来自环境变量（.env），凭证不进代码。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv();

function env(name: string, fallback = ""): string {
  return String(process.env[name] ?? fallback).trim();
}

function envInt(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envList(name: string): string[] {
  return env(name)
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function envListWithFallback(primary: string, fallback: string): string[] {
  const values = envList(primary);
  return values.length > 0 ? values : envList(fallback);
}

function envNumberInRange(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export const CONFIG = {
  /** http 监听 */
  port: envInt("PORT", 8100),
  host: env("HOST", "127.0.0.1"),
  publicBaseUrl: env("PUBLIC_BASE_URL", "https://dailylog.vivolightsales.com"),

  /** 数据目录 */
  dataDir: env("DATA_DIR", "./data"),
  uploadsDir: env("UPLOADS_DIR", "./data/uploads"),

  /** 会话 */
  sessionSecret: env("SESSION_SECRET", ""),
  sessionTtlHours: envInt("SESSION_TTL_HOURS", 72),
  sessionIdleHours: envInt("SESSION_IDLE_HOURS", 24),

  /** 钉钉（微光企业内部应用；同一凭证用于免登 + 日报拉取 + 提醒推送） */
  dingtalk: {
    clientId: env("DINGTALK_CLIENT_ID"),
    clientSecret: env("DINGTALK_CLIENT_SECRET"),
    corpId: env("DINGTALK_CORP_ID"),
    agentId: env("DINGTALK_AGENT_ID"),
    appId: env("DINGTALK_APP_ID"),
  },

  /** DWS 个人钉钉上下文：每个平台用户使用独立 HOME 与凭证目录。 */
  dws: {
    enabled: envFlag("DWS_ENABLED", true),
    binary: env("DWS_BIN", "dws"),
    timeoutMs: envInt("DWS_TIMEOUT_MS", 15000),
    authTimeoutMs: envInt("DWS_AUTH_TIMEOUT_MS", 15 * 60 * 1000),
    usersDir: env("DWS_USERS_DIR", "./data/dws-users"),
    assistantPilotUserids: envList("DWS_ASSISTANT_PILOT_USERIDS"),
    maxBufferBytes: envInt("DWS_MAX_BUFFER_BYTES", 2 * 1024 * 1024),
  },

  /** 对话式日报助手（总开关面向全部钉钉员工；名单仅保留给提醒等独立灰度任务）。 */
  assistant: {
    enabled: envFlag("DAILY_ASSISTANT_ENABLED", false),
    pilotUserids: envListWithFallback("DAILY_ASSISTANT_PILOT_USERIDS", "DWS_ASSISTANT_PILOT_USERIDS"),
    contextDbPath: env("DAILY_ASSISTANT_CONTEXT_DB", "./data/assistant-context.sqlite"),
    contextEncryptionKey: env("DAILY_ASSISTANT_CONTEXT_KEY"),
    referenceTtlHours: envInt("DAILY_ASSISTANT_REFERENCE_TTL_HOURS", 12),
    globalConcurrency: envNumberInRange("DAILY_ASSISTANT_GLOBAL_CONCURRENCY", 4, 1, 64),
    perUserConcurrency: envNumberInRange("DAILY_ASSISTANT_PER_USER_CONCURRENCY", 3, 1, 8),
    prewarmEnabled: envFlag("DAILY_ASSISTANT_PREWARM_ENABLED", false),
    reminderEnabled: envFlag("DAILY_ASSISTANT_REMINDER_ENABLED", false),
    conversationEnabled: envFlag("DAILY_ASSISTANT_CONVERSATION_ENABLED", false),
    submitEnabled: envFlag("DAILY_ASSISTANT_SUBMIT_ENABLED", false),
    managerOverviewEnabled: envFlag("DAILY_ASSISTANT_MANAGER_OVERVIEW_ENABLED", false),
    prewarmHour: envNumberInRange("DAILY_ASSISTANT_PREWARM_HOUR", 17, 0, 23),
    prewarmMinute: envNumberInRange("DAILY_ASSISTANT_PREWARM_MINUTE", 30, 0, 59),
    todayReminderHour: envNumberInRange("DAILY_ASSISTANT_TODAY_REMINDER_HOUR", 17, 0, 23),
    todayReminderMinute: envNumberInRange("DAILY_ASSISTANT_TODAY_REMINDER_MINUTE", 30, 0, 59),
    overdueReminderHour: envNumberInRange("DAILY_ASSISTANT_OVERDUE_REMINDER_HOUR", 9, 0, 23),
    overdueReminderMinute: envNumberInRange("DAILY_ASSISTANT_OVERDUE_REMINDER_MINUTE", 30, 0, 59),
    botSenderIds: [...new Set([
      ...envList("DAILY_ASSISTANT_BOT_SENDER_IDS"),
      env("DINGTALK_CLIENT_ID"),
      env("DINGTALK_AGENT_ID"),
    ].filter(Boolean))],
    groupOthersSignalMaxMembers: envNumberInRange("DAILY_ASSISTANT_GROUP_OTHERS_SIGNAL_MAX_MEMBERS", 20, 1, 5000),
    agentV2Enabled: envFlag("DAILY_ASSISTANT_AGENT_V2_ENABLED", false),
    /** 按钉钉 userid 灰度：只有名单内的试点员工走 V2 内核，其余仍走旧内核；同一会话只由一个内核写入。 */
    agentV2Userids: envList("DAILY_ASSISTANT_AGENT_V2_USERIDS"),
    primaryModel: env("DAILY_ASSISTANT_PRIMARY_MODEL", "qwen3.7-max-2026-06-08"),
    backupModel: env("DAILY_ASSISTANT_BACKUP_MODEL", "qwen3.7-plus-2026-05-26"),
    modelTimeoutMs: envInt("DAILY_ASSISTANT_MODEL_TIMEOUT_MS", 60000),
    eventFusionEnabled: envFlag("DAILY_ASSISTANT_EVENT_FUSION_ENABLED", false),
    eventFusionPilotUserids: envList("DAILY_ASSISTANT_EVENT_FUSION_PILOT_USERIDS"),
    eventPrimaryModel: env("DAILY_ASSISTANT_EVENT_PRIMARY_MODEL", "qwen3.7-max-2026-06-08"),
    eventBackupModel: env("DAILY_ASSISTANT_EVENT_BACKUP_MODEL", "qwen3.7-plus-2026-05-26"),
    eventModelTimeoutMs: envInt("DAILY_ASSISTANT_EVENT_MODEL_TIMEOUT_MS", 60000),
    eventMaxInputTokens: envInt("DAILY_ASSISTANT_EVENT_MAX_INPUT_TOKENS", 24000),
    eventMaxOutputTokens: envInt("DAILY_ASSISTANT_EVENT_MAX_OUTPUT_TOKENS", 5000),
    eventPromptVersion: env("DAILY_ASSISTANT_EVENT_PROMPT_VERSION", "event-fusion-v1"),
    workDiscoveryEnabled: envFlag("DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED", false),
    workDiscoveryPilotUserids: envList("DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS"),
    workDiscoveryMaxCandidates: envNumberInRange("DAILY_ASSISTANT_WORK_DISCOVERY_MAX_CANDIDATES", 50, 8, 100),
  },

  /** 角色映射（钉钉 userid 列表；未列出者默认 emp） */
  roles: {
    admins: envList("ROLE_ADMIN_USERIDS"),
    adminNames: envList("ROLE_ADMIN_NAMES"),
    execs: envList("ROLE_EXEC_USERIDS"),
    mgrs: envList("ROLE_MGR_USERIDS"),
    leads: envList("ROLE_LEAD_USERIDS"),
  },

  /** 可额外查看外部账号工作日志的内部钉钉用户 */
  externalLogViewerUserids: envList("EXTERNAL_LOG_VIEWER_USERIDS"),

  /** 部门名（emp 权限范围提示等展示用途） */
  deptName: env("DEPT_NAME", "研发部"),

  /** 提醒（工作日 9:00 钉钉工作通知；需 DINGTALK_AGENT_ID） */
  reminder: {
    enabled: envFlag("REMINDER_ENABLED", false),
    hour: envInt("REMINDER_HOUR", 9),
    minute: envInt("REMINDER_MINUTE", 0) || 0,
  },

  /** 研发部门昨日项目日报（钉钉机器人单聊卡片）。 */
  rdDepartmentDigest: {
    enabled: envFlag("DAILY_REPORT_RD_DIGEST_ENABLED", false),
    recipientUserIds: envListWithFallback(
      "DAILY_REPORT_RD_DIGEST_RECIPIENT_USERIDS",
      "DAILY_REPORT_RD_DIGEST_RECIPIENT_USERID",
    ),
    departmentName: env("DAILY_REPORT_RD_DIGEST_DEPARTMENT_NAME", "研发中心"),
    displayName: env("DAILY_REPORT_RD_DIGEST_DISPLAY_NAME", "研发部门"),
    sendHour: envNumberInRange("DAILY_REPORT_RD_DIGEST_SEND_HOUR", 7, 0, 23),
    sendMinute: envNumberInRange("DAILY_REPORT_RD_DIGEST_SEND_MINUTE", 0, 0, 59),
  },

  /** LLM（OpenAI 兼容；主备两路） */
  llm: {
    primary: {
      baseUrl: env("LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
      apiKey: env("LLM_API_KEY") || env("DASHSCOPE_API_KEY") || env("QWEN_API_KEY"),
      fastModel: env("LLM_FAST_MODEL", "qwen-flash"),
      strongModel: env("LLM_STRONG_MODEL", "qwen-plus"),
    },
    fallback: {
      baseUrl: env("LLM_FALLBACK_BASE_URL", "https://api.deepseek.com/v1"),
      apiKey: env("LLM_FALLBACK_API_KEY"),
      fastModel: env("LLM_FALLBACK_FAST_MODEL", "deepseek-chat"),
      strongModel: env("LLM_FALLBACK_STRONG_MODEL", "deepseek-chat"),
    },
    timeoutMs: envInt("LLM_TIMEOUT_MS", 30000),
    enabled: envFlag("LLM_ENABLED", true),
  },

  /** 附件限制 */
  upload: {
    maxBytes: envInt("UPLOAD_MAX_BYTES", 20 * 1024 * 1024),
  },

  devMode: envFlag("DEV_MODE", false),
} as const;

export function ensureDirs(): void {
  for (const d of [CONFIG.dataDir, CONFIG.uploadsDir, path.join(CONFIG.dataDir, "workbench")]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** 启动自检：关键配置缺失时给出明确报错（部署指南对应章节）。 */
export function validateConfig(): string[] {
  const problems: string[] = [];
  if (!CONFIG.sessionSecret || CONFIG.sessionSecret.length < 16) {
    problems.push("SESSION_SECRET 未配置或过短（≥16 字符）");
  }
  if (!CONFIG.dingtalk.clientId || !CONFIG.dingtalk.clientSecret) {
    problems.push("DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET 未配置（钉钉免登与日报汇总都需要）");
  }
  if (!CONFIG.llm.primary.apiKey) {
    problems.push("LLM_API_KEY 未配置（AI 检查/自动归类/问答将走确定性兜底规则）");
  }
  if (CONFIG.rdDepartmentDigest.enabled && CONFIG.rdDepartmentDigest.recipientUserIds.length === 0) {
    problems.push("DAILY_REPORT_RD_DIGEST_ENABLED=1 时必须配置正式收件人 userid 列表");
  }
  if (CONFIG.assistant.enabled && !CONFIG.assistant.contextEncryptionKey) {
    problems.push("DAILY_ASSISTANT_ENABLED=1 时必须配置 DAILY_ASSISTANT_CONTEXT_KEY");
  }
  if (CONFIG.assistant.enabled && CONFIG.assistant.reminderEnabled && !CONFIG.dingtalk.agentId) {
    problems.push("DAILY_ASSISTANT_REMINDER_ENABLED=1 时必须配置 DINGTALK_AGENT_ID");
  }
  if (CONFIG.assistant.agentV2Enabled && CONFIG.assistant.agentV2Userids.length === 0) {
    problems.push("DAILY_ASSISTANT_AGENT_V2_ENABLED=1 时尚未配置 DAILY_ASSISTANT_AGENT_V2_USERIDS（V2 按 userid 灰度）");
  }
  if (CONFIG.assistant.agentV2Enabled) {
    for (const [label, model] of [["DAILY_ASSISTANT_PRIMARY_MODEL", CONFIG.assistant.primaryModel], ["DAILY_ASSISTANT_BACKUP_MODEL", CONFIG.assistant.backupModel]] as const) {
      if (!model || model.endsWith("-latest") || ["qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.7-flash", "qwen-plus", "deepseek-chat"].includes(model)) {
        problems.push(`${label} 必须配置经过 bake-off 的具体日期快照`);
      }
    }
  }
  if (CONFIG.assistant.eventFusionEnabled) {
    if (CONFIG.assistant.eventFusionPilotUserids.length === 0) {
      problems.push("DAILY_ASSISTANT_EVENT_FUSION_ENABLED=1 时尚未配置 DAILY_ASSISTANT_EVENT_FUSION_PILOT_USERIDS（事件链路按 userid 灰度）");
    }
    if (!CONFIG.llm.primary.apiKey) {
      problems.push("DAILY_ASSISTANT_EVENT_FUSION_ENABLED=1 时必须配置真实 LLM_API_KEY");
    }
    for (const [label, model] of [
      ["DAILY_ASSISTANT_EVENT_PRIMARY_MODEL", CONFIG.assistant.eventPrimaryModel],
      ["DAILY_ASSISTANT_EVENT_BACKUP_MODEL", CONFIG.assistant.eventBackupModel],
    ] as const) {
      if (!/-\d{4}-\d{2}-\d{2}$/.test(model) || model.endsWith("-latest")) {
        problems.push(`${label} 必须配置经过 bake-off 的具体日期快照`);
      }
    }
  }
  if (CONFIG.assistant.workDiscoveryEnabled) {
    if (CONFIG.assistant.workDiscoveryPilotUserids.length === 0) {
      problems.push("DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED=1 时尚未配置 DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS（工作发现按 userid 灰度）");
    }
    if (!CONFIG.llm.enabled || !CONFIG.llm.primary.apiKey) {
      problems.push("DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED=1 时必须启用 LLM 并配置真实 LLM_API_KEY");
    }
  }
  return problems;
}
