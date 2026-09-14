import type { CollectedEvidence, ContextCollector, JsonObject } from "../../assistant/schema";
import {
  classifyMessageRelation,
  dayWindow,
  happenedOnWorkDate,
  identifierAliases,
  normalizeTime,
  object,
  pathValue,
  payloadComplete,
  payloadFailureCount,
  payloadHasMore,
  payloadPagesFetched,
  payloadStopReason,
  pickText,
  primaryFailureCode,
  projectSignals,
  requiredRecordList,
  runCommand,
  runPaginatedCommand,
  shorten,
  sourceResult,
} from "./shared";

interface BranchResult {
  evidences: CollectedEvidence[];
  complete: boolean;
  hasMore: boolean;
  failures: number;
  pagesFetched: number;
  stopReason?: string;
}

const LIST_PATHS = ["result.items", "data.items", "data.list", "items", "list", "result"];
const AT_ME_LIST_PATHS = [
  "messages", "result.messages", "data.messages",
  "items", "result.items", "data.items",
  "mentions", "result.mentions", "data.mentions",
  "result",
];

function records(pages: JsonObject[], label: string): JsonObject[] {
  return pages.flatMap((page) => requiredRecordList(page, LIST_PATHS, label));
}

function occurrence(item: JsonObject): string {
  return pickText(item, [
    "finishTime", "completedTime", "completeTime", "operationTime", "operateTime", "taskFinishTime",
    "sendTime", "sentTime", "createTime", "createdAt", "gmtCreate", "gmtModified", "modifiedTime",
    "updateTime", "updatedAt", "time", "timestamp",
  ]);
}

function approvalTitle(item: JsonObject): string {
  return pickText(item, ["processName", "title", "taskName", "name", "formName", "businessName"]) || "审批事项";
}

function approvalEvidence(
  item: JsonObject,
  index: number,
  workDate: string,
  state: "pending" | "executed",
): CollectedEvidence {
  const title = approvalTitle(item);
  const status = pickText(item, ["status", "result", "taskResult", "approveResult", "action"]);
  const rawTime = occurrence(item);
  const occurredAt = normalizeTime(rawTime || `${workDate}T00:00:00+08:00`);
  const externalId = pickText(item, ["taskId", "processInstanceId", "instanceId", "id", "processId"])
    || `oa-${state}-${workDate}-${index}`;
  const people = [
    pickText(item, ["originatorName", "creatorName", "applicantName", "submitterName"]),
    pickText(item, ["actionerName", "handlerName", "approverName"]),
  ].filter(Boolean);
  const actorIds = state === "executed"
    ? identifierAliases(item, ["actioner", "handler", "approver", "actionerUserId", "handlerUserId", "approverUserId"])
    : identifierAliases(item, ["originator", "creator", "applicant", "originatorUserId", "creatorUserId"]);
  return {
    sourceType: "approval",
    externalId,
    title: state === "executed" ? `处理审批：${title}` : `待处理审批：${title}`,
    summary: shorten([
      state === "executed" ? "已处理审批" : "收到待处理审批",
      title,
      status,
    ].filter(Boolean).join("："), 300),
    occurredAt,
    actorUserIds: actorIds,
    actorNames: people,
    participantNames: people,
    privacyScope: "employee_only",
    projectSignals: projectSignals(title),
    evidenceStrength: state === "executed" ? "strong" : "medium",
    relationToSelf: state === "executed" ? "self" : "addressed",
    senderKind: "user",
    temporalRole: "today",
    workUse: state === "executed" ? "direct_work" : "task_signal",
    resultEligible: state === "executed",
    linkedObjectIds: [pickText(item, ["processInstanceId", "instanceId", "taskId"])].filter(Boolean),
  };
}

function nextDingCursor(previous?: JsonObject): string | null {
  if (!previous) return "0";
  const raw = pathValue(previous, "nextCursor")
    ?? pathValue(previous, "result.nextCursor")
    ?? pathValue(previous, "data.nextCursor");
  const cursor = Number(raw);
  return Number.isSafeInteger(cursor) && cursor > 0 ? String(cursor) : null;
}

