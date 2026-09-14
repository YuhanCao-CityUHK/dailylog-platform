import type { DatabaseSync } from "node:sqlite";
import { canUsePersonalLogs, type SessionUser } from "../auth/types";
import { sendWorkNotice } from "../auth/dingtalk";
import { CONFIG } from "../infra/config";
import { logStructured } from "../infra/logger";
import { isWorkday, prevWorkday } from "../infra/workcal";
import { getDb, nowIso } from "../infra/db";
import { getAssistantRuntime } from "./runtime";
import type { EmployeeDayStatus, RefreshedDayStatus } from "./work-status-service";
import { mapSettledWithConcurrency } from "./bounded-parallel";
import { modeFromCompleteness } from "./conversation-schema";
import { assistantReportingWindow } from "./reporting-window";

interface AutomationUser extends SessionUser {
  exemptReminder: boolean;
}

export interface ReminderTarget {
  user: AutomationUser;
  status: EmployeeDayStatus;
}

export interface AssistantAutomationDependencies {
  refreshStatus: (user: SessionUser, workDate: string) => Promise<RefreshedDayStatus>;
  startContext: (user: SessionUser, workDate: string) => void | Promise<void>;
  sendReminder: (kind: "today" | "overdue", workDate: string, targets: ReminderTarget[]) => Promise<void>;
  workdayCheck: (workDate: string) => boolean;
  previousWorkday: (workDate: string) => string;
}

export interface AssistantAutomationOptions {
  pilotUserids: readonly string[];
  prewarmEnabled: boolean;
  reminderEnabled: boolean;
}

function after(hour: number, minute: number, expectedHour: number, expectedMinute: number): boolean {
  return hour > expectedHour || (hour === expectedHour && minute >= expectedMinute);
}

function shanghaiClock(now: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), minute: Number(get("minute")) };
}

async function defaultReminderSender(kind: "today" | "overdue", workDate: string, targets: ReminderTarget[]): Promise<void> {
  if (!CONFIG.dingtalk.agentId) throw new Error("DINGTALK_AGENT_ID 未配置");
  const groups = new Map<EmployeeDayStatus, ReminderTarget[]>();
  for (const target of targets) {
    const list = groups.get(target.status) ?? [];
    list.push(target);
    groups.set(target.status, list);
  }
  for (const [status, members] of groups) {
    const background = status === "partial_leave"
      ? "系统看到你当天有部分请假，请按实际工作情况简要填写即可。"
      : status === "business_trip"
        ? "系统看到你当天处于出差状态，请记录实际推进的工作。"
        : status === "outing"
          ? "系统看到你当天有外出安排，请记录实际完成的工作。"
          : "";
    const today = kind === "today";
    const title = today ? "今日日报提醒" : "工作日志漏交提醒";
    const action = today ? "完成并提交今日日报" : `前往“我的日志”补填 ${workDate} 的日报`;
    const url = `${CONFIG.publicBaseUrl}/${today ? "#assistant" : "#mylogs"}`;
    await sendWorkNotice(
      members.map((member) => member.user.ddUserid!),
      title,
      `### ${title}\n\n请${action}。${background ? `\n\n> ${background}` : ""}\n\n[打开日志平台](${url})`,
    );
  }
}

