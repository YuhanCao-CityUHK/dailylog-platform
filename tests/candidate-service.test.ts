import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { CandidateService, LegacyCandidateService, RolloutCandidateService } from "../src/assistant/candidate-service";
import { createContextDatabase } from "../src/assistant/context-db";
import { ContextJobStore } from "../src/assistant/context-jobs";
import { EvidenceStore } from "../src/assistant/evidence-store";
import { createFormalProject } from "../src/projects/service";
import { addUser, createMigratedFixtureDb } from "./helpers";
import { EventExtractionService } from "../src/assistant/events/event-extraction-service";
import { EventFusionService } from "../src/assistant/events/event-fusion-service";
import { EventGenerationService } from "../src/assistant/events/event-generation-service";
import { EventModelClient } from "../src/assistant/events/event-model-client";
import type { EventModelProvider } from "../src/assistant/events/event-model-provider";
import { EventRepository } from "../src/assistant/events/event-repository";
import type { WorkItemAnalysisService } from "../src/assistant/work-item-analysis-service";

test("候选服务聚合多来源并高置信预选项目", async () => {
  const platformDb = createMigratedFixtureDb();
  const userId = addUser(platformDb, { name: "负责人", role: "lead", dept: "研发部" });
  const user: SessionUser = {
    id: userId,
    kind: "dingtalk",
    ddUserid: "owner-user",
    name: "负责人",
    title: "",
    dept: "研发部",
    role: "lead",
    isExternal: false,
    mustChangePw: false,
  };
  const project = createFormalProject(user, { name: "工作日志平台" }, platformDb);
  const contextDb = createContextDatabase(":memory:");
  const jobs = new ContextJobStore(contextDb);
  const job = jobs.createOrReuse(userId, "2026-08-25", 12, false, new Date("2026-08-25T08:00:00Z")).job;
  const evidenceStore = new EvidenceStore(contextDb, Buffer.alloc(32, 3));
  const common = {
    occurredAt: "2026-08-25T09:00:00+08:00",
    actorUserIds: ["owner-user"],
    actorNames: ["负责人"],
    participantNames: [],
    privacyScope: "normal" as const,
    projectSignals: ["工作日志平台"],
    evidenceStrength: "strong" as const,
  };
  evidenceStore.put(job.id, userId, "2026-08-25", {
    ...common,
    sourceType: "document",
    externalId: "doc-1",
    title: "工作日志平台上下文方案",
    summary: "完成多数据源上下文方案",
  }, "2026-08-25T20:00:00.000Z", new Date("2026-08-25T08:00:00Z"));
  evidenceStore.put(job.id, userId, "2026-08-25", {
    ...common,
    sourceType: "chat_group",
    externalId: "chat-1",
    title: "工作日志平台上下文讨论",
    summary: "确认接口边界和降级规则",
  }, "2026-08-25T20:00:00.000Z", new Date("2026-08-25T08:00:00Z"));

  const { candidates } = await new LegacyCandidateService(evidenceStore, platformDb).build(
    user,
    job.id,
    "2026-08-25",
    new Date("2026-08-25T10:00:00Z"),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].selectedProjectId, project.id);
  assert.equal(candidates[0].scopeType, "project");
  assert.equal(candidates[0].referenceIds.length, 2);
  assert.deepEqual(candidates[0].needsConfirmation, ["hours"]);
  contextDb.close();
  platformDb.close();
});