function dingEvidence(item: JsonObject, index: number, workDate: string, selfUserIds: string[]): CollectedEvidence | null {
  const rawTime = occurrence(item);
  if (!happenedOnWorkDate(rawTime, workDate)) return null;
  const contentValue = pathValue(item, "content");
  const contentObject = object(contentValue);
  const content = typeof contentValue === "string"
    ? contentValue
    : pickText(contentObject, ["text", "content", "title"]);
  const title = pickText(item, ["title", "subject", "dingTitle"])
    || shorten(content, 80)
    || "DING 提醒";
  const senderIds = identifierAliases(item, [
    "sender", "creator", "senderUserId", "creatorUserId", "senderStaffId", "staffId",
    "senderOpenDingTalkId", "senderOpenDingtalkId", "sender.openDingTalkId", "sender.openDingtalkId",
  ]);
  const role = pickText(item, ["direction", "role", "type", "messageType", "sendType"]);
  const selfIds = new Set(selfUserIds.filter(Boolean));
  const sentBySelf = senderIds.some((id) => selfIds.has(id)) || /(?:^|[_-])(send|sent|sender)(?:$|[_-])|已发|发出/i.test(role);
  const people = [
    pickText(item, ["senderName", "creatorName", "fromName"]),
    pickText(item, ["receiverName", "toName"]),
  ].filter(Boolean);
  return {
    sourceType: "ding",
    externalId: pickText(item, ["openDingId", "dingId", "id"]) || `ding-${workDate}-${index}`,
    title: sentBySelf ? `发出 DING：${title}` : `收到 DING：${title}`,
    summary: shorten(content || title, 500),
    occurredAt: normalizeTime(rawTime),
    actorUserIds: sentBySelf ? [...new Set([...selfIds, ...senderIds])] : senderIds,
    actorNames: people,
    participantNames: people,
    privacyScope: "employee_only",
    projectSignals: projectSignals(title),
    evidenceStrength: "medium",
    relationToSelf: sentBySelf ? "self" : "addressed",
    senderKind: "user",
    temporalRole: "today",
    workUse: sentBySelf ? "direct_work" : "task_signal",
    resultEligible: false,
    linkedObjectIds: [pickText(item, ["openDingId", "dingId"])].filter(Boolean),
  };
}

function atMeEvidence(
  item: JsonObject,
  workDate: string,
  selfUserIds: string[],
): CollectedEvidence | null {
  const rawTime = occurrence(item);
  if (!happenedOnWorkDate(rawTime, workDate)) return null;
  const messageId = pickText(item, ["messageId", "openMessageId", "msgId", "id"]);
  const conversationId = pickText(item, ["conversationId", "openConversationId", "chatId"]);
  if (!messageId || !conversationId) return null;
  const contentValue = pathValue(item, "content");
  const contentObject = object(contentValue);
  const content = pickText(item, ["text", "message", "body.text"])
    || (typeof contentValue === "string" ? contentValue : pickText(contentObject, ["text", "content", "title"]));
  if (!content) return null;
  const senderIds = identifierAliases(item, [
    "senderId", "senderUserId", "fromUserId", "creatorUserId",
    "sender.userId", "sender.userid", "sender.staffId", "sender.openDingTalkId",
    "sender.openDingtalkId", "sender.openId", "sender.unionId",
  ]);
  const senderType = pickText(item, ["senderType", "sender.type", "creatorType"]);
  const messageType = pickText(item, ["messageType", "msgType", "type", "contentType"]);
  const senderName = pickText(item, ["senderName", "userName", "creatorName", "fromName", "sender.name", "sender"]);
  const explicitBot = /bot|robot|application|app|system|机器人|系统(?:通知|消息|提醒|助手)|应用(?:通知|消息|提醒|助手)/i
    .test(`${senderType} ${messageType} ${senderName}`);
  if (explicitBot || (senderIds.length === 0 && !senderName)) return null;
  if (senderIds.length > 0) {
    const relation = classifyMessageRelation({
      senderId: senderIds[0],
      senderIds,
      senderType,
      messageType,
      content,
      ddUserid: selfUserIds[0] ?? "",
      selfUserIds,
      atUserIds: selfUserIds,
    });
    if (relation.senderKind !== "user" || relation.relationToSelf === "self") return null;
  }
  // +at-me itself establishes that the message targets the current employee. Its
  // v1.0.59 shortcut projection exposes only a human-readable sender name, so keep
  // actor ids empty when the source did not provide a stable id.
  const conversationType = pickText(item, ["conversationType", "chatType", "scope"]).toLowerCase();
  const privateChat = new Set(["private", "direct", "single", "one_to_one", "one-to-one", "p2p", "1"]).has(conversationType);
  const title = pickText(item, [
    "conversationName", "conversationTitle", "chatName", "groupName", "conversation.name", "conversation",
  ]) || "工作会话";
  return {
    sourceType: privateChat ? "chat_private" : "chat_group",
    externalId: messageId,
    title,
    summary: shorten(content, 600),
    occurredAt: normalizeTime(rawTime),
    actorUserIds: senderIds,
    actorNames: [senderName].filter(Boolean),
    participantNames: [senderName].filter(Boolean),
    privacyScope: privateChat ? "employee_only" : "normal",
    projectSignals: projectSignals(content),
    evidenceStrength: "medium",
    relationToSelf: "addressed",
    senderKind: "user",
    temporalRole: "today",
    workUse: "task_signal",
    resultEligible: false,
    conversationId,
    threadId: pickText(item, ["threadId", "topicId", "conversationThreadId"]) || undefined,
    replyToMessageId: pickText(item, ["replyTo.messageId", "replyToMessageId", "parentMessageId"]) || undefined,
    quotedMessageId: pickText(item, ["quotedMessage.messageId", "quotedMessageId", "quote.messageId"]) || undefined,
  };
}

