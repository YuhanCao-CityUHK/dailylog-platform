import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionUser } from "../src/auth/types";
import { candidateToSessionDefaults } from "../src/assistant/conversation-schema";
import { ConversationEngine } from "../src/assistant/conversation-engine";
import { createContextDatabase, listContextMigrations } from "../src/assistant/context-db";
import { ContextJobStore } from "../src/assistant/context-jobs";
import { EvidenceStore, type EvidenceWithReference } from "../src/assistant/evidence-store";
import type { EventModelProvider } from "../src/assistant/events/event-model-provider";
import { validateGroundedInteractions } from "../src/assistant/interactions/interaction-grounding-validator";
import {
  buildInteractionDiscoveryThreads,
  estimateInteractionRequestTokens,
  INTERACTION_BATCH_CONCURRENCY,
  InteractionGenerationService,
  InteractionInputBudgetError,
  TASK_DISCOVERY_MAX_BATCH_INPUT_TOKENS,
  TASK_DISCOVERY_MAX_THREADS_PER_BATCH,
} from "../src/assistant/interactions/interaction-generation-service";
import { InteractionModelClient } from "../src/assistant/interactions/interaction-model-client";
import { validateInteractionModelOutput } from "../src/assistant/interactions/interaction-output-validator";
import { InteractionRepository } from "../src/assistant/interactions/interaction-repository";
import type { InteractionCandidate, InteractionModelOutput } from "../src/assistant/interactions/interaction-types";
import { addUser, createMigratedFixtureDb } from "./helpers";

const NOW = new Date("2026-09-02T08:00:00.000Z");
const EXPIRES = "2026-09-02T20:00:00.000Z";

function user(): SessionUser {
  return {
    id: 1,
    kind: "dingtalk",
    ddUserid: "self-dd",
    name: "杨楚榛",
    title: "",
    dept: "研发部",
    role: "emp",
    isExternal: false,
    mustChangePw: false,
  };
}

function interaction(patch: Partial<InteractionCandidate> = {}): InteractionCandidate {
  return {
    candidateKey: "",
    title: "整理评审数据",
    summary: "整理评审数据",
    latestProgress: "",
    direction: "assigned_to_me",
    state: "pending",
    priority: "P1",
    intent: "assignment",
    participantNames: ["杨楚榛", "李咏赋"],
    projectSignals: [],
    sourceTypes: ["chat_group"],
    evidenceIds: ["ref-1"],
    latestAt: "2026-09-02T13:40:00+08:00",
    confidence: 0.9,
    selfActionSupported: false,
    resultSupported: false,
    missingFacts: ["today", "result", "status"],
    ...patch,
  };
}

function evidence(referenceId: string, patch: Partial<EvidenceWithReference["evidence"]> = {}): EvidenceWithReference {
  return {
    referenceId,
    jobId: "job-1",
    userId: 1,
    workDate: "2026-09-02",
    expiresAt: EXPIRES,
    evidence: {
      sourceType: "chat_group",
      externalId: referenceId,
      title: "项目协作群",
      summary: "杨楚榛，请整理评审数据，今天下午给我",
      occurredAt: "2026-09-02T13:40:00+08:00",
      actorUserIds: ["other-dd"],
      actorNames: ["李咏赋"],
      participantNames: ["杨楚榛", "李咏赋"],
      privacyScope: "employee_only",
      projectSignals: [],
      evidenceStrength: "medium",
      relationToSelf: "addressed",
      senderKind: "user",
      temporalRole: "today",
      workUse: "task_signal",
      sourceCompleteness: "complete",
      resultEligible: false,
      conversationId: "group-1",
      ...patch,
    },
  };
}

function output(candidates: InteractionCandidate[]): InteractionModelOutput {
  return { schemaVersion: "interaction-candidate-v1", candidates, ignoredEvidence: [] };
}

test("任务发现使用跨日窗口：前一晚是本期锚点，截止后的消息不能证明本期动作", () => {
  const priorEvening = evidence("ref-1", {
    occurredAt: "2026-09-01T20:00:00+08:00", relationToSelf: "self", actorUserIds: ["self-dd"], workUse: "direct_work",
  });
  const afterCutoff = evidence("ref-2", { occurredAt: "2026-09-02T17:30:00+08:00" });
  const built = buildInteractionDiscoveryThreads([priorEvening, afterCutoff], "2026-09-02");
  assert.equal(built.threads.length, 1);
  const result = validateGroundedInteractions({
    output: output([interaction({ direction: "self_progress", selfActionSupported: true })]),
    userId: 1, ddUserid: "self-dd", jobId: "job-1", workDate: "2026-09-02", evidences: [priorEvening], now: NOW,
  });
  assert.equal(result.candidates[0]?.selfActionSupported, true);
});

