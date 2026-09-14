import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { LegacyCandidateService } from "../src/assistant/candidate-service";
import { createContextDatabase } from "../src/assistant/context-db";
import { ContextJobStore } from "../src/assistant/context-jobs";
import { ContextOrchestrator } from "../src/assistant/context-orchestrator";
import { applyEvidenceEligibility } from "../src/assistant/evidence-eligibility";
import { EvidenceStore, type EvidenceWithReference } from "../src/assistant/evidence-store";
import type { CollectedEvidence, ContextCollector } from "../src/assistant/schema";
import { addUser, createMigratedFixtureDb } from "./helpers";

function wrapped(id: string, relation: CollectedEvidence["relationToSelf"], groupMemberCount = 5): EvidenceWithReference {
  return {
    referenceId: `ref-${id}`,
    expiresAt: "2026-08-25T20:00:00.000Z",
    evidence: {
      sourceType: "chat_group",
      externalId: id,
      title: `群聊 ${id}`,
      summary: `完成 ${id} 工作`,
      occurredAt: "2026-08-25T09:00:00+08:00",
      actorUserIds: ["other-user"],
      actorNames: ["其他员工"],
      participantNames: Array.from({ length: groupMemberCount }, (_, index) => `成员${index}`),
      privacyScope: "normal",
      projectSignals: ["工作日志平台"],
      evidenceStrength: "medium",
      relationToSelf: relation,
      senderKind: relation === "bot_or_unknown" ? "bot" : "user",
      groupMemberCount,
    },
  };
}

test("资格闸门区分可成项、背景、大群项目信号和丢弃证据", () => {
  const result = applyEvidenceEligibility([
    wrapped("self", "self"),
    wrapped("addressed", "addressed"),
    wrapped("others-small", "others"),
    wrapped("others-large", "others", 27),
    wrapped("bot", "bot_or_unknown", 27),
  ], { ddUserid: "self-user" }, 20);
  assert.deepEqual(result.candidateEvidence.map((item) => item.evidence.externalId), ["self", "addressed"]);
  assert.deepEqual(result.backgroundEvidence.map((item) => item.evidence.externalId), ["others-small", "others-large"]);
  assert.deepEqual(result.backgroundEvidence[0].evidence.projectSignals, ["工作日志平台"]);
  assert.deepEqual(result.backgroundEvidence[1].evidence.projectSignals, []);
  assert.deepEqual(result.discardedEvidence.map((item) => item.evidence.externalId), ["bot"]);
});

test("27 人群机器人播报不落 Reference、不成项；他人只作背景，@本人和本人消息可成项", async () => {
  const platformDb = createMigratedFixtureDb();
  const userId = addUser(platformDb, { name: "测试员工", role: "lead", dept: "研发部" });
  const user: SessionUser = {
    id: userId,
    kind: "dingtalk",
    ddUserid: "self-user",
    name: "测试员工",
    title: "",
    dept: "研发部",
    role: "lead",
    isExternal: false,
    mustChangePw: false,
  };
  const contextDb = createContextDatabase(":memory:");
  const jobStore = new ContextJobStore(contextDb);
  const evidenceStore = new EvidenceStore(contextDb, Buffer.alloc(32, 12));
  const members = Array.from({ length: 27 }, (_, index) => `成员${index}`);
  const collector: ContextCollector = {
    source: "chat",
    async collect() {
      const base = {
        sourceType: "chat_group" as const,
        occurredAt: "2026-08-25T09:00:00+08:00",
        actorNames: [] as string[],
        participantNames: members,
        privacyScope: "normal" as const,
        evidenceStrength: "medium" as const,
        groupMemberCount: 27,
      };
      return { source: "chat", status: "complete", evidences: [
        { ...base, externalId: "bot", title: "日报机器人", summary: "日报缺交名单：张三、李四", actorUserIds: ["robot"], projectSignals: ["日报"], relationToSelf: "bot_or_unknown", senderKind: "bot" },
        { ...base, externalId: "others", title: "客户报价", summary: "完成客户报价修订", actorUserIds: ["other"], projectSignals: ["客户报价"], relationToSelf: "others", senderKind: "user" },
        { ...base, externalId: "addressed", title: "接口联调", summary: "@测试员工 完成接口联调并形成结论", actorUserIds: ["lead"], projectSignals: ["接口联调"], relationToSelf: "addressed", senderKind: "user" },
        { ...base, externalId: "self", title: "回归验证", summary: "完成日报助手回归验证", actorUserIds: ["self-user"], projectSignals: ["回归验证"], relationToSelf: "self", senderKind: "user" },
      ] };
    },
  };
  const orchestrator = new ContextOrchestrator({
    jobStore,
    evidenceStore,
    collectors: [collector],
    connectionInspector: async () => ({ enabled: true, available: true, connected: true, state: "connected", profile: "corp:self-user" }),
    dwsJsonRunner: async () => ({}),
  });
  const job = orchestrator.start(user, "2026-08-25", false, new Date("2026-08-25T08:00:00Z"));
  await orchestrator.waitForIdle(job.id);
  const references = orchestrator.references(job.id, user.id, new Date("2026-08-25T08:01:00Z"));
  assert.equal(references.some((reference) => reference.summary.includes("日报缺交名单")), false);
  assert.equal(references.length, 3, "others 仍保留为背景 Reference，机器人必须在落库前丢弃");

  const { candidates } = await new LegacyCandidateService(evidenceStore, platformDb).build(
    user,
    job.id,
    "2026-08-25",
    new Date("2026-08-25T08:01:00Z"),
  );
  const candidateText = candidates.map((candidate) => `${candidate.title} ${candidate.resultHint}`).join("\n");
  assert.match(candidateText, /接口联调/);
  assert.match(candidateText, /回归验证/);
  assert.doesNotMatch(candidateText, /缺交名单|客户报价/);
  contextDb.close();
  platformDb.close();
});
