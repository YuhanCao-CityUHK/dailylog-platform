import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { createContextDatabase } from "../src/assistant/context-db";
import { ContextJobStore } from "../src/assistant/context-jobs";
import type { EvidenceWithReference } from "../src/assistant/evidence-store";
import type { CollectedEvidence, EvidenceSourceType } from "../src/assistant/schema";
import { EventExtractionService } from "../src/assistant/events/event-extraction-service";
import { EventFusionService } from "../src/assistant/events/event-fusion-service";
import { EventGenerationService } from "../src/assistant/events/event-generation-service";
import { validateGroundedEvents } from "../src/assistant/events/event-grounding-validator";
import { EventModelClient } from "../src/assistant/events/event-model-client";
import { EventModelUnavailableError, type EventModelProvider, type EventModelRequest, type EventModelResponse } from "../src/assistant/events/event-model-provider";
import { validateEventModelOutput } from "../src/assistant/events/event-output-validator";
import { EventRepository } from "../src/assistant/events/event-repository";
import type { EventModelOutput, WorkEvent } from "../src/assistant/events/event-types";
import { EVENT_FUSION_SYSTEM_PROMPT } from "../src/assistant/events/prompts/event-fusion-v1";

function evidence(
  id: string,
  sourceType: EvidenceSourceType = "document",
  patch: Partial<CollectedEvidence> = {},
): EvidenceWithReference {
  return {
    referenceId: id,
    jobId: "job-1",
    userId: 1,
    workDate: "2026-08-25",
    expiresAt: "2026-08-26T00:00:00.000Z",
    evidence: {
      sourceType,
      externalId: id,
      title: "日报助手方案评审",
      summary: "测试员工完成方案评审并形成风险清单",
      occurredAt: "2026-08-25T09:00:00+08:00",
      actorUserIds: ["user-1"],
      actorNames: ["测试员工"],
      participantNames: ["测试员工", "评审人"],
      privacyScope: "normal",
      projectSignals: ["日报助手"],
      evidenceStrength: "strong",
      relationToSelf: "self",
      senderKind: "user",
      temporalRole: "today",
      workUse: "direct_work",
      sourceCompleteness: "complete",
      resultEligible: true,
      ...patch,
    },
  };
}

function workEvent(patch: Partial<WorkEvent> = {}): WorkEvent {
  return {
    eventKey: "",
    title: "推进日报助手方案评审",
    action: "完成方案评审",
    object: "日报助手方案",
    result: "形成风险清单",
    status: "completed",
    decision: "进入开发",
    blockers: [],
    nextActions: ["开始开发"],
    participantNames: ["测试员工", "评审人"],
    projectSignals: ["日报助手"],
    sourceTypes: ["document"],
    evidenceIds: ["evidence-1"],
    claims: [
      { type: "action", text: "完成方案评审", evidenceIds: ["evidence-1"], certainty: "explicit" },
      { type: "result", text: "形成风险清单", evidenceIds: ["evidence-1"], certainty: "explicit" },
    ],
    origin: "today",
    confidence: 0.92,
    missingFacts: ["hours"],
    ...patch,
  };
}

function output(event = workEvent()): EventModelOutput {
  return { schemaVersion: "work-event-v1", events: [event], ignoredEvidence: [] };
}

test("模型事件允许前一晚已完成证据，拒绝本期17:30及之后证据", () => {
  for (const [occurredAt, expected] of [["2026-08-24T20:00:00+08:00", 1], ["2026-08-25T17:29:59+08:00", 1], ["2026-08-25T17:30:00+08:00", 0]] as const) {
    const result = validateGroundedEvents({
      output: output(), userId: 1, ddUserid: "user-1", jobId: "job-1", workDate: "2026-08-25",
      evidences: [evidence("evidence-1", "document", { occurredAt })], now: new Date("2026-08-25T10:00:00Z"),
    });
    assert.equal(result.events.length, expected, occurredAt);
  }
});

