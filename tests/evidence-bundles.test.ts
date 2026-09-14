import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceWithReference } from "../src/assistant/evidence-store";
import type { CollectedEvidence, EvidenceSourceType } from "../src/assistant/schema";
import { buildChatContextBundles } from "../src/assistant/events/chat-context-builder";
import { buildEvidenceBundles } from "../src/assistant/events/evidence-bundle-builder";

function evidence(
  id: string,
  sourceType: EvidenceSourceType,
  summary: string,
  patch: Partial<CollectedEvidence> = {},
): EvidenceWithReference {
  return {
    referenceId: id,
    expiresAt: "2026-08-25T22:00:00.000Z",
    evidence: {
      sourceType,
      externalId: id,
      title: patch.title ?? "日报助手评审",
      summary,
      occurredAt: patch.occurredAt ?? "2026-08-25T09:00:00+08:00",
      actorUserIds: patch.actorUserIds ?? ["self"],
      actorNames: patch.actorNames ?? ["测试员工"],
      participantNames: patch.participantNames ?? ["测试员工", "评审人"],
      privacyScope: patch.privacyScope ?? "normal",
      projectSignals: patch.projectSignals ?? ["日报助手"],
      evidenceStrength: patch.evidenceStrength ?? "medium",
      relationToSelf: patch.relationToSelf ?? "self",
      senderKind: patch.senderKind ?? "user",
      temporalRole: patch.temporalRole ?? "today",
      workUse: patch.workUse ?? "direct_work",
      sourceCompleteness: patch.sourceCompleteness ?? "complete",
      ...patch,
    },
  };
}

test("reply、thread、引用和相邻他人消息重建为有序聊天上下文", () => {
  const items = [
    evidence("other-request", "chat_group", "请测试员工评审日报助手方案", {
      relationToSelf: "addressed",
      actorUserIds: ["lead"],
      actorNames: ["负责人"],
      conversationId: "conversation-1",
      threadId: "thread-1",
      occurredAt: "2026-08-25T09:00:00+08:00",
    }),
    evidence("self-reply", "chat_group", "我已完成方案评审并补充风险清单", {
      conversationId: "conversation-1",
      threadId: "thread-1",
      replyToMessageId: "other-request",
      occurredAt: "2026-08-25T09:05:00+08:00",
    }),
    evidence("other-confirm", "chat_group", "风险清单已确认，可以进入开发", {
      relationToSelf: "others",
      actorUserIds: ["lead"],
      actorNames: ["负责人"],
      conversationId: "conversation-1",
      quotedMessageId: "self-reply",
      occurredAt: "2026-08-25T09:08:00+08:00",
      workUse: "background_only",
    }),
    evidence("unrelated", "chat_group", "另一项完全无关工作", {
      relationToSelf: "others",
      actorUserIds: ["other"],
      conversationId: "conversation-1",
      occurredAt: "2026-08-25T15:00:00+08:00",
      workUse: "background_only",
    }),
  ];
  const result = buildChatContextBundles(items);
  assert.equal(result.bundles.length, 1);
  assert.deepEqual(result.bundles[0].evidenceIds, ["other-request", "self-reply", "other-confirm"]);
  assert.deepEqual(result.bundles[0].items.map((item) => item.relationToSelf), ["addressed", "self", "others"]);
  assert.deepEqual(result.ignoredEvidence, [{ evidenceId: "unrelated", reason: "insufficient_context" }]);
});

