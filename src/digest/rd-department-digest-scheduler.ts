import { fetchDdUserDetail, sendRobotActionCard } from "../auth/dingtalk";
import { CONFIG } from "../infra/config";
import { getDb } from "../infra/db";
import { logStructured } from "../infra/logger";
import { getLocalTimeParts } from "../infra/reminder-policy";
import { loadDailyReportDigestConfig } from "./daily-report-config";
import {
  buildRdDepartmentDigest,
  renderRdDepartmentDigestMarkdown,
  type RdDepartmentDigestData,
} from "./rd-department-digest";
import { resolveDayRangeForYmd, resolveReportRange } from "./daily-report-window";

const TIMEZONE = "Asia/Shanghai";
const SEND_WINDOW_MINUTES = 5;

export function isRdDepartmentDigestSendWindow(
  now: Date,
  sendHour = CONFIG.rdDepartmentDigest.sendHour,
  sendMinute = CONFIG.rdDepartmentDigest.sendMinute,
): boolean {
  const { hour, minute } = getLocalTimeParts(now, TIMEZONE);
  return hour === sendHour && minute >= sendMinute && minute < sendMinute + SEND_WINDOW_MINUTES;
}

function hasSent(dateYmd: string, recipientUserId: string): boolean {
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1 FROM rd_department_digest_state
         WHERE date_ymd = ? AND recipient_userid = ?`,
      )
      .get(dateYmd, recipientUserId),
  );
}

function markSent(dateYmd: string, recipientUserId: string, robotMessageKey: string): void {
  getDb()
    .prepare(
      `INSERT INTO rd_department_digest_state
         (date_ymd, recipient_userid, sent_at, robot_message_key)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(date_ymd, recipient_userid) DO UPDATE SET
         sent_at = excluded.sent_at,
         robot_message_key = excluded.robot_message_key`,
    )
    .run(dateYmd, recipientUserId, new Date().toISOString(), robotMessageKey);
}

export function listPendingRdDigestRecipients(
  recipientUserIds: string[],
  wasSent: (userId: string) => boolean,
): string[] {
  return [...new Set(recipientUserIds.map((userId) => userId.trim()).filter(Boolean))].filter(
    (userId) => !wasSent(userId),
  );
}

async function sendDigest(params: {
  digest: RdDepartmentDigestData;
  recipientUserId: string;
  preview?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const rendered = renderRdDepartmentDigestMarkdown(params.digest, { preview: params.preview });
  return sendRobotActionCard(
    {
      userId: params.recipientUserId,
      title: params.preview ? `${rendered.title}（模拟）` : rendered.title,
      markdown: rendered.markdown,
      detailUrl: params.digest.detailUrl,
      singleTitle: "打开工作台 · 全部项目",
    },
    params.fetchImpl,
  );
}

export async function sendRdDepartmentDigestPreview(params: {
  recipientUserId: string;
  expectedRecipientName?: string;
  dateYmd?: string;
  now?: Date;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ digest: RdDepartmentDigestData; robotMessageKey: string }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const recipientUserId = params.recipientUserId.trim();
  const recipient = await fetchDdUserDetail(recipientUserId, fetchImpl);
  const expectedName = params.expectedRecipientName?.trim();
  if (expectedName && recipient.name !== expectedName) {
    throw new Error(`模拟收件人校验失败：期望 ${expectedName}，实际 ${recipient.name}`);
  }
  const { config, errors } = loadDailyReportDigestConfig();
  if (errors.length > 0) throw new Error(`日报配置错误：${errors.join("；")}`);
  const range = params.dateYmd
    ? resolveDayRangeForYmd(params.dateYmd, config.timezone, {
        cutoffHour: config.reportDayCutoffHour,
        cutoffMinute: config.reportDayCutoffMinute,
      })
    : resolveReportRange(params.now ?? new Date(), config.timezone, {
        cutoffHour: config.reportDayCutoffHour,
        cutoffMinute: config.reportDayCutoffMinute,
      });
  const digest = await buildRdDepartmentDigest(range, {
    fetchImpl,
    refresh: params.refresh ?? true,
  });
  const robotMessageKey = await sendDigest({
    digest,
    recipientUserId,
    preview: true,
    fetchImpl,
  });
  logStructured({
    evt: "rd_department_digest_preview_sent",
    dateYmd: digest.dateYmd,
    recipientUserId,
    recipientName: recipient.name,
    robotMessageKey,
  });
  return { digest, robotMessageKey };
}

export function createRdDepartmentDigestScheduler(deps?: { fetchImpl?: typeof fetch }) {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  let timer: NodeJS.Timeout | undefined;
  let sending = false;

  async function runOnce(now: Date = new Date()): Promise<void> {
    if (sending || !CONFIG.rdDepartmentDigest.enabled) return;
    const recipientUserIds = CONFIG.rdDepartmentDigest.recipientUserIds;
    if (recipientUserIds.length === 0 || !isRdDepartmentDigestSendWindow(now)) return;
    const { config, errors } = loadDailyReportDigestConfig();
    if (errors.length > 0) {
      logStructured({ evt: "rd_department_digest_config_invalid", errors });
      return;
    }
    const range = resolveReportRange(now, config.timezone, {
      cutoffHour: config.reportDayCutoffHour,
      cutoffMinute: config.reportDayCutoffMinute,
    });
    const pendingRecipientUserIds = listPendingRdDigestRecipients(
      recipientUserIds,
      (userId) => hasSent(range.labelYmd, userId),
    );
    if (pendingRecipientUserIds.length === 0) return;

    sending = true;
    try {
      const digest = await buildRdDepartmentDigest(range, { fetchImpl });
      for (const recipientUserId of pendingRecipientUserIds) {
        try {
          const robotMessageKey = await sendDigest({ digest, recipientUserId, fetchImpl });
          markSent(range.labelYmd, recipientUserId, robotMessageKey);
          logStructured({
            evt: "rd_department_digest_sent",
            dateYmd: range.labelYmd,
            recipientUserId,
            projectCount: digest.projects.length,
            submittedCount: digest.distinctSubmittedCount,
            missingCount: digest.missingNames.length,
            robotMessageKey,
          });
        } catch (error) {
          logStructured({
            evt: "rd_department_digest_send_failed",
            dateYmd: range.labelYmd,
            recipientUserId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logStructured({
        evt: "rd_department_digest_build_failed",
        dateYmd: range.labelYmd,
        recipientUserIds: pendingRecipientUserIds,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      sending = false;
    }
  }

  function start(): void {
    if (!CONFIG.rdDepartmentDigest.enabled || timer) return;
    void runOnce();
    timer = setInterval(() => void runOnce(), 60_000);
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  return { runOnce, start, stop };
}
