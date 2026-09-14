/** 未提交提醒：每个工作日 9:00 检查前一工作日提交情况，钉钉工作通知一次（PRD 13 / 规格 §9.6）。 */
import { getDb } from "../infra/db";
import { CONFIG } from "../infra/config";
import { logStructured } from "../infra/logger";
import { isWorkday, prevWorkday, todayYmd } from "../infra/workcal";
import { sendWorkNotice } from "../auth/dingtalk";

function nowInShanghai(): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  return {
    hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0),
    minute: Number(parts.find((p) => p.type === "minute")?.value ?? 0),
  };
}

async function runOnce(): Promise<void> {
  const today = todayYmd();
  if (!isWorkday(today)) return;
  const { hour, minute } = nowInShanghai();
  if (hour < CONFIG.reminder.hour || (hour === CONFIG.reminder.hour && minute < CONFIG.reminder.minute)) return;
  const target = prevWorkday(today);
  const db = getDb();
  const users = db
    .prepare(
      `SELECT id, dd_userid, name FROM users
       WHERE active = 1 AND should_submit = 1 AND exempt_reminder = 0 AND kind = 'dingtalk' AND dd_userid IS NOT NULL`,
    )
    .all() as unknown as Array<{ id: number; dd_userid: string; name: string }>;
  const submitted = new Set(
    (
      db
        .prepare("SELECT user_id FROM logs WHERE date = ? AND status = 'submitted'")
        .all(target) as unknown as Array<{ user_id: number }>
    ).map((r) => r.user_id),
  );
  const already = new Set(
    (
      db.prepare("SELECT user_id FROM reminder_log WHERE date = ?").all(target) as unknown as Array<{
        user_id: number;
      }>
    ).map((r) => r.user_id),
  );
  const targets = users.filter((u) => !submitted.has(u.id) && !already.has(u.id));
  if (targets.length === 0) return;
  const url = `${CONFIG.publicBaseUrl}/#fill`;
  try {
    await sendWorkNotice(
      targets.map((t) => t.dd_userid),
      "工作日志提醒",
      `### 工作日志提醒\n\n你 **${target}** 的工作日志尚未提交，请到日志平台补填。\n\n[打开日志平台](${url})\n\n> 本提醒每个工作日仅发送一次。`,
    );
    const stamp = new Date().toISOString();
    const ins = db.prepare("INSERT OR IGNORE INTO reminder_log (date, user_id, sent_at) VALUES (?, ?, ?)");
    for (const t of targets) ins.run(target, t.id, stamp);
    logStructured({ evt: "reminder_sent", date: target, count: targets.length });
  } catch (err) {
    logStructured({ evt: "reminder_failed", error: String(err) });
  }
}

export function startReminderScheduler(): void {
  if (CONFIG.assistant.enabled && CONFIG.assistant.reminderEnabled) {
    logStructured({ evt: "legacy_reminder_replaced_by_daily_assistant" });
    return;
  }
  if (!CONFIG.reminder.enabled) {
    logStructured({ evt: "reminder_disabled" });
    return;
  }
  setInterval(() => {
    void runOnce();
  }, 60_000);
  logStructured({ evt: "reminder_scheduler_started", hour: CONFIG.reminder.hour });
}
