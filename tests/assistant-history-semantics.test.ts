import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { LegacyCandidateService } from "../src/assistant/candidate-service";
import { createContextDatabase } from "../src/assistant/context-db";
import { ContextJobStore } from "../src/assistant/context-jobs";
import { EvidenceStore } from "../src/assistant/evidence-store";
import type { CollectedEvidence, CollectorInput } from "../src/assistant/schema";
import { ConversationEngine } from "../src/assistant/conversation-engine";
import { dingtalkReportCollector } from "../src/dws/collectors/dingtalk-report-collector";
import { addUser, createMigratedFixtureDb } from "./helpers";

interface Fixture {
  workDate: string;
  historyWorkDates: string[];
  completedHistory: Array<Record<string, unknown>>;
  previousPlanReport: Record<string, unknown>;
  todayDocument: CollectedEvidence;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/daily-assistant-history-regression.json", import.meta.url), "utf8"),
) as Fixture;

function setup() {
  const platformDb = createMigratedFixtureDb();
  const userId = addUser(platformDb, { name: "测试员工", dept: "研发部" });
  const user: SessionUser = {
    id: userId,
    kind: "dingtalk",
    ddUserid: "employee-1",
    name: "测试员工",
    title: "",
    dept: "研发部",
    role: "emp",
    isExternal: false,
    mustChangePw: false,
  };
  const contextDb = createContextDatabase(":memory:");
  const job = new ContextJobStore(contextDb).createOrReuse(userId, fixture.workDate, 12, false, new Date("2026-08-25T01:00:00Z")).job;
  const store = new EvidenceStore(contextDb, Buffer.alloc(32, 8));
  return { platformDb, contextDb, user, job, store };
}

async function collectReports(rows: Array<Record<string, unknown>>): Promise<CollectedEvidence[]> {
  const input: CollectorInput = {
    platformUserId: 1,
    ddUserid: "employee-1",
    profile: "fixture:employee-1",
    workDate: fixture.workDate,
    historyWorkDates: fixture.historyWorkDates,
    now: new Date("2026-08-25T04:00:00Z"),
    run: async () => ({ result: rows }),
  };
  return (await dingtalkReportCollector.collect(input)).evidences;
}

function storeAll(runtime: ReturnType<typeof setup>, evidences: CollectedEvidence[]): void {
  for (const evidence of evidences) {
    runtime.store.put(runtime.job.id, runtime.user.id, fixture.workDate, evidence, "2026-08-25T20:00:00.000Z", new Date("2026-08-25T02:00:00Z"));
  }
}

test("五篇历史已完成日报且没有今日证据时生成 0 个今日事项", async () => {
  const runtime = setup();
  storeAll(runtime, await collectReports(fixture.completedHistory));
  const result = await new LegacyCandidateService(runtime.store, runtime.platformDb).build(
    runtime.user, runtime.job.id, fixture.workDate, new Date("2026-08-25T03:00:00Z"),
  );
  assert.equal(result.candidates.length, 0);
  runtime.contextDb.close();
  runtime.platformDb.close();
});

test("昨日明日计划只生成 continuation，历史结果和模板名不进入候选", async () => {
  const runtime = setup();
  storeAll(runtime, await collectReports([fixture.previousPlanReport]));
  const { candidates } = await new LegacyCandidateService(runtime.store, runtime.platformDb).build(
    runtime.user, runtime.job.id, fixture.workDate, new Date("2026-08-25T03:00:00Z"),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].origin, "continuation");
  assert.equal(candidates[0].resultHint, "");
  assert.equal(candidates[0].workSummary, "推进日报助手项目匹配和提交链路验证");
  assert.doesNotMatch(candidates[0].workSummary, /总经办日志|工作日报|历史日志/);
  assert.doesNotMatch(JSON.stringify(candidates), /历史页面可用|历史完成正文/);
  const reference = runtime.store.get(candidates[0].referenceIds[0], runtime.user.id, new Date("2026-08-25T03:00:00Z"));
  assert.match(reference?.summary ?? "", /历史页面可用|历史完成正文/);

  const session = new ConversationEngine(runtime.platformDb).ensureSession(
    runtime.user.id, fixture.workDate, "complete", runtime.job.id, candidates, "deterministic",
  );
  assert.equal(session.items[0].resultText, "");
  assert.equal(session.items[0].origin, "continuation");
  assert.match(session.items[0].needsConfirmation.join(","), /today/);
  runtime.contextDb.close();
  runtime.platformDb.close();
});

test("昨日计划与今日文档指向同一目标时合并为一项，并只采用今日进展", async () => {
  const runtime = setup();
  storeAll(runtime, [...await collectReports([fixture.previousPlanReport]), fixture.todayDocument]);
  const { candidates } = await new LegacyCandidateService(runtime.store, runtime.platformDb).build(
    runtime.user, runtime.job.id, fixture.workDate, new Date("2026-08-25T03:00:00Z"),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].origin, "today");
  assert.equal(candidates[0].referenceIds.length, 2);
  assert.match(candidates[0].resultHint, /已定位项目匹配失败原因/);
  assert.doesNotMatch(candidates[0].resultHint, /历史页面可用|历史完成正文/);
  runtime.contextDb.close();
  runtime.platformDb.close();
});