test("纯入站交办进入任务候选，但不能冒充本人已完成成果", () => {
  const item = evidence("ref-1");
  const result = validateGroundedInteractions({
    output: output([interaction({
      state: "completed",
      latestProgress: "整理评审数据已完成",
      selfActionSupported: true,
      resultSupported: true,
    })]),
    userId: 1,
    ddUserid: "self-dd",
    jobId: "job-1",
    workDate: "2026-09-02",
    evidences: [item],
    now: NOW,
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].state, "pending");
  assert.equal(result.candidates[0].selfActionSupported, false);
  assert.equal(result.candidates[0].resultSupported, false);
  assert.equal(result.candidates[0].latestProgress, "");
  assert.equal(result.candidates[0].missingFacts.includes("today"), true);
  assert.equal(result.candidates[0].missingFacts.includes("result"), true);
  assert.equal(result.candidates[0].missingFacts.includes("status"), true);
});

test("普通他人讨论不会通过任务资格闸门", () => {
  const ordinary = evidence("ref-1", { workUse: "background_only", relationToSelf: "others" });
  const rejected = validateGroundedInteractions({
    output: output([interaction({ intent: "other", confidence: 0.4 })]),
    userId: 1,
    ddUserid: "self-dd",
    jobId: "job-1",
    workDate: "2026-09-02",
    evidences: [ordinary],
    now: NOW,
  });
  assert.equal(rejected.candidates.length, 0);
  const stillRejected = validateGroundedInteractions({
    output: output([interaction()]),
    userId: 1,
    ddUserid: "self-dd",
    jobId: "job-1",
    workDate: "2026-09-02",
    evidences: [evidence("ref-1", { relationToSelf: "others", workUse: "background_only" })],
    now: NOW,
  });
  assert.equal(stillRejected.candidates.length, 0, "模型高置信也不能绕过服务端任务信号闸门");
});

test("聊天任务只携带有界相邻上下文，不能因多消息退化为整群输入", () => {
  const messages = Array.from({ length: 100 }, (_, index) => evidence(`context-${index}`, {
    externalId: `message-${index}`,
    summary: `普通群聊消息 ${index}`,
    occurredAt: new Date(Date.parse("2026-09-02T01:00:00.000Z") + index * 60_000).toISOString(),
    relationToSelf: index === 50 ? "addressed" : "others",
    workUse: index === 50 ? "task_signal" : "background_only",
    conversationId: "large-group",
  }));
  const built = buildInteractionDiscoveryThreads(messages, "2026-09-02");
  const ids = built.threads.flatMap((thread) => thread.items.map((item) => item.evidenceId));
  assert.equal(built.signalEvidenceIds.length, 1);
  assert.equal(ids.includes("context-50"), true);
  assert.equal(ids.length <= 9, true, `单个 anchor 最多携带前后各 4 条，实际 ${ids.length}`);
});

