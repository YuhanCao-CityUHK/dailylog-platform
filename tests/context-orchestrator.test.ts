import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { createContextDatabase } from "../src/assistant/context-db";
import { ContextJobStore } from "../src/assistant/context-jobs";
import { ContextOrchestrator } from "../src/assistant/context-orchestrator";
import { EvidenceStore } from "../src/assistant/evidence-store";
import type { ContextCollector } from "../src/assistant/schema";

const user: SessionUser = {
  id: 11,
  kind: "dingtalk",
  ddUserid: "user-11",
  name: "测试员工",
  title: "",
  dept: "研发部",
  role: "emp",
  isExternal: false,
  mustChangePw: false,
};

function runtime(collectors: ContextCollector[], state: "connected" | "identity_mismatch" | "unavailable" = "connected") {
  const db = createContextDatabase(":memory:");
  const jobStore = new ContextJobStore(db);
  const evidenceStore = new EvidenceStore(db, Buffer.alloc(32, 9));
  const orchestrator = new ContextOrchestrator({
    jobStore,
    evidenceStore,
    collectors,
    ttlHours: 12,
    jobConcurrency: 2,
    connectionInspector: async () =>
      state === "connected"
        ? { enabled: true, available: true, connected: true, state: "connected", profile: "corp:user-11" }
        : { enabled: true, available: state !== "unavailable", connected: false, state },
    dwsJsonRunner: async () => ({}),
  });
  return { db, jobStore, evidenceStore, orchestrator };
}

test("进程重启后恢复遗留 running 任务，当前进程中的任务仍只运行一次", async () => {
  let calls = 0;
  const { db, jobStore, orchestrator } = runtime([{
    source: "chat", async collect() { calls += 1; return { source: "chat", status: "empty", evidences: [] }; },
  }]);
  const interrupted = jobStore.createOrReuse(user.id, "2026-09-07", 12, false).job;
  jobStore.markRunning(interrupted.id);
  const resumed = orchestrator.start(user, "2026-09-07");
  assert.notEqual(resumed.id, interrupted.id);
  const duplicate = orchestrator.start(user, "2026-09-07");
  assert.equal(duplicate.id, resumed.id);
  await orchestrator.waitForIdle(resumed.id);
  assert.equal(calls, 1);
  assert.equal(orchestrator.get(user.id, "2026-09-07")?.status, "manual");
  db.close();
});

test("单来源失败降级为 partial，已有证据和 Reference 仍可使用", async () => {
  const okCollector: ContextCollector = {
    source: "chat",
    async collect() {
      return {
        source: "chat",
        status: "complete",
        evidences: [{
          sourceType: "chat_group",
          externalId: "message-1",
          title: "日报项目",
          summary: "完成上下文编排",
          occurredAt: "2026-08-25T09:00:00+08:00",
          actorUserIds: ["user-11"],
          actorNames: ["测试员工"],
          participantNames: [],
          privacyScope: "normal",
          projectSignals: ["日报项目"],
          evidenceStrength: "medium",
        }],
      };
    },
  };
  const failedCollector: ContextCollector = {
    source: "document",
    async collect() {
      return { source: "document", status: "error", evidences: [], errorCode: "timeout" };
    },
  };
  const { db, orchestrator } = runtime([okCollector, failedCollector]);
  const job = orchestrator.start(user, "2026-08-25");
  await orchestrator.waitForIdle(job.id);
  const finished = orchestrator.get(user.id, "2026-08-25");
  assert.equal(finished?.status, "partial");
  assert.equal(finished?.completeness, "partial");
  assert.equal(finished?.sources.find((source) => source.source === "document")?.errorCode, "timeout");
  const references = orchestrator.references(job.id, user.id);
  assert.equal(references.length, 1);
  assert.equal(orchestrator.reference(references[0].referenceId, user.id)?.summary, "完成上下文编排");
  assert.equal(orchestrator.reference(references[0].referenceId, 99), null);
  db.close();
});