test("聊天、日历、听记、文档和待办按共同对象构建一个跨来源证据包", () => {
  const items = [
    evidence("chat", "chat_group", "确认日报助手评审范围", { conversationId: "conversation-1" }),
    evidence("calendar", "calendar", "召开日报助手方案评审"),
    evidence("minutes", "minutes", "形成评审结论和行动项"),
    evidence("document", "document", "今天更新评审风险清单", { evidenceStrength: "strong" }),
    evidence("todo", "todo", "日报助手评审修改项进行中", { relationToSelf: "addressed" }),
  ];
  const result = buildEvidenceBundles(items);
  assert.equal(result.bundles.length, 1);
  assert.deepEqual(new Set(result.bundles[0].sourceTypes), new Set(["chat_group", "calendar", "minutes", "document", "todo"]));
  assert.deepEqual(new Set(result.includedEvidenceIds), new Set(items.map((item) => item.referenceId)));
  assert.deepEqual(result.ignoredEvidence, []);
});

test("证据包给模型使用正文分析内容，页面摘要仍保持简洁可读", () => {
  const item = evidence("document-analysis", "document", "今天编辑文档《日报助手方案》", {
    title: "日报助手方案",
    analysisTitle: "完善日报助手跨来源融合方案",
    analysisSummary: "文档当前内容显示：完成工作事项去重、证据融合与项目匹配设计。当前正文不代表全部内容均在今天新增。",
  });
  const result = buildEvidenceBundles([item]);
  assert.equal(item.evidence.summary, "今天编辑文档《日报助手方案》");
  assert.equal(result.bundles[0].items[0].title, "完善日报助手跨来源融合方案");
  assert.match(result.bundles[0].items[0].summary, /工作事项去重、证据融合与项目匹配/);
});

test("无关待办和历史内容不会污染工作事项证据包，相关背景仍可并入", () => {
  const items = [
    evidence("anchor", "document", "完成日报助手跨来源融合", { title: "日报助手融合方案", projectSignals: ["日报助手"] }),
    evidence("related-minutes", "minutes", "日报助手融合评审确认项目匹配规则", {
      title: "日报助手融合评审",
      workUse: "background_only",
      relationToSelf: "others",
      projectSignals: ["日报助手"],
    }),
    evidence("unrelated-todo", "todo", "08-17忘记打卡了", {
      title: "08-17忘记打卡了",
      workUse: "background_only",
      relationToSelf: "addressed",
      projectSignals: ["08-17忘记打卡了"],
    }),
    evidence("old-report", "platform_log", "去年完成其他系统部署", {
      title: "其他系统部署",
      temporalRole: "history",
      workUse: "background_only",
      projectSignals: ["其他系统"],
    }),
  ];
  const result = buildEvidenceBundles(items);
  assert.equal(result.bundles.length, 1);
  assert.deepEqual(new Set(result.bundles[0].evidenceIds), new Set(["anchor", "related-minutes"]));
  assert.equal(result.ignoredEvidence.some((item) => item.evidenceId === "unrelated-todo" && item.reason === "background_only"), true);
  assert.equal(result.ignoredEvidence.some((item) => item.evidenceId === "old-report" && item.reason === "background_only"), true);
});

test("每条输入证据必须进入证据包或带明确原因进入忽略账本", () => {
  const items = [
    evidence("work", "document", "完成日报助手 Schema 调整"),
    evidence("noise", "chat_group", "收到", { conversationId: "conversation-1", relationToSelf: "addressed" }),
    evidence("other", "chat_group", "他人独立完成客户报价", {
      conversationId: "conversation-2",
      relationToSelf: "others",
      actorUserIds: ["other"],
      workUse: "background_only",
    }),
    evidence("attendance", "attendance", "部分请假", { workUse: "background_only" }),
  ];
  const result = buildEvidenceBundles(items);
  const accounted = new Set([
    ...result.includedEvidenceIds,
    ...result.ignoredEvidence.map((item) => item.evidenceId),
  ]);
  assert.deepEqual(accounted, new Set(items.map((item) => item.referenceId)));
  assert.deepEqual(result.ignoredEvidence.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)), [
    { evidenceId: "attendance", reason: "background_only" },
    { evidenceId: "noise", reason: "noise" },
    { evidenceId: "other", reason: "insufficient_context" },
  ]);
});