test("任务发现按完整请求预算和线程数分批，并保留所有批次结果", async () => {
  const db = createContextDatabase(":memory:");
  const jobs = new ContextJobStore(db);
  const job = jobs.createOrReuse(1, "2026-09-02", 12, false, NOW).job;
  const key = Buffer.alloc(32, 5);
  const evidenceStore = new EvidenceStore(db, key);
  const expectedIds = Array.from({ length: 11 }, (_, index) => evidenceStore.put(
    job.id,
    1,
    "2026-09-02",
    evidence(`bounded-${index}`, {
      sourceType: "todo",
      title: `处理任务 ${index}`,
      summary: `处理任务 ${index}：${"补充业务上下文".repeat(120)}`,
      conversationId: undefined,
    }).evidence,
    EXPIRES,
    NOW,
  ));
  const requests: Parameters<EventModelProvider["analyze"]>[0][] = [];
  const completionOrder: number[] = [];
  let active = 0;
  let peak = 0;
  const provider: EventModelProvider = {
    kind: "fake", providerName: "bounded-batches", model: "fixed",
    async analyze(request) {
      const callIndex = requests.length;
      requests.push(request);
      active += 1;
      peak = Math.max(peak, active);
      const threads = (request.payload as {
        taskThreads: Array<{ items: Array<{
          evidenceId: string;
          sourceType: InteractionCandidate["sourceTypes"][number];
          title: string;
          occurredAt: string;
          participantNames: string[];
        }> }>;
      }).taskThreads;
      await new Promise<void>((resolve) => setTimeout(resolve, callIndex % 2 === 0 ? 20 : 2));
      completionOrder.push(callIndex);
      active -= 1;
      return {
        content: JSON.stringify(output(threads.flatMap((thread) => thread.items.map((item) => interaction({
          title: item.title,
          summary: item.title,
          participantNames: item.participantNames,
          sourceTypes: [item.sourceType],
          evidenceIds: [item.evidenceId],
          latestAt: item.occurredAt,
        }))))),
        inputTokens: 1, outputTokens: 1, finishReason: "stop", durationMs: 1,
      };
    },
  };
  const repository = new InteractionRepository(db, key);
  const generated = await new InteractionGenerationService(
    new InteractionModelClient([provider], false),
    repository,
    { promptVersion: "task-discovery-v1", maxInputTokens: 24_000, maxOutputTokens: 5_000, maxCandidates: 50 },
  ).generate({
    jobId: job.id,
    user: user(),
    workDate: "2026-09-02",
    evidences: evidenceStore.listEvidenceForJob(job.id, 1, NOW),
    completeness: [{ source: "todo", complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: expectedIds.length }],
    expiresAt: EXPIRES,
    now: NOW,
  });

  assert.equal(requests.length > 1, true, "长输入必须拆成多个短调用");
  assert.equal(peak, INTERACTION_BATCH_CONCURRENCY, "任务发现峰值并发必须严格限制为 2");
  assert.equal(completionOrder[0], 1, "测试必须覆盖后批次先完成的场景");
  for (const request of requests) {
    const threads = (request.payload as { taskThreads: unknown[] }).taskThreads;
    assert.equal(threads.length <= TASK_DISCOVERY_MAX_THREADS_PER_BATCH, true);
    assert.equal(
      estimateInteractionRequestTokens(request.systemPrompt, request.payload) <= TASK_DISCOVERY_MAX_BATCH_INPUT_TOKENS,
      true,
      `单批完整请求不得超过 ${TASK_DISCOVERY_MAX_BATCH_INPUT_TOKENS} token 估算预算`,
    );
    assert.match(request.systemPrompt, /ignoredEvidence 固定输出空数组/);
  }
  const sentIds = requests.flatMap((request) => (
    request.payload as { taskThreads: Array<{ items: Array<{ evidenceId: string }> }> }
  ).taskThreads.flatMap((thread) => thread.items.map((item) => item.evidenceId)));
  assert.deepEqual(new Set(sentIds), new Set(expectedIds), "分批不能漏掉任何任务证据");
  assert.equal(sentIds.length, expectedIds.length, "分批不能重复发送任务证据");
  assert.equal(generated.candidates.length, expectedIds.length, "所有成功批次的候选必须汇总保留");
  assert.deepEqual(
    generated.candidates.map((candidate) => candidate.evidenceIds[0]),
    sentIds,
    "即使模型调用乱序完成，候选仍须按批次索引稳定归并",
  );
  db.close();
});