test("身份不匹配时停止全部采集并进入手工模式", async () => {
  let calls = 0;
  const collector: ContextCollector = {
    source: "chat",
    async collect() {
      calls += 1;
      return { source: "chat", status: "empty", evidences: [] };
    },
  };
  const { db, orchestrator } = runtime([collector], "identity_mismatch");
  const job = orchestrator.start(user, "2026-08-25");
  await orchestrator.waitForIdle(job.id);
  const finished = orchestrator.get(user.id, "2026-08-25");
  assert.equal(calls, 0);
  assert.equal(finished?.status, "manual");
  assert.equal(finished?.errorCode, "identity_mismatch");
  assert.equal(finished?.sources[0].errorCode, "identity_mismatch");
  db.close();
});

test("DWS 不可用时仍采集平台日志并降级", async () => {
  let dwsCalls = 0;
  const dwsCollector: ContextCollector = {
    source: "todo",
    async collect() {
      dwsCalls += 1;
      return { source: "todo", status: "empty", evidences: [] };
    },
  };
  const platformCollector: ContextCollector = {
    source: "platform_log",
    async collect() {
      return {
        source: "platform_log",
        status: "complete",
        evidences: [{
          sourceType: "platform_log",
          externalId: "platform-1",
          title: "昨日计划",
          summary: "今天继续开发日报助手",
          occurredAt: "2026-08-22T12:00:00+08:00",
          actorUserIds: ["user-11"],
          actorNames: [],
          participantNames: [],
          privacyScope: "employee_only",
          projectSignals: [],
          evidenceStrength: "strong",
        }],
      };
    },
  };
  const { db, orchestrator } = runtime([dwsCollector, platformCollector], "unavailable");
  const job = orchestrator.start(user, "2026-08-25");
  await orchestrator.waitForIdle(job.id);
  assert.equal(dwsCalls, 0);
  assert.equal(orchestrator.get(user.id, "2026-08-25")?.status, "partial");
  assert.equal(orchestrator.references(job.id, user.id).length, 1);
  db.close();
});

test("重新整理创建独立任务，并保持去重后的 evidence 与 Reference 数量一致", async () => {
  const evidence = {
    sourceType: "chat_group" as const,
    externalId: "message-stable",
    title: "上下文刷新",
    summary: "相同证据不重复计数",
    occurredAt: "2026-08-25T09:00:00+08:00",
    actorUserIds: ["user-11"],
    actorNames: ["测试员工"],
    participantNames: [],
    privacyScope: "normal" as const,
    projectSignals: [],
    evidenceStrength: "medium" as const,
  };
  const collector: ContextCollector = {
    source: "chat",
    async collect() {
      return { source: "chat", status: "complete", evidences: [evidence, evidence] };
    },
  };
  const { db, orchestrator } = runtime([collector]);
  const first = orchestrator.start(user, "2026-08-25", false, new Date("2026-08-25T08:00:00Z"));
  await orchestrator.waitForIdle(first.id);
  assert.equal(orchestrator.get(user.id, "2026-08-25", new Date("2026-08-25T08:00:30Z"))?.sources[0].itemCount, 1);
  assert.equal(orchestrator.references(first.id, user.id, new Date("2026-08-25T08:00:30Z")).length, 1);

  const refreshed = orchestrator.start(user, "2026-08-25", true, new Date("2026-08-25T08:01:00Z"));
  assert.notEqual(refreshed.id, first.id);
  assert.equal(refreshed.refreshCount, 1);
  await orchestrator.waitForIdle(refreshed.id);
  const second = orchestrator.get(user.id, "2026-08-25", new Date("2026-08-25T08:01:30Z"));
  assert.equal(second?.id, refreshed.id);
  assert.equal(second?.sources[0].itemCount, 1);
  assert.equal(orchestrator.references(refreshed.id, user.id, new Date("2026-08-25T08:01:30Z")).length, 1);
  assert.equal(orchestrator.references(first.id, user.id, new Date("2026-08-25T08:01:30Z")).length, 0);
  const counts = db.prepare("SELECT COUNT(*) AS evidence_count FROM context_evidences").get() as { evidence_count: number };
  assert.equal(counts.evidence_count, 1);
  db.close();
});