class FakeProvider implements EventModelProvider {
  readonly kind = "fake" as const;
  calls: EventModelRequest[] = [];
  constructor(
    readonly providerName: string,
    readonly model: string,
    private readonly handler: (input: EventModelRequest, call: number) => string | Error,
  ) {}
  async analyze(input: EventModelRequest): Promise<EventModelResponse> {
    this.calls.push(input);
    const result = this.handler(input, this.calls.length);
    if (result instanceof Error) throw result;
    return { content: result, inputTokens: 100, outputTokens: 50, finishReason: "stop", durationMs: 10 };
  }
}

test("模型 WorkEvent JSON 使用严格 Schema，Markdown 围栏和未知字段会被拒绝", () => {
  assert.deepEqual(validateEventModelOutput(output()).events[0].status, "completed");
  assert.throws(() => validateEventModelOutput({ ...output(), extra: true }), /未知字段/);
  assert.throws(() => validateEventModelOutput({ ...output(), events: [{ ...workEvent(), status: "done" }] }), /status/);
});

test("模型提示契约明确列出所有服务端枚举", () => {
  for (const value of [
    "completed", "in_progress", "blocked", "no_progress", "uncertain",
    "today", "continuation", "explicit", "corroborated", "inferred",
    "chat_group", "chat_private", "platform_log", "insufficient_context",
  ]) {
    assert.match(EVENT_FUSION_SYSTEM_PROMPT, new RegExp(`"${value}"`));
  }
});

test("知识库、文档、会议和待办等来源容器名不能成为工作事项", () => {
  for (const title of ["知识库更新", "文档编辑", "会议记录", "AI 听记", "待办处理"]) {
    const result = validateGroundedEvents({
      output: output(workEvent({ title })),
      userId: 1,
      ddUserid: "user-1",
      jobId: "job-1",
      workDate: "2026-08-25",
      evidences: [evidence("evidence-1")],
      now: new Date("2026-08-25T12:00:00.000Z"),
    });
    assert.equal(result.events.length, 0, title);
    assert.equal(result.issues.some((issue) => issue.code === "unsafe_or_ungrounded_title"), true, title);
  }
});

test("Schema 错误在同一 Provider 修复一次后成功", async () => {
  const provider = new FakeProvider("fake-primary", "fixed-2026-08-01", (_input, call) => (
    call === 1 ? "not json" : JSON.stringify(output())
  ));
  const client = new EventModelClient([provider], false);
  const result = await client.analyze({
    phase: "fuse",
    systemPrompt: "test",
    payload: {},
    promptVersion: "event-fusion-v1",
    maxOutputTokens: 1000,
  });
  assert.equal(result.retryCount, 1);
  assert.equal(provider.calls.length, 2);
  assert.match(provider.calls[1].repair?.error ?? "", /JSON/);
});

test("主 Provider 网络失败时切换备用 Provider，全部不可用时明确降级", async () => {
  const primary = new FakeProvider("fake-primary", "primary-2026-08-01", () => new Error("timeout"));
  const backup = new FakeProvider("fake-backup", "backup-2026-08-01", () => JSON.stringify(output()));
  const request = { phase: "fuse" as const, systemPrompt: "test", payload: {}, promptVersion: "v1", maxOutputTokens: 1000 };
  const result = await new EventModelClient([primary, backup], false).analyze(request);
  assert.equal(result.provider, "fake-backup");
  assert.equal(primary.calls.length, 1);
  assert.equal(backup.calls.length, 1);

  await assert.rejects(
    () => new EventModelClient([primary], false).analyze(request),
    (error) => error instanceof EventModelUnavailableError && error.code === "model_unavailable",
  );
});

