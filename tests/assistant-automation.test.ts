import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { DailyAssistantAutomation, prepareScheduledAssistant, type ReminderTarget } from "../src/assistant/automation-service";
import { ConversationEngine } from "../src/assistant/conversation-engine";
import type { ContextJobView } from "../src/assistant/context-jobs";
import { classifyEmployeeDayStatus, WorkStatusService, type EmployeeDayStatus } from "../src/assistant/work-status-service";
import type { CollectedEvidence } from "../src/assistant/schema";
import { addUser, createMigratedFixtureDb } from "./helpers";

function evidence(title: string, summary: string): CollectedEvidence {
  return {
    sourceType: "attendance",
    externalId: `${title}:${summary}`,
    title,
    summary,
    occurredAt: "2026-08-25T01:00:00.000Z",
    actorUserIds: [],
    actorNames: [],
    participantNames: [],
    privacyScope: "employee_only",
    projectSignals: [],
    evidenceStrength: "weak",
  };
}

test("全天、部分请假、出差和外出被确定性区分", () => {
  assert.equal(classifyEmployeeDayStatus([evidence("请假", "全天请假 1天")]), "full_leave");
  assert.equal(classifyEmployeeDayStatus([evidence("请假", "下午请假 4小时")]), "partial_leave");
  assert.equal(classifyEmployeeDayStatus([evidence("出差", "已通过")]), "business_trip");
  assert.equal(classifyEmployeeDayStatus([evidence("外出", "客户现场")]), "outing");
  assert.equal(classifyEmployeeDayStatus([]), "normal");
});

test("17:30 自动分析、17:30 当日提醒和次工作日漏交提醒均幂等并遵守请假规则", async () => {
  const db = createMigratedFixtureDb();
  const specs: Array<[string, EmployeeDayStatus, boolean]> = [
    ["正常员工", "normal", true],
    ["全天请假", "full_leave", true],
    ["部分请假", "partial_leave", true],
    ["出差员工", "business_trip", true],
    ["授权失效", "normal", false],
    ["已提交员工", "normal", true],
  ];
  const ids = new Map<string, number>();
  for (const [index, spec] of specs.entries()) {
    const id = addUser(db, { name: spec[0], role: "emp", dept: "研发部" });
    db.prepare("UPDATE users SET dd_userid = ? WHERE id = ?").run(`pilot-${index}`, id);
    ids.set(spec[0], id);
  }
  db.prepare(
    `INSERT INTO logs (user_id, date, status, quality, submitted_at, updated_at, total_hours, current_version)
     VALUES (?, '2026-08-25', 'submitted', 'normal', '2026-08-25T10:00:00Z', '2026-08-25T10:00:00Z', 0, 1)`,
  ).run(ids.get("已提交员工")!);
  const statusService = new WorkStatusService(db);
  const statusByName = new Map(specs.map((spec) => [spec[0], { status: spec[1], dwsValid: spec[2] }]));
  const started: string[] = [];
  const deliveries: Array<{ kind: string; date: string; targets: ReminderTarget[] }> = [];
  const automation = new DailyAssistantAutomation(
    db,
    {
      refreshStatus: async (user: SessionUser, date: string) => {
        const result = statusByName.get(user.name)!;
        statusService.save(user.id, date, result.status);
        return result;
      },
      startContext: (user) => { started.push(user.name); },
      sendReminder: async (kind, date, targets) => { deliveries.push({ kind, date, targets }); },
      workdayCheck: () => true,
      previousWorkday: () => "2026-08-24",
    },
    {
      pilotUserids: specs.map((_, index) => `pilot-${index}`),
      prewarmEnabled: true,
      reminderEnabled: true,
    },
  );

  await automation.runPrewarm("2026-08-25");
  await automation.runPrewarm("2026-08-25");
  assert.deepEqual(started, ["正常员工", "部分请假", "出差员工"]);
  const runs = db.prepare("SELECT status, COUNT(*) AS value FROM assistant_schedule_runs GROUP BY status ORDER BY status").all() as unknown as Array<{
    status: string;
    value: number;
  }>;
  assert.deepEqual(runs.map((row) => ({ ...row })), [
    { status: "complete", value: 3 },
    { status: "skipped_dws_invalid", value: 1 },
    { status: "skipped_full_leave", value: 1 },
  ]);

  await automation.runTodayReminder("2026-08-25");
  await automation.runTodayReminder("2026-08-25");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, "today");
  assert.deepEqual(deliveries[0].targets.map((target) => target.user.name), ["正常员工", "部分请假", "出差员工", "授权失效"]);
  assert.deepEqual(deliveries[0].targets.map((target) => target.status), ["normal", "partial_leave", "business_trip", "normal"]);

  await automation.runOverdueReminder("2026-08-25");
  await automation.runOverdueReminder("2026-08-25");
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].kind, "overdue");
  assert.equal(deliveries[1].date, "2026-08-24");
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM assistant_notification_log WHERE status = 'sent'").get()!.value, 9);
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM assistant_notification_log WHERE status = 'skipped_full_leave'").get()!.value, 2);
  db.close();
});

test("非工作日截止前不运行分析，提醒仍遵守工作日", async () => {
  const db = createMigratedFixtureDb();
  let calls = 0;
  const automation = new DailyAssistantAutomation(
    db,
    {
      refreshStatus: async () => ({ status: "normal", dwsValid: true }),
      startContext: () => { calls += 1; },
      sendReminder: async () => { calls += 1; },
      workdayCheck: () => false,
      previousWorkday: (date) => date,
    },
    { pilotUserids: [], prewarmEnabled: true, reminderEnabled: true },
  );
  await automation.runAt(new Date("2026-08-23T09:30:00+08:00"));
  assert.equal(calls, 0);
  db.close();
});