export class DailyAssistantAutomation {
  private prewarmRunning = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: AssistantAutomationDependencies,
    private readonly options: AssistantAutomationOptions,
  ) {}

  async runAt(now = new Date()): Promise<void> {
    const clock = shanghaiClock(now);
    if (
      this.options.reminderEnabled &&
      after(clock.hour, clock.minute, CONFIG.assistant.overdueReminderHour, CONFIG.assistant.overdueReminderMinute) &&
      clock.hour < CONFIG.assistant.prewarmHour
    ) {
      await this.runOverdueReminder(clock.date);
    }
    if (
      this.options.prewarmEnabled &&
      after(clock.hour, clock.minute, CONFIG.assistant.prewarmHour, CONFIG.assistant.prewarmMinute)
    ) {
      await this.runPrewarm(clock.date);
    }
    if (
      this.options.reminderEnabled &&
      after(clock.hour, clock.minute, CONFIG.assistant.todayReminderHour, CONFIG.assistant.todayReminderMinute)
    ) {
      await this.runTodayReminder(clock.date);
    }
  }

  async runPrewarm(workDate: string): Promise<void> {
    if (this.prewarmRunning) return;
    this.prewarmRunning = true;
    try {
      const submitted = this.submittedUsers(workDate);
      const users = this.eligibleUsers(false).filter((user) => (
        !submitted.has(user.id) && !this.hasScheduleRun("prewarm", workDate, user.id)
      ));
      await mapSettledWithConcurrency(users, CONFIG.assistant.globalConcurrency, async (user) => {
        try {
          const refreshed = await this.deps.refreshStatus(user, workDate);
          if (refreshed.status === "full_leave") {
            this.recordScheduleRun("prewarm", workDate, user.id, "skipped_full_leave");
          } else if (!refreshed.dwsValid) {
            this.recordScheduleRun("prewarm", workDate, user.id, "skipped_dws_invalid");
          } else {
            await this.deps.startContext(user, workDate);
            this.recordScheduleRun("prewarm", workDate, user.id, "complete");
            logStructured({ evt: "assistant_scheduled_analysis_complete", userId: user.id, workDate });
          }
        } catch (error) {
          // 未完成的员工留待下次轮询重试，单人失败不阻塞其他员工。
          logStructured({ evt: "assistant_scheduled_analysis_failed", userId: user.id, workDate, error: String(error) });
        }
      });
    } finally {
      this.prewarmRunning = false;
    }
  }

  async runTodayReminder(workDate: string): Promise<void> {
    if (!this.deps.workdayCheck(workDate)) return;
    await this.remind("today", workDate, this.eligibleUsers(true));
  }

  async runOverdueReminder(currentWorkDate: string): Promise<void> {
    if (!this.deps.workdayCheck(currentWorkDate)) return;
    const targetDate = this.deps.previousWorkday(currentWorkDate);
    await this.remind("overdue", targetDate, this.eligibleUsers(true));
  }

  private async remind(kind: "today" | "overdue", workDate: string, users: AutomationUser[]): Promise<void> {
    const submitted = this.submittedUsers(workDate);
    const targets: ReminderTarget[] = [];
    for (const user of users) {
      if (submitted.has(user.id) || this.hasNotification(kind, workDate, user.id)) continue;
      const cached = this.cachedStatus(user.id, workDate);
      const status = cached ?? (await this.deps.refreshStatus(user, workDate)).status;
      if (status === "full_leave") {
        this.recordNotification(kind, workDate, user.id, "skipped_full_leave");
        continue;
      }
      targets.push({ user, status });
    }
    if (!targets.length) return;
    await this.deps.sendReminder(kind, workDate, targets);
    for (const target of targets) this.recordNotification(kind, workDate, target.user.id, "sent");
  }

  private eligibleUsers(remindersOnly: boolean): AutomationUser[] {
    const pilots = new Set(this.options.pilotUserids);
    return (this.db
      .prepare(
        `SELECT id, kind, dd_userid, login_name, name, title, dept, role, is_external,
                must_change_pw, exempt_reminder
           FROM users
          WHERE active = 1 AND should_submit = 1 AND kind = 'dingtalk'
            AND is_external = 0 AND dd_userid IS NOT NULL`,
      )
      .all() as unknown as Array<Record<string, unknown>>)
      .filter((row) => !remindersOnly || (pilots.has(String(row.dd_userid)) && Number(row.exempt_reminder) !== 1))
      .map((row) => ({
        id: Number(row.id),
        kind: "dingtalk" as const,
        ddUserid: String(row.dd_userid),
        loginName: row.login_name ? String(row.login_name) : undefined,
        name: String(row.name),
        title: String(row.title ?? ""),
        dept: String(row.dept ?? ""),
        role: row.role as SessionUser["role"],
        isExternal: false,
        mustChangePw: Number(row.must_change_pw) === 1,
        exemptReminder: Number(row.exempt_reminder) === 1,
      })).filter((user) => remindersOnly || canUsePersonalLogs(user));
  }

  private submittedUsers(workDate: string): Set<number> {
    return new Set(
      (this.db.prepare("SELECT user_id FROM logs WHERE date = ? AND status = 'submitted'").all(workDate) as unknown as Array<{ user_id: number }>).map(
        (row) => row.user_id,
      ),
    );
  }

  private cachedStatus(userId: number, workDate: string): EmployeeDayStatus | null {
    const row = this.db
      .prepare("SELECT status FROM employee_day_status WHERE user_id = ? AND work_date = ?")
      .get(userId, workDate) as { status: EmployeeDayStatus } | undefined;
    return row?.status ?? null;
  }

  private hasScheduleRun(kind: string, workDate: string, userId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS value FROM assistant_schedule_runs WHERE kind = ? AND work_date = ? AND user_id = ?").get(kind, workDate, userId));
  }

  private recordScheduleRun(kind: string, workDate: string, userId: number, status: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO assistant_schedule_runs (kind, work_date, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(kind, workDate, userId, status, nowIso());
  }

  private hasNotification(kind: "today" | "overdue", workDate: string, userId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS value FROM assistant_notification_log WHERE kind = ? AND work_date = ? AND user_id = ?").get(kind, workDate, userId));
  }

  private recordNotification(kind: "today" | "overdue", workDate: string, userId: number, status: "sent" | "skipped_full_leave"): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO assistant_notification_log (kind, work_date, user_id, status, sent_at) VALUES (?, ?, ?, ?, ?)",
    ).run(kind, workDate, userId, status, nowIso());
  }
}