test("单条极端任务证据只压缩低优先字段且每个请求仍严格低于预算", async () => {
  const db = createContextDatabase(":memory:");
  const job = new ContextJobStore(db).createOrReuse(1, "2026-09-02", 12, false, NOW).job;
  const key = Buffer.alloc(32, 4);
  const extreme = Array.from({ length: 3 }, (_, index) => ({
    ...evidence(`oversized-${index}`, {
      title: `处理极端任务 ${index}`,
      summary: `处理极端任务 ${index} 开始 ${"完整业务上下文".repeat(300)} 结束交付`,
      actorNames: Array.from({ length: 30 }, (__, nameIndex) => `发起人${nameIndex}${"甲".repeat(200)}`),
      participantNames: Array.from({ length: 30 }, (__, nameIndex) => `参与人${nameIndex}${"乙".repeat(200)}`),
      projectSignals: Array.from({ length: 20 }, (__, signalIndex) => `项目${signalIndex}${"丙".repeat(200)}`),
      conversationId: `conversation-${index}-${"c".repeat(5_000)}`,
      threadId: `thread-${index}-${"t".repeat(3_000)}`,
      replyToMessageId: `reply-${index}-${"r".repeat(3_000)}`,
      quotedMessageId: `quote-${index}-${"q".repeat(3_000)}`,
    }),
    jobId: job.id,
  }));
  const normal = {
    ...evidence("normal-item", {
      title: "跟进正常任务",
      summary: "杨楚榛请跟进正常任务并回复进度",
      actorNames: ["李咏赋"],
      participantNames: ["杨楚榛", "李咏赋"],
      projectSignals: ["正常项目"],
      conversationId: "normal-conversation",
      threadId: "normal-thread",
      replyToMessageId: "normal-reply",
      quotedMessageId: "normal-quote",
    }),
    jobId: job.id,
  };
  const evidences = [...extreme, normal];
  const requests: Parameters<EventModelProvider["analyze"]>[0][] = [];
  const provider: EventModelProvider = {
    kind: "fake", providerName: "oversized-input", model: "fixed",
    async analyze(request) {
      requests.push(request);
      return {
        content: JSON.stringify(output([])),
        inputTokens: 1, outputTokens: 1, finishReason: "stop", durationMs: 1,
      };
    },
  };
  await new InteractionGenerationService(
    new InteractionModelClient([provider], false),
    new InteractionRepository(db, key),
    { promptVersion: "task-discovery-v1", maxInputTokens: 24_000, maxOutputTokens: 5_000, maxCandidates: 50 },
  ).generate({
    jobId: job.id,
    user: user(),
    workDate: "2026-09-02",
    evidences,
    completeness: [{ source: "chat", complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: evidences.length }],
    expiresAt: EXPIRES,
    now: NOW,
  });

  for (const request of requests) {
    assert.equal(
      estimateInteractionRequestTokens(request.systemPrompt, request.payload) <= TASK_DISCOVERY_MAX_BATCH_INPUT_TOKENS,
      true,
      "即使单条证据极端膨胀，完整模型请求也不能突破硬预算",
    );
  }
  const sentItems = requests.flatMap((request) => (
    request.payload as { taskThreads: Array<{ items: Array<{
      evidenceId: string;
      sourceType: string;
      title: string;
      summary: string;
      occurredAt: string;
      relationToSelf: string;
      workUse: string;
      actorNames: string[];
      participantNames: string[];
      projectSignals: string[];
      conversationId: string;
      threadId: string;
      replyToMessageId: string;
      quotedMessageId: string;
    }> }> }
  ).taskThreads.flatMap((thread) => thread.items));
  assert.deepEqual(
    sentItems.map((item) => item.evidenceId).sort(),
    evidences.map((item) => item.referenceId).sort(),
    "压缩与拆批后每条证据必须且只能发送一次",
  );
  for (const item of sentItems) {
    const original = evidences.find((entry) => entry.referenceId === item.evidenceId)!;
    assert.equal(item.sourceType, original.evidence.sourceType);
    assert.equal(item.occurredAt, original.evidence.occurredAt);
    assert.equal(item.relationToSelf, original.evidence.relationToSelf);
    assert.equal(item.workUse, original.evidence.workUse);
    assert.equal(item.title, original.evidence.title);
  }
  const sentNormal = sentItems.find((item) => item.evidenceId === normal.referenceId)!;
  assert.equal(sentNormal.summary, normal.evidence.summary, "未超限的普通证据摘要必须保持原样");
  assert.deepEqual(sentNormal.actorNames, normal.evidence.actorNames);
  assert.deepEqual(sentNormal.participantNames, normal.evidence.participantNames);
  assert.deepEqual(sentNormal.projectSignals, normal.evidence.projectSignals);
  assert.equal(sentNormal.conversationId, normal.evidence.conversationId);
  assert.equal(sentNormal.threadId, normal.evidence.threadId);
  assert.equal(sentNormal.replyToMessageId, normal.evidence.replyToMessageId);
  assert.equal(sentNormal.quotedMessageId, normal.evidence.quotedMessageId);
  assert.equal(sentItems.some((item) => item.evidenceId.startsWith("oversized-") && item.actorNames.length < 30), true);
  db.close();
});

test("基础包络与最小证据仍无法容纳时明确失败且不调用模型", async () => {
  const db = createContextDatabase(":memory:");
  const job = new ContextJobStore(db).createOrReuse(1, "2026-09-02", 12, false, NOW).job;
  let modelCalls = 0;
  const provider: EventModelProvider = {
    kind: "fake", providerName: "must-not-run", model: "fixed",
    async analyze() {
      modelCalls += 1;
      return { content: JSON.stringify(output([])), inputTokens: 1, outputTokens: 1, finishReason: "stop", durationMs: 1 };
    },
  };
  const repository = new InteractionRepository(db, Buffer.alloc(32, 2));
  const item = { ...evidence("impossible-budget", { conversationId: undefined }), jobId: job.id };
  await assert.rejects(
    () => new InteractionGenerationService(
      new InteractionModelClient([provider], false),
      repository,
      { promptVersion: "task-discovery-v1", maxInputTokens: 1, maxOutputTokens: 1_000, maxCandidates: 50 },
    ).generate({
      jobId: job.id,
      user: user(),
      workDate: "2026-09-02",
      evidences: [item],
      completeness: [{ source: "chat", complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: 1 }],
      expiresAt: EXPIRES,
      now: NOW,
    }),
    (error) => error instanceof InteractionInputBudgetError,
  );
  assert.equal(modelCalls, 0);
  assert.equal(repository.latestRunForJob(job.id, 1, "2026-09-02", NOW)?.status, "failed");
  db.close();
});