test("事件灰度候选只消费校验后的 WorkEvent，模型不可用时不回退原始 Evidence", async () => {
  const platformDb = createMigratedFixtureDb();
  const userId = addUser(platformDb, { name: "测试员工", role: "lead", dept: "研发部" });
  const user: SessionUser = {
    id: userId, kind: "dingtalk", ddUserid: "event-user", name: "测试员工", title: "", dept: "研发部",
    role: "lead", isExternal: false, mustChangePw: false,
  };
  const project = createFormalProject(user, { name: "日报助手" }, platformDb);
  const contextDb = createContextDatabase(":memory:");
  const jobs = new ContextJobStore(contextDb);
  const now = new Date("2026-08-25T08:00:00.000Z");
  const job = jobs.createOrReuse(userId, "2026-08-25", 12, false, now).job;
  const key = Buffer.alloc(32, 9);
  const evidenceStore = new EvidenceStore(contextDb, key);
  const referenceId = evidenceStore.put(job.id, userId, "2026-08-25", {
    sourceType: "document",
    externalId: "event-doc-1",
    title: "日报助手事件链路",
    summary: "测试员工完成事件链路并形成服务端校验清单；这段 Evidence 摘要不能直接成为结果",
    occurredAt: "2026-08-25T15:00:00+08:00",
    actorUserIds: ["event-user"],
    actorNames: ["测试员工"],
    participantNames: ["测试员工"],
    privacyScope: "normal",
    projectSignals: ["日报助手"],
    evidenceStrength: "strong",
    relationToSelf: "self",
    senderKind: "user",
    temporalRole: "today",
    workUse: "direct_work",
    sourceCompleteness: "complete",
    resultEligible: true,
  }, job.expiresAt, now);
  const modelOutput = {
    schemaVersion: "work-event-v1",
    events: [{
      eventKey: "model-controlled-key",
      title: "推进日报助手事件链路",
      action: "完成事件链路",
      object: "日报助手",
      result: "形成服务端校验清单",
      status: "completed",
      decision: "进入候选接入",
      blockers: [],
      nextActions: ["开展回归测试"],
      participantNames: ["测试员工"],
      projectSignals: ["日报助手"],
      sourceTypes: ["document"],
      evidenceIds: [referenceId],
      claims: [
        { type: "action", text: "完成事件链路", evidenceIds: [referenceId], certainty: "explicit" },
        { type: "result", text: "形成服务端校验清单", evidenceIds: [referenceId], certainty: "explicit" },
      ],
      origin: "today",
      confidence: 0.93,
      missingFacts: ["hours"],
    }],
    ignoredEvidence: [],
  };
  const provider: EventModelProvider = {
    kind: "fake",
    providerName: "unit",
    model: "unit-2026-08-01",
    analyze: async () => ({
      content: JSON.stringify(modelOutput), inputTokens: 10, outputTokens: 20, finishReason: "stop", durationMs: 1,
    }),
  };
  const client = new EventModelClient([provider], false);
  const generation = new EventGenerationService(
    new EventExtractionService(client), new EventFusionService(client), new EventRepository(contextDb, key),
    { promptVersion: "event-fusion-v1", maxInputTokens: 24000, maxOutputTokens: 5000 },
  );
  const eventService = new CandidateService(evidenceStore, platformDb, {
    generationService: generation,
    jobStore: jobs,
  });
  const built = await eventService.build(user, job.id, "2026-08-25", new Date("2026-08-25T09:00:00.000Z"));
  assert.equal(built.analysisMode, "real_model");
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].resultHint, "形成服务端校验清单");
  assert.doesNotMatch(built.candidates[0].resultHint, /Evidence 摘要/);
  assert.equal(built.candidates[0].selectedProjectId, project.id);
  assert.deepEqual(built.candidates[0].missingFacts, ["hours"]);

  const unavailableProvider: EventModelProvider = {
    ...provider,
    analyze: async () => { throw new Error("timeout"); },
  };
  const unavailableClient = new EventModelClient([unavailableProvider], false);
  const unavailable = new CandidateService(evidenceStore, platformDb, {
    generationService: new EventGenerationService(
      new EventExtractionService(unavailableClient), new EventFusionService(unavailableClient), new EventRepository(contextDb, key),
      { promptVersion: "event-fusion-v1", maxInputTokens: 24000, maxOutputTokens: 5000 },
    ),
    jobStore: jobs,
  });
  const degraded = await unavailable.build(user, job.id, "2026-08-25", new Date("2026-08-25T09:01:00.000Z"));
  assert.equal(degraded.analysisMode, "model_unavailable");
  assert.deepEqual(degraded.candidates, []);
  contextDb.close();
  platformDb.close();
});