export function createDailyAssistantAutomation(): DailyAssistantAutomation {
  const db = getDb();
  const runtime = getAssistantRuntime();
  return new DailyAssistantAutomation(
    db,
    {
      refreshStatus: (user, workDate) => runtime.workStatusService.refresh(user, workDate),
      startContext: (user, workDate) => prepareScheduledAssistant(runtime, user, workDate),
      sendReminder: defaultReminderSender,
      workdayCheck: isWorkday,
      previousWorkday: prevWorkday,
    },
    {
      pilotUserids: CONFIG.assistant.pilotUserids,
      prewarmEnabled: CONFIG.assistant.prewarmEnabled,
      reminderEnabled: CONFIG.assistant.reminderEnabled,
    },
  );
}

export function startDailyAssistantAutomation(): void {
  if (!CONFIG.assistant.enabled || (!CONFIG.assistant.prewarmEnabled && !CONFIG.assistant.reminderEnabled)) {
    logStructured({ evt: "assistant_automation_disabled" });
    return;
  }
  try {
    const automation = createDailyAssistantAutomation();
    const run = () => automation.runAt().catch((error) => logStructured({ evt: "assistant_automation_failed", error: String(error) }));
    void run();
    const timer = setInterval(() => { void run(); }, 60_000);
    timer.unref();
    logStructured({ evt: "assistant_automation_started", prewarmEnabled: CONFIG.assistant.prewarmEnabled,
      schedule: `${CONFIG.assistant.prewarmHour}:${String(CONFIG.assistant.prewarmMinute).padStart(2, "0")}`,
      timeZone: "Asia/Shanghai", days: "every_day", window: "previous_day_17:30_to_today_17:30" });
  } catch (error) {
    logStructured({ evt: "assistant_automation_disabled", error: String(error) });
  }
}

/** 自动准备同时完成采集、模型分析及候选保存，页面打开时可以直接使用。 */
export async function prepareScheduledAssistant(
  runtime: {
    orchestrator: Pick<ReturnType<typeof getAssistantRuntime>["orchestrator"], "get" | "start" | "waitForIdle">;
    candidateService: Pick<ReturnType<typeof getAssistantRuntime>["candidateService"], "build">;
    conversationEngine: Pick<ReturnType<typeof getAssistantRuntime>["conversationEngine"], "ensureSession">;
  },
  user: SessionUser,
  workDate: string,
): Promise<void> {
  const existing = runtime.orchestrator.get(user.id, workDate);
  if (existing) await runtime.orchestrator.waitForIdle(existing.id);
  const cutoff = Date.parse(assistantReportingWindow(workDate).end);
  const refresh = Boolean(existing && (Date.parse(existing.createdAt) < cutoff || existing.status === "failed"));
  const job = runtime.orchestrator.start(user, workDate, refresh);
  await runtime.orchestrator.waitForIdle(job.id);
  const ready = runtime.orchestrator.get(user.id, workDate);
  if (!ready || ready.id !== job.id || ["queued", "running", "failed"].includes(ready.status)) {
    throw new Error("scheduled_context_not_ready");
  }
  const build = await runtime.candidateService.build(user, job.id, workDate);
  runtime.conversationEngine.ensureSession(
    user.id, workDate, modeFromCompleteness(ready.completeness), job.id, build.candidates, build.analysisMode,
  );
}