test("任务模型严格限制 50 项并拒绝未知字段", () => {
  assert.equal(validateInteractionModelOutput(output([interaction()])).candidates.length, 1);
  assert.throws(() => validateInteractionModelOutput({ ...output([]), extra: true }), /未知字段/);
  assert.throws(
    () => validateInteractionModelOutput(output(Array.from({ length: 51 }, (_, index) => interaction({ title: `任务${index}` })))),
    /最多 50/,
  );
});

test("主模型两次结构错误后继续尝试备用模型", async () => {
  let primaryCalls = 0;
  let backupCalls = 0;
  const primary: EventModelProvider = {
    kind: "fake", providerName: "bad-primary", model: "bad",
    async analyze() {
      primaryCalls += 1;
      return { content: "{}", inputTokens: 1, outputTokens: 1, finishReason: "stop", durationMs: 1 };
    },
  };
  const backup: EventModelProvider = {
    kind: "fake", providerName: "good-backup", model: "good",
    async analyze() {
      backupCalls += 1;
      return {
        content: JSON.stringify(output([interaction()])),
        inputTokens: 1, outputTokens: 1, finishReason: "stop", durationMs: 1,
      };
    },
  };
  const response = await new InteractionModelClient([primary, backup], false).analyze({
    phase: "extract", systemPrompt: "test", payload: {}, promptVersion: "v1", maxOutputTokens: 1000,
  });
  assert.equal(response.provider, "good-backup");
  assert.equal(primaryCalls, 2, "主模型先生成再修复");
  assert.equal(backupCalls, 1);
});

test("多批任务发现中单批模型失败时保留其它成功批次", async () => {
  const db = createContextDatabase(":memory:");
  const jobs = new ContextJobStore(db);
  const job = jobs.createOrReuse(1, "2026-09-02", 12, false, NOW).job;
  const key = Buffer.alloc(32, 7);
  const evidenceStore = new EvidenceStore(db, key);
  const firstId = evidenceStore.put(job.id, 1, "2026-09-02", evidence("batch-1", {
    sourceType: "todo", title: "整理评审数据", summary: "整理评审数据", conversationId: undefined,
  }).evidence, EXPIRES, NOW);
  const secondId = evidenceStore.put(job.id, 1, "2026-09-02", evidence("batch-2", {
    sourceType: "todo", title: "跟进供应商报价", summary: "跟进供应商报价", conversationId: undefined,
  }).evidence, EXPIRES, NOW);
  let calls = 0;
  const provider: EventModelProvider = {
    kind: "fake", providerName: "flaky", model: "flaky",
    async analyze(request) {
      calls += 1;
      if (calls === 1) throw new Error("temporary timeout");
      const threads = (request.payload as { taskThreads: Array<{ items: Array<{ evidenceId: string; title: string }> }> }).taskThreads;
      const item = threads[0].items[0];
      return {
        content: JSON.stringify(output([interaction({
          title: item.title,
          summary: item.title,
          evidenceIds: [item.evidenceId],
          sourceTypes: ["todo"],
        })])),
        inputTokens: 1, outputTokens: 1, finishReason: "stop", durationMs: 1,
      };
    },
  };
  const repository = new InteractionRepository(db, key);
  const service = new InteractionGenerationService(
    new InteractionModelClient([provider], false), repository,
    { promptVersion: "task-discovery-v1", maxInputTokens: 1_850, maxOutputTokens: 1000, maxCandidates: 50 },
  );
  const result = await service.generate({
    jobId: job.id,
    user: user(),
    workDate: "2026-09-02",
    evidences: evidenceStore.listEvidenceForJob(job.id, 1, NOW),
    completeness: [{ source: "todo", complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: 2 }],
    expiresAt: EXPIRES,
    now: NOW,
  });
  assert.equal(result.candidates.length, 1);
  assert.equal([firstId, secondId].includes(result.candidates[0].evidenceIds[0]), true);
  assert.equal(result.candidates[0].evidenceIds.length, 1, "失败批次不能污染成功批次的证据");
  assert.equal(repository.latestRunForJob(job.id, 1, "2026-09-02", NOW)?.status, "partial");
  assert.notEqual(firstId, secondId);
  db.close();
});