test("候选准备只启动一次并从 pending 转为 ready，阻塞 build 复用同一结果", async () => {
  const platformDb = createMigratedFixtureDb();
  const contextDb = createContextDatabase(":memory:");
  const evidenceStore = new EvidenceStore(contextDb, Buffer.alloc(32, 4));
  const testUser: SessionUser = {
    id: 1, kind: "dingtalk", ddUserid: "prepare-user", name: "准备测试员工", title: "", dept: "研发部",
    role: "emp", isExternal: false, mustChangePw: false,
  };
  let analyzeCalls = 0;
  let releaseAnalysis!: () => void;
  const analysisGate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
  const analysisService: WorkItemAnalysisService = {
    async analyze() {
      analyzeCalls += 1;
      await analysisGate;
      return { items: [], mode: "deterministic" };
    },
  };
  const service = new RolloutCandidateService(evidenceStore, platformDb, analysisService);
  assert.equal(service.usesRolloutAnalysis(testUser), false);
  const first = service.prepare(testUser, "prepare-job", "2026-08-25");
  const second = service.prepare(testUser, "prepare-job", "2026-08-25");
  const blocking = service.build(testUser, "prepare-job", "2026-08-25");

  assert.deepEqual(first, { ready: false, analysisRunning: true });
  assert.deepEqual(second, first);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(analyzeCalls, 1, "轮询和阻塞读取必须共享同一次生成");

  releaseAnalysis();
  const built = await blocking;
  const ready = service.prepare(testUser, "prepare-job", "2026-08-25");
  assert.equal(ready.ready, true);
  if (ready.ready) assert.strictEqual(ready.result, built, "ready 结果必须复用缓存对象");
  assert.equal(analyzeCalls, 1);
  contextDb.close();
  platformDb.close();
});

test("只有命中 Event Fusion 或 Work Discovery 灰度的用户需要异步准备", () => {
  const platformDb = createMigratedFixtureDb();
  const contextDb = createContextDatabase(":memory:");
  const evidenceStore = new EvidenceStore(contextDb, Buffer.alloc(32, 5));
  const jobs = new ContextJobStore(contextDb);
  const service = new RolloutCandidateService(
    evidenceStore,
    platformDb,
    undefined,
    {
      generationService: null as unknown as EventGenerationService,
      jobStore: jobs,
      enabledForUser: (candidate) => candidate.ddUserid === "event-pilot",
      workDiscoveryEnabledForUser: (candidate) => candidate.ddUserid === "discovery-pilot",
    },
  );
  const base: SessionUser = {
    id: 1, kind: "dingtalk", ddUserid: "ordinary", name: "测试员工", title: "", dept: "研发部",
    role: "emp", isExternal: false, mustChangePw: false,
  };
  assert.equal(service.usesRolloutAnalysis(base), false);
  assert.equal(service.usesRolloutAnalysis({ ...base, ddUserid: "event-pilot" }), true);
  assert.equal(service.usesRolloutAnalysis({ ...base, ddUserid: "discovery-pilot" }), true);
  contextDb.close();
  platformDb.close();
});

test("灰度用户后台准备失败会被记录且不会产生未处理拒绝或自动重复生成", async () => {
  const platformDb = createMigratedFixtureDb();
  const contextDb = createContextDatabase(":memory:");
  const evidenceStore = new EvidenceStore(contextDb, Buffer.alloc(32, 6));
  const testUser: SessionUser = {
    id: 2, kind: "dingtalk", ddUserid: "failed-prepare-user", name: "失败测试员工", title: "", dept: "研发部",
    role: "emp", isExternal: false, mustChangePw: false,
  };
  const service = new RolloutCandidateService(
    evidenceStore,
    platformDb,
    undefined,
    {
      generationService: null as unknown as EventGenerationService,
      jobStore: new ContextJobStore(contextDb),
      enabledForUser: () => true,
    },
  );
  assert.deepEqual(service.prepare(testUser, "failed-job", "2026-08-25"), {
    ready: false,
    analysisRunning: true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.throws(
    () => service.prepare(testUser, "failed-job", "2026-08-25"),
    /assistant_context_job_not_found/,
  );
  contextDb.close();
  platformDb.close();
});

test("非灰度用户保持同步 build 失败后可重试语义", async () => {
  const platformDb = createMigratedFixtureDb();
  const contextDb = createContextDatabase(":memory:");
  const evidenceStore = new EvidenceStore(contextDb, Buffer.alloc(32, 7));
  const testUser: SessionUser = {
    id: 3, kind: "dingtalk", ddUserid: "ordinary-user", name: "普通测试员工", title: "", dept: "研发部",
    role: "emp", isExternal: false, mustChangePw: false,
  };
  let analyzeCalls = 0;
  const analysisService: WorkItemAnalysisService = {
    async analyze() {
      analyzeCalls += 1;
      throw new Error("ordinary analysis failed");
    },
  };
  const service = new RolloutCandidateService(evidenceStore, platformDb, analysisService);
  await assert.rejects(service.build(testUser, "ordinary-job", "2026-08-25"), /ordinary analysis failed/);
  await assert.rejects(service.build(testUser, "ordinary-job", "2026-08-25"), /ordinary analysis failed/);
  assert.equal(analyzeCalls, 2, "非灰度同步调用失败后应允许显式重试");
  contextDb.close();
  platformDb.close();
});