test("每天北京时间17:30触发，覆盖名单外员工，跨轮询及重启不重复", async () => {
  const db = createMigratedFixtureDb();
  const id = addUser(db, { name: "已开放的普通员工", role: "emp", dept: "研发部" });
  db.prepare("UPDATE users SET dd_userid = 'non-pilot' WHERE id = ?").run(id);
  const started: string[] = [];
  const deps = {
    refreshStatus: async () => ({ status: "normal" as const, dwsValid: true }),
    startContext: async (_user: SessionUser, date: string) => { started.push(date); },
    sendReminder: async () => { assert.fail("非工作日不得发送提醒"); },
    workdayCheck: () => false,
    previousWorkday: (date: string) => date,
  };
  const options = { pilotUserids: [], prewarmEnabled: true, reminderEnabled: true };
  const automation = new DailyAssistantAutomation(db, deps, options);
  await automation.runAt(new Date("2026-09-06T09:29:59Z"));
  assert.deepEqual(started, []);
  await automation.runAt(new Date("2026-09-06T09:30:00Z"));
  await automation.runAt(new Date("2026-09-06T09:31:00Z"));
  await new DailyAssistantAutomation(db, deps, options).runAt(new Date("2026-09-06T10:00:00Z"));
  assert.deepEqual(started, ["2026-09-06"]);
  await automation.runAt(new Date("2026-09-07T09:30:00Z"));
  assert.deepEqual(started, ["2026-09-06", "2026-09-07"]);
  db.close();
});

test("等待分析完成后才记成功，慢任务不重入，单人失败可重试且不阻塞其他人", async () => {
  const db = createMigratedFixtureDb();
  const slowId = addUser(db, { name: "慢任务", role: "emp", dept: "研发部" });
  const failedId = addUser(db, { name: "短暂失败", role: "emp", dept: "研发部" });
  db.prepare("UPDATE users SET dd_userid = 'slow' WHERE id = ?").run(slowId);
  db.prepare("UPDATE users SET dd_userid = 'retry' WHERE id = ?").run(failedId);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const attempts = new Map<number, number>();
  const automation = new DailyAssistantAutomation(db, {
    refreshStatus: async () => ({ status: "normal", dwsValid: true }),
    startContext: async (user) => {
      const attempt = (attempts.get(user.id) ?? 0) + 1;
      attempts.set(user.id, attempt);
      if (user.id === slowId) await pending;
      if (user.id === failedId && attempt === 1) throw new Error("temporary failure");
    },
    sendReminder: async () => {}, workdayCheck: () => true, previousWorkday: (date) => date,
  }, { pilotUserids: [], prewarmEnabled: true, reminderEnabled: false });
  const running = automation.runPrewarm("2026-09-07");
  await new Promise((resolve) => setImmediate(resolve));
  await automation.runPrewarm("2026-09-07");
  assert.equal(attempts.get(slowId), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_schedule_runs").get()!.n, 0);
  release();
  await running;
  await automation.runPrewarm("2026-09-07");
  assert.equal(attempts.get(slowId), 1);
  assert.equal(attempts.get(failedId), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_schedule_runs WHERE status = 'complete'").get()!.n, 2);
  db.close();
});

test("自动准备刷新截止前的缓存，等待采集和分析并持久化会话", async () => {
  const db = createMigratedFixtureDb();
  const id = addUser(db, { name: "自动分析员工", role: "emp", dept: "研发部" });
  const user: SessionUser = { id, name: "自动分析员工", role: "emp", dept: "研发部", title: "", kind: "dingtalk", ddUserid: "self", isExternal: false, mustChangePw: false };
  let job: ContextJobView = {
    id: "morning-job", userId: id, workDate: "2026-09-07", status: "complete", completeness: "complete",
    refreshCount: 0, createdAt: "2026-09-07T02:00:00Z", updatedAt: "2026-09-07T02:10:00Z", expiresAt: "2026-09-08T06:00:00Z", sources: [],
  };
  const stages: string[] = [];
  const engine = new ConversationEngine(db);
  await prepareScheduledAssistant({
    orchestrator: {
      get: () => job,
      start: (_user, date, refresh) => {
        assert.equal(date, "2026-09-07");
        assert.equal(refresh, true, "上午缓存不能代替完整统计窗口");
        stages.push("collect");
        job = { ...job, id: "cutoff-job", status: "running", createdAt: "2026-09-07T09:30:00Z" };
        return job;
      },
      waitForIdle: async (jobId) => {
        if (jobId === "cutoff-job") { stages.push("collected"); job = { ...job, status: "complete" }; }
      },
    },
    candidateService: {
      build: async (_user, jobId) => {
        assert.equal(job.status, "complete");
        assert.equal(jobId, "cutoff-job");
        stages.push("analyze");
        return { candidates: [], analysisMode: "deterministic" };
      },
    },
    conversationEngine: engine,
  }, user, "2026-09-07");
  assert.deepEqual(stages, ["collect", "collected", "analyze"]);
  const session = db.prepare("SELECT context_job_id, analysis_mode, status FROM assistant_sessions WHERE user_id = ?").get(id)!;
  assert.equal(session.context_job_id, "cutoff-job");
  assert.equal(session.analysis_mode, "deterministic");
  assert.equal(session.status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM logs").get()!.n, 0);
  db.close();
});