test("候选上限在去重后执行，重复任务不能挤掉后面的独立任务", async () => {
  const db = createContextDatabase(":memory:");
  const jobs = new ContextJobStore(db);
  const job = jobs.createOrReuse(1, "2026-09-02", 12, false, NOW).job;
  const key = Buffer.alloc(32, 6);
  const evidenceStore = new EvidenceStore(db, key);
  const duplicateId = evidenceStore.put(job.id, 1, "2026-09-02", evidence("dup", {
    occurredAt: "2026-09-02T15:00:00+08:00",
  }).evidence, EXPIRES, NOW);
  const uniqueId = evidenceStore.put(job.id, 1, "2026-09-02", evidence("unique", {
    title: "供应商报价",
    summary: "杨楚榛，请跟进供应商报价",
    occurredAt: "2026-09-02T14:00:00+08:00",
  }).evidence, EXPIRES, NOW);
  const duplicates = Array.from({ length: 8 }, () => interaction({
    evidenceIds: [duplicateId],
    latestAt: "2026-09-02T15:00:00+08:00",
  }));
  const provider: EventModelProvider = {
    kind: "fake", providerName: "dedupe-order", model: "fixed",
    async analyze() {
      return {
        content: JSON.stringify(output([...duplicates, interaction({
          title: "跟进供应商报价",
          summary: "跟进供应商报价",
          evidenceIds: [uniqueId],
          latestAt: "2026-09-02T14:00:00+08:00",
        })])),
        inputTokens: 1, outputTokens: 1, finishReason: "stop", durationMs: 1,
      };
    },
  };
  const repository = new InteractionRepository(db, key);
  const result = await new InteractionGenerationService(
    new InteractionModelClient([provider], false), repository,
    { promptVersion: "task-discovery-v1", maxInputTokens: 24_000, maxOutputTokens: 1000, maxCandidates: 8 },
  ).generate({
    jobId: job.id,
    user: user(),
    workDate: "2026-09-02",
    evidences: evidenceStore.listEvidenceForJob(job.id, 1, NOW),
    completeness: [{ source: "chat", complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: 2 }],
    expiresAt: EXPIRES,
    now: NOW,
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.some((item) => item.evidenceIds.includes(uniqueId)), true);
  db.close();
});

test("同一群里标题相同但证据不相交的两项任务不合并，并加密存储、隔离用户、随任务级联清理", async () => {
  const db = createContextDatabase(":memory:");
  assert.deepEqual(listContextMigrations(db).map((item) => item.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  const jobs = new ContextJobStore(db);
  const job = jobs.createOrReuse(1, "2026-09-02", 12, false, NOW).job;
  const key = Buffer.alloc(32, 9);
  const evidenceStore = new EvidenceStore(db, key);
  const firstId = evidenceStore.put(job.id, 1, "2026-09-02", evidence("x").evidence, EXPIRES, NOW);
  const secondId = evidenceStore.put(job.id, 1, "2026-09-02", evidence("y", {
    externalId: "message-2",
    summary: "杨楚榛，请整理评审数据，用于供应商报价回复",
    occurredAt: "2026-09-02T14:00:00+08:00",
  }).evidence, EXPIRES, NOW);
  const raw = evidenceStore.listEvidenceForJob(job.id, 1, NOW);
  const candidates = [
    interaction({ evidenceIds: [firstId] }),
    interaction({
      title: "整理评审数据",
      summary: "整理评审数据",
      evidenceIds: [secondId],
      latestAt: "2026-09-02T14:00:00+08:00",
      priority: "P2",
    }),
  ];
  const provider: EventModelProvider = {
    kind: "fake",
    providerName: "interaction-unit",
    model: "fixed-2026-09-01",
    async analyze() {
      return {
        content: JSON.stringify(output(candidates)),
        inputTokens: 30,
        outputTokens: 20,
        finishReason: "stop",
        durationMs: 2,
      };
    },
  };
  const repository = new InteractionRepository(db, key);
  const service = new InteractionGenerationService(
    new InteractionModelClient([provider], false),
    repository,
    { promptVersion: "task-discovery-v1", maxInputTokens: 24_000, maxOutputTokens: 5_000, maxCandidates: 50 },
  );
  const generated = await service.generate({
    jobId: job.id,
    user: user(),
    workDate: "2026-09-02",
    evidences: raw,
    completeness: [{ source: "chat", complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: 2 }],
    expiresAt: EXPIRES,
    now: NOW,
  });
  assert.equal(generated.candidates.length, 2, "相同群名和相同标题都不能单独作为合并依据");
  assert.equal(repository.listForJob(job.id, 1, "2026-09-02", NOW).length, 2);
  assert.equal(repository.listForJob(job.id, 2, "2026-09-02", NOW).length, 0, "其他用户不可读取");
  const stored = db.prepare("SELECT payload_cipher FROM assistant_interaction_candidates").all() as unknown as Array<{ payload_cipher: string }>;
  assert.equal(stored.some((row) => /整理评审|供应商/.test(row.payload_cipher)), false, "任务摘要必须是密文");
  assert.equal(repository.listForJob(job.id, 1, "2026-09-02", new Date(EXPIRES)).length, 0, "到期即不可读取");
  db.prepare("DELETE FROM context_jobs WHERE id = ?").run(job.id);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM assistant_interaction_runs").get() as { count: number }).count), 0);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM assistant_task_signals").get() as { count: number }).count), 0);
  db.close();
});