async function collectPending(input: Parameters<ContextCollector["collect"]>[0]): Promise<BranchResult> {
  const window = dayWindow(input.workDate);
  const paged = await runPaginatedCommand(input, (pageIndex) => [
    "oa", "approval", "list-pending",
    "--start", window.start,
    "--end", window.end,
    "--limit", "100",
    "--page", String(pageIndex + 1),
  ], { maxPages: 10, timeoutMs: 15_000 });
  const evidences = records(paged.pages, "oa.pending")
    .map((item, index) => approvalEvidence(item, index, input.workDate, "pending"));
  return { evidences, ...paged };
}

async function collectExecuted(input: Parameters<ContextCollector["collect"]>[0]): Promise<BranchResult> {
  const paged = await runPaginatedCommand(input, (pageIndex) => [
    "oa", "approval", "list-executed", "--limit", "100", "--page", String(pageIndex + 1),
  ], { maxPages: 10, timeoutMs: 15_000 });
  const evidences = records(paged.pages, "oa.executed")
    .filter((item) => happenedOnWorkDate(occurrence(item), input.workDate))
    .map((item, index) => approvalEvidence(item, index, input.workDate, "executed"));
  return { evidences, ...paged };
}

async function collectDing(input: Parameters<ContextCollector["collect"]>[0]): Promise<BranchResult> {
  const paged = await runPaginatedCommand(input, (_pageIndex, previous) => {
    const cursor = nextDingCursor(previous);
    return cursor === null ? null : ["ding", "message", "list", "--type", "ALL", "--cursor", cursor];
  }, { maxPages: 10, timeoutMs: 15_000 });
  const selfIds = [...new Set([input.ddUserid, ...(input.selfUserIds ?? [])].filter(Boolean))];
  const evidences = records(paged.pages, "ding.messages")
    .map((item, index) => dingEvidence(item, index, input.workDate, selfIds))
    .filter((item): item is CollectedEvidence => Boolean(item));
  return { evidences, ...paged };
}

async function collectAtMe(input: Parameters<ContextCollector["collect"]>[0]): Promise<BranchResult> {
  const payload = await runCommand(input, [
    "chat", "+at-me", "--days", "2", "--page-all", "--page-limit", "50",
  ], 30_000);
  const selfIds = [...new Set([input.ddUserid, ...(input.selfUserIds ?? [])].filter(Boolean))];
  const seen = new Set<string>();
  const evidences = requiredRecordList(payload, AT_ME_LIST_PATHS, "chat.at_me")
    .map((item) => atMeEvidence(item, input.workDate, selfIds))
    .filter((item): item is CollectedEvidence => Boolean(item))
    .filter((item) => {
      const key = `${item.conversationId}:${item.externalId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const failures = payloadFailureCount(payload);
  const hasMore = payloadHasMore(payload);
  const complete = payloadComplete(payload) && failures === 0 && !hasMore;
  return {
    evidences,
    complete,
    hasMore,
    failures,
    pagesFetched: payloadPagesFetched(payload),
    stopReason: complete ? undefined : payloadStopReason(payload) || (hasMore ? "page_limit" : "incomplete_ledger"),
  };
}

/** Optional high-recall source. The orchestrator runs it only for work-discovery pilot users. */
export const workInteractionCollector: ContextCollector = {
  source: "work_interactions",
  async collect(input) {
    const settled = await Promise.allSettled([
      collectPending(input),
      collectExecuted(input),
      collectDing(input),
      collectAtMe(input),
    ]);
    const successes = settled
      .filter((item): item is PromiseFulfilledResult<BranchResult> => item.status === "fulfilled")
      .map((item) => item.value);
    const errors = settled
      .filter((item): item is PromiseRejectedResult => item.status === "rejected")
      .map((item) => item.reason);
    const evidences = successes.flatMap((item) => item.evidences);
    const failures = errors.length + successes.reduce((sum, item) => sum + item.failures, 0);
    const hasMore = successes.some((item) => item.hasMore);
    const complete = errors.length === 0 && successes.every((item) => item.complete);
    const stopReason = errors.length
      ? primaryFailureCode(errors)
      : successes.map((item) => item.stopReason).find(Boolean);
    return sourceResult("work_interactions", evidences, {
      failures,
      errorCode: errors.length ? primaryFailureCode(errors) : undefined,
      allowEmptyPartial: successes.length > 0,
      hasMore,
      complete,
      pagesFetched: successes.reduce((sum, item) => sum + item.pagesFetched, 0),
      itemCount: evidences.length,
      stopReason,
      failureStage: errors.length ? "work_interaction_subsource" : undefined,
    });
  },
};