test("计划和待办创建不能升级为 completed", () => {
  const todo = evidence("evidence-1", "todo", {
    summary: "计划明天完成方案评审",
    evidenceStrength: "weak",
  });
  const result = validateGroundedEvents({
    output: output(),
    userId: 1,
    ddUserid: "user-1",
    jobId: "job-1",
    workDate: "2026-08-25",
    evidences: [todo],
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(result.events[0].status, "uncertain");
  assert.equal(result.events[0].result, "");
  assert.equal(result.events[0].missingFacts.includes("result"), true);
});

test("他人证据不能单独支撑本人 action/result", () => {
  const other = evidence("evidence-1", "chat_group", {
    actorUserIds: ["other"],
    actorNames: ["其他同事"],
    participantNames: ["其他同事", "测试员工"],
    relationToSelf: "others",
    workUse: "background_only",
  });
  const result = validateGroundedEvents({
    output: output(),
    userId: 1,
    ddUserid: "user-1",
    jobId: "job-1",
    workDate: "2026-08-25",
    evidences: [other],
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.rejectedEvents, 1);
  assert.equal(result.issues.some((issue) => issue.code === "today_without_direct_evidence"), true);
});

test("即使来源误标为直接工作，他人当天证据也不能生成本人的今日事项", () => {
  const other = evidence("evidence-1", "wiki", {
    actorUserIds: ["other"],
    actorNames: ["其他同事"],
    participantNames: ["其他同事"],
    relationToSelf: "others",
    workUse: "direct_work",
  });
  const result = validateGroundedEvents({
    output: output(),
    userId: 1,
    ddUserid: "user-1",
    jobId: "job-1",
    workDate: "2026-08-25",
    evidences: [other],
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.rejectedEvents, 1);
  assert.equal(result.issues.some((issue) => issue.code === "today_without_self_evidence"), true);
});

test("continuation 不沿用历史完成结果，partial 来源限制置信度", () => {
  const history = evidence("evidence-1", "platform_log", {
    occurredAt: "2026-08-22T12:00:00+08:00",
    temporalRole: "previous_workday",
    workUse: "continuation_hint",
    resultEligible: false,
    sourceCompleteness: "partial",
  });
  const result = validateGroundedEvents({
    output: output(workEvent({ origin: "continuation", confidence: 0.95 })),
    userId: 1,
    ddUserid: "user-1",
    jobId: "job-1",
    workDate: "2026-08-25",
    evidences: [history],
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(result.events[0].result, "");
  assert.equal(result.events[0].status, "uncertain");
  assert.equal(result.events[0].confidence <= 0.6, true);
  assert.equal(result.events[0].missingFacts.includes("today"), true);
});

test("模型引入不存在的数字、项目和人员时服务端删除或降级", () => {
  const result = validateGroundedEvents({
    output: output(workEvent({
      result: "形成99%验收结果",
      participantNames: ["测试员工", "虚构人员"],
      projectSignals: ["日报助手", "虚构项目"],
    })),
    userId: 1,
    ddUserid: "user-1",
    jobId: "job-1",
    workDate: "2026-08-25",
    evidences: [evidence("evidence-1")],
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(result.events[0].result, "");
  assert.equal(result.events[0].status, "uncertain");
  assert.deepEqual(result.events[0].participantNames, ["测试员工"]);
  assert.deepEqual(result.events[0].projectSignals, ["日报助手"]);
});

test("同一综合证据中的不同工作事项生成不同事件键并可分别保存", () => {
  const source = evidence("evidence-1", "document", {
    title: "日报助手方案与接口联调",
    summary: "完成日报助手方案评审并形成风险清单，同时推进上下文接口联调",
  });
  const first = workEvent();
  const second = workEvent({
    title: "推进上下文接口联调",
    action: "推进接口联调",
    object: "上下文接口",
    result: "",
    status: "in_progress",
    decision: "",
    claims: [{ type: "action", text: "推进接口联调", evidenceIds: ["evidence-1"], certainty: "explicit" }],
  });
  const result = validateGroundedEvents({
    output: { schemaVersion: "work-event-v1", events: [first, second], ignoredEvidence: [] },
    userId: 1,
    ddUserid: "user-1",
    jobId: "job-1",
    workDate: "2026-08-25",
    evidences: [source],
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(result.events.length, 2);
  assert.notEqual(result.events[0].eventKey, result.events[1].eventKey);
});

test("跨来源模型事件经校验后加密进入 WorkEvent Store", async () => {
  const db = createContextDatabase(":memory:");
  const jobStore = new ContextJobStore(db);
  const created = jobStore.createOrReuse(1, "2026-08-25", 12, false, new Date("2026-08-25T04:00:00.000Z"));
  const sources: EvidenceSourceType[] = ["chat_group", "calendar", "minutes", "document", "todo"];
  const evidences = sources.map((source, index) => ({
    ...evidence(`evidence-${index + 1}`, source, {
      conversationId: source === "chat_group" ? "conversation-1" : undefined,
    }),
    jobId: created.job.id,
  }));
  const fused = workEvent({
    evidenceIds: evidences.map((item) => item.referenceId),
    sourceTypes: sources,
    claims: [
      { type: "action", text: "完成方案评审", evidenceIds: ["evidence-4"], certainty: "explicit" },
      { type: "result", text: "形成风险清单", evidenceIds: ["evidence-4"], certainty: "explicit" },
    ],
  });
  const provider = new FakeProvider("fake-unit", "fixed-2026-08-01", () => JSON.stringify(output(fused)));
  const client = new EventModelClient([provider], false);
  const repository = new EventRepository(db, Buffer.alloc(32, 7));
  const generation = new EventGenerationService(
    new EventExtractionService(client),
    new EventFusionService(client),
    repository,
    { promptVersion: "event-fusion-v1", maxInputTokens: 24000, maxOutputTokens: 5000 },
  );
  const user: SessionUser = {
    id: 1,
    kind: "dingtalk",
    ddUserid: "user-1",
    name: "测试员工",
    title: "",
    dept: "研发部",
    role: "emp",
    isExternal: false,
    mustChangePw: false,
  };
  const generated = await generation.generate({
    jobId: created.job.id,
    user,
    workDate: "2026-08-25",
    evidences,
    completeness: sources.map((source) => ({ source, complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: 1 })),
    expiresAt: "2026-08-26T00:00:00.000Z",
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(generated.analysisMode, "real_model");
  assert.equal(generated.events.length, 1);
  assert.equal(generated.coveredEvidenceCount, 5);
  assert.deepEqual(new Set(generated.events[0].sourceTypes), new Set(sources));
  const stored = repository.listForJob(created.job.id, 1, "2026-08-25", new Date("2026-08-25T12:01:00.000Z"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].claims.length, 2);
  assert.equal(repository.latestRunForJob(created.job.id, 1, "2026-08-25", new Date("2026-08-25T12:01:00.000Z"))?.model, "fixed-2026-08-01");
  const raw = JSON.stringify(db.prepare("SELECT payload_cipher FROM assistant_events").get());
  assert.doesNotMatch(raw, /风险清单|方案评审/);
});

test("输入超过预算时先按 Evidence Bundle 抽取再融合", async () => {
  const db = createContextDatabase(":memory:");
  const job = new ContextJobStore(db).createOrReuse(1, "2026-08-25", 12, false, new Date("2026-08-25T04:00:00.000Z")).job;
  const scoped = { ...evidence("evidence-1"), jobId: job.id };
  const provider = new FakeProvider("fake-two-stage", "fixed-2026-08-01", () => JSON.stringify(output()));
  const client = new EventModelClient([provider], false);
  const generation = new EventGenerationService(
    new EventExtractionService(client),
    new EventFusionService(client),
    new EventRepository(db, Buffer.alloc(32, 5)),
    { promptVersion: "event-fusion-v1", maxInputTokens: 1, maxOutputTokens: 5000 },
  );
  const user: SessionUser = {
    id: 1, kind: "dingtalk", ddUserid: "user-1", name: "测试员工", title: "", dept: "研发部",
    role: "emp", isExternal: false, mustChangePw: false,
  };
  const generated = await generation.generate({
    jobId: job.id,
    user,
    workDate: "2026-08-25",
    evidences: [scoped],
    completeness: [{ source: "document", complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: 1 }],
    expiresAt: job.expiresAt,
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(generated.analysisMode, "real_model");
  assert.deepEqual(provider.calls.map((call) => call.phase), ["extract", "fuse"]);
  assert.equal(Array.isArray((provider.calls[1].payload as { priorEvents?: unknown[] }).priorEvents), true);
  db.close();
});