test("任务线索投影到会话时始终无结果、未确认且带闭环缺口", () => {
  const projected = candidateToSessionDefaults({
    candidateId: "task:1",
    title: "整理评审数据",
    workSummary: "来自聊天的较长原始摘要不应持久化",
    resultHint: "已完成并形成清单",
    referenceIds: ["ref-1"],
    sourceTypes: ["chat_group"],
    needsConfirmation: [],
    scopeType: "department_daily",
    projectCandidates: [],
    groupKey: "department_daily",
    groupLabel: "部门日常",
    origin: "today",
    confidence: 0.65,
    sourceCompleteness: "complete",
    missingFacts: [],
    workStatus: "completed",
    nextAction: "来自聊天的最新进展不应持久化",
    candidateKind: "task_signal",
    direction: "assigned_to_me",
    priority: "P1",
  });
  assert.equal(projected.resultText, "");
  assert.equal(projected.workSummary, "整理评审数据");
  assert.equal(projected.nextAction, "");
  assert.equal(projected.workStatus, "in_progress");
  assert.equal(projected.employeeConfirmed, false);
  for (const fact of ["task_signal", "today", "result", "status"]) {
    assert.equal(projected.needsConfirmation.includes(fact), true);
  }
});

test("未确认任务线索超过临时上下文 TTL 后从主库硬删除", () => {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "杨楚榛", role: "emp", dept: "研发部" });
  const engine = new ConversationEngine(db, undefined, 1);
  const taskCandidate = {
    candidateId: "task:ttl",
    title: "整理评审数据",
    workSummary: "不应长期保存的聊天原文",
    resultHint: "",
    referenceIds: ["ref-ttl"],
    sourceTypes: ["chat_group"],
    needsConfirmation: ["task_signal"],
    scopeType: "department_daily",
    projectCandidates: [],
    groupKey: "department_daily",
    groupLabel: "部门日常",
    origin: "today",
    confidence: 0.7,
    sourceCompleteness: "complete",
    missingFacts: ["today", "result", "status"],
    candidateKind: "task_signal",
  } as const;
  const session = engine.ensureSession(userId, "2026-09-02", "complete", "job-ttl", [
    taskCandidate,
    { ...taskCandidate, candidateId: "task:deleted", title: "跟进供应商报价", referenceIds: ["ref-deleted"] },
  ], "real_model");
  const sourceMessage = db.prepare(
    `INSERT INTO assistant_messages (session_id, role, kind, content, structured_json, created_at)
     VALUES (?, 'user', 'agent_v2_user', '删除第二项', '{}', ?)`,
  ).run(session.id, "2026-09-02T08:30:00.000Z");
  db.prepare(
    `INSERT INTO assistant_messages
      (session_id, role, kind, content, structured_json, focus_json, tool_trace_json, created_at)
     VALUES (?, 'assistant', 'agent_v2_opening', ?, ?, 'null', ?, ?)`,
  ).run(
    session.id,
    "整理评审数据 ref-ttl；跟进供应商报价 ref-deleted",
    JSON.stringify({ draftProjection: { items: [
      { itemId: "task:ttl", summary: "整理评审数据", referenceIds: ["ref-ttl"] },
      { itemId: "task:deleted", summary: "跟进供应商报价", referenceIds: ["ref-deleted"] },
    ] } }),
    JSON.stringify([{ summary: "跟进供应商报价 ref-deleted" }]),
    "2026-09-02T08:30:01.000Z",
  );
  const legacySnapshot = JSON.stringify({
    outsideWorkAsked: false,
    outsideWorkAnswered: false,
    items: [
      { itemId: "task:ttl", summary: "整理评审数据", referenceIds: ["ref-ttl"] },
      { itemId: "task:deleted", summary: "跟进供应商报价", referenceIds: ["ref-deleted"] },
    ],
  });
  db.prepare(
    `INSERT INTO assistant_changes
      (change_id, session_id, revision, op, before_json, after_json, receipts_json, operations_json,
       source_message_id, created_at)
     VALUES ('legacy-task-copy', ?, 0, 'set_hours', ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    legacySnapshot,
    legacySnapshot,
    JSON.stringify(["跟进供应商报价 ref-deleted"]),
    JSON.stringify([{ op: "delete_item", itemId: "task:deleted", reason: "跟进供应商报价 ref-deleted" }]),
    Number(sourceMessage.lastInsertRowid),
    "2026-09-02T08:30:02.000Z",
  );
  assert.equal(engine.activeTaskSignalCount(userId, "2026-09-02"), 2);
  engine.applyStructured({ ...user(), id: userId }, session.id, [{ type: "delete", itemId: session.items[1].id }]);
  const afterDelete = db.prepare("SELECT COUNT(*) AS count FROM assistant_session_items WHERE session_id = ?")
    .get(session.id) as { count: number };
  assert.equal(afterDelete.count, 1, "用户否定的自动任务应立即硬删除，而不是留在主库");
  const afterDeleteCopies = JSON.stringify({
    messages: db.prepare("SELECT content, structured_json, tool_trace_json FROM assistant_messages WHERE session_id = ?").all(session.id),
    changes: db.prepare("SELECT before_json, after_json, receipts_json, operations_json FROM assistant_changes WHERE session_id = ?").all(session.id),
  });
  assert.doesNotMatch(afterDeleteCopies, /跟进供应商报价|ref-deleted/);
  assert.equal(engine.activeTaskSignalCount(userId, "2026-09-02"), 1);
  db.prepare("UPDATE assistant_session_items SET created_at = ? WHERE session_id = ?")
    .run("2026-09-02T08:00:00.000Z", session.id);
  assert.equal(engine.cleanupExpiredTaskSignals(new Date("2026-09-02T09:00:00.001Z")), 1);
  const count = db.prepare("SELECT COUNT(*) AS count FROM assistant_session_items WHERE session_id = ?")
    .get(session.id) as { count: number };
  assert.equal(count.count, 0);
  const afterTtlCopies = JSON.stringify({
    messages: db.prepare("SELECT content, structured_json, tool_trace_json FROM assistant_messages WHERE session_id = ?").all(session.id),
    changes: db.prepare("SELECT before_json, after_json, receipts_json, operations_json FROM assistant_changes WHERE session_id = ?").all(session.id),
  });
  assert.doesNotMatch(afterTtlCopies, /整理评审数据|ref-ttl|跟进供应商报价|ref-deleted/);
  db.close();
});

test("硬删任务线索后同一 context job 重放不会复活，新 job 仍可投影新候选", () => {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "杨楚榛", role: "emp", dept: "研发部" });
  const engine = new ConversationEngine(db);
  const taskCandidate = {
    candidateId: "task:same-job-deleted",
    title: "不应被同任务复活",
    workSummary: "临时任务摘要",
    resultHint: "",
    referenceIds: ["ref-same-job"],
    sourceTypes: ["chat_group"],
    needsConfirmation: ["task_signal"],
    scopeType: "department_daily",
    projectCandidates: [],
    groupKey: "department_daily",
    groupLabel: "部门日常",
    origin: "today",
    confidence: 0.7,
    sourceCompleteness: "complete",
    missingFacts: ["today", "result", "status"],
    candidateKind: "task_signal",
  } as const;
  let session = engine.ensureSession(userId, "2026-09-02", "complete", "job-stable", [taskCandidate], "real_model");
  engine.applyStructured({ ...user(), id: userId }, session.id, [{ type: "delete", itemId: session.items[0].id }]);

  session = engine.ensureSession(userId, "2026-09-02", "complete", "job-stable", [taskCandidate], "real_model");
  assert.equal(session.items.length, 0, "同一 job 重放相同候选不得绕过硬删除决定");
  assert.equal(Number((db.prepare(
    "SELECT COUNT(*) AS count FROM assistant_session_items WHERE session_id = ?",
  ).get(session.id) as { count: number }).count), 0);

  session = engine.ensureSession(userId, "2026-09-02", "complete", "job-next", [{
    ...taskCandidate,
    candidateId: "task:new-job",
    title: "新任务产生的新候选",
    referenceIds: ["ref-new-job"],
  }], "real_model");
  assert.deepEqual(session.items.map((item) => item.itemKey), ["task:new-job"]);
  db.close();
});

test("上下文 v7 升级 v8 只新增发现表，不让全员现有任务失效", () => {
  const file = join(tmpdir(), `dailylog-context-v8-${randomUUID()}.sqlite`);
  const old = createContextDatabase(file);
  old.exec(`
    DROP TABLE assistant_task_signals;
    DROP TABLE assistant_interaction_candidates;
    DROP TABLE assistant_interaction_runs;
    DELETE FROM context_schema_migrations WHERE version = 8;
  `);
  const jobs = new ContextJobStore(old);
  const current = jobs.createOrReuse(1, "2026-09-02", 12, false, NOW).job;
  old.close();

  const upgraded = createContextDatabase(file);
  const row = upgraded.prepare("SELECT active FROM context_jobs WHERE id = ?").get(current.id) as { active: number };
  assert.equal(row.active, 1);
  assert.deepEqual(listContextMigrations(upgraded).map((item) => item.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  upgraded.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
});
