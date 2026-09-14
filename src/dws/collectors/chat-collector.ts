import type { ChatConversationLedger, ContextCollector, JsonObject } from "../../assistant/schema";
import {
  classifyMessageRelation,
  dayWindow,
  errorResult,
  happenedOnWorkDate,
  identifierAliases,
  listSize,
  normalizeTime,
  payloadComplete,
  payloadFailureCount,
  payloadHasMore,
  payloadPagesFetched,
  payloadStopReason,
  pathValue,
  pickText,
  primaryFailureCode,
  projectSignals,
  requiredRecordList,
  runCommand,
  runPaginatedCommand,
  safeLink,
  shorten,
  sourceResult,
  stringList,
} from "./shared";

interface ConversationTarget {
  conversation: JsonObject;
  conversationId: string;
  conversationType: "group" | "private";
  args: string[];
}

function conversationTarget(conversation: JsonObject, index: number): ConversationTarget {
  const id = pickText(conversation, ["openConversationId", "conversationId", "chatId", "id"]);
  const type = pickText(conversation, ["type", "conversationType", "chatType"]).toLowerCase();
  const peerUserId = pickText(conversation, ["peerUserId", "peer.userId", "userId"]);
  const peerOpenDingTalkId = pickText(conversation, [
    "peerOpenDingTalkId", "peerOpenDingtalkId",
    "peer.openDingTalkId", "peer.openDingtalkId",
    "openDingTalkId", "openDingtalkId",
  ]);
  const privateChat = pathValue(conversation, "singleChat") === true
    || new Set(["private", "direct", "single", "one_to_one", "one-to-one", "p2p", "1"]).has(type);
  const args = privateChat
    ? peerUserId
      ? ["--user", peerUserId]
      : peerOpenDingTalkId
        ? ["--open-dingtalk-id", peerOpenDingTalkId]
        : id
          ? ["--group", id]
          : []
    : id
      ? ["--group", id]
      : [];
  const peerId = peerUserId || peerOpenDingTalkId;
  return {
    conversation,
    conversationId: id || (peerId ? `private:${peerId}` : `unknown:${index}`),
    conversationType: privateChat ? "private" : "group",
    args,
  };
}

function nextConversationCursor(previous?: JsonObject): string | null {
  if (!previous) return "0";
  const raw = pathValue(previous, "result.nextCursor")
    ?? pathValue(previous, "nextCursor")
    ?? pathValue(previous, "data.nextCursor");
  const cursor = Number(raw);
  return Number.isSafeInteger(cursor) && cursor > 0 ? String(cursor) : null;
}

function resourceRefs(message: JsonObject, content: string): string[] {
  const refs = new Set<string>();
  for (const value of [
    pickText(message, ["url", "messageUrl", "dingTalkUrl"]),
    ...Array.from(content.matchAll(/(?:https?:\/\/|dingtalk:\/\/)[^\s<>()\]]+/gi), (match) => match[0]),
  ]) {
    const link = safeLink(value);
    if (link) refs.add(link);
  }
  return [...refs];
}

function linkedObjectIds(message: JsonObject): string[] {
  return [...new Set([
    pickText(message, ["documentId", "docId", "nodeId", "content.documentId"]),
    pickText(message, ["taskId", "todoTaskId", "content.taskId"]),
    pickText(message, ["meetingId", "calendarEventId", "content.meetingId"]),
  ].filter(Boolean))];
}

function deduplicateMessages(messages: JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = pickText(message, ["messageId", "msgId", "id"])
      || JSON.stringify([
        pickText(message, ["sendTime", "createTime", "createdAt", "timestamp"]),
        identifierAliases(message, [
          "senderUserId", "senderId", "sender.userId", "sender.userid", "senderStaffId",
          "sender.staffId", "sender.openDingTalkId", "sender.openDingtalkId", "sender.openId", "sender.unionId",
          "senderOpenDingTalkId", "senderOpenDingtalkId", "fromUserId", "creatorUserId",
        ]).join("|"),
        pickText(message, ["text", "content.text", "content", "message", "body.text"]),
      ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function failureStopReason(error: unknown): string {
  const code = primaryFailureCode([error]);
  if (code === "rate_limited") return "rate_limited";
  if (code === "timeout") return "timeout";
  if (code === "schema_error") return "schema_error";
  return "request_failed";
}

function failedPages(payload: JsonObject): number[] {
  const failures = Array.isArray(payload.failures) ? payload.failures : [];
  return [...new Set(failures
    .map((failure) => Number((failure as { page?: unknown })?.page))
    .filter((page) => Number.isInteger(page) && page > 0))];
}

export const chatCollector: ContextCollector = {
  source: "chat",
  async collect(input) {
    try {
      const conversationPages = await runPaginatedCommand(input, (_pageIndex, previous) => {
        const cursor = nextConversationCursor(previous);
        return cursor === null
          ? null
          : ["chat", "list-all-conversations", "--limit", "100", "--cursor", cursor];
      }, { maxPages: 50, timeoutMs: 30_000 });
      const seenConversations = new Set<string>();
      const conversations = conversationPages.pages
        .flatMap((page) => requiredRecordList(
          page,
          ["result.conversations", "conversations", "result.items", "items", "data.items"],
          "chat.conversations",
        ))
        .map(conversationTarget)
        .filter((target) => {
          if (seenConversations.has(target.conversationId)) return false;
          seenConversations.add(target.conversationId);
          return true;
        });
      const window = dayWindow(input.workDate);
      const details = await Promise.allSettled(
        conversations.map((target) => target.args.length > 0
          ? runCommand(input, [
              "chat", "+chat-messages", ...target.args,
              "--start", window.start,
              "--end", window.end,
              "--order", "asc",
              "--page-all",
              "--page-limit", "50",
            ], 60_000)
          : Promise.reject(Object.assign(new Error("schema_error:chat.target"), {
              safeCode: "schema_error",
              failureStage: "conversation_projection",
            }))),
      );

      let failures = conversationPages.failures;
      let hasMore = conversationPages.hasMore;
      let pagesFetched = conversationPages.pagesFetched;
      const ledgers: ChatConversationLedger[] = [];
      const evidences = conversations.flatMap((target, index) => {
        const detail = details[index];
        if (detail.status === "rejected") {
          failures += 1;
          ledgers.push({
            kind: "chat_conversation",
            conversationId: target.conversationId,
            conversationType: target.conversationType,
            pagesFetched: 0,
            messagesFetched: 0,
            complete: false,
            hasMore: false,
            stopReason: failureStopReason(detail.reason),
            failures: 1,
            failedPages: [],
          });
          return [];
        }

        const detailFailures = payloadFailureCount(detail.value);
        const detailHasMore = payloadHasMore(detail.value);
        const detailComplete = payloadComplete(detail.value) && detailFailures === 0 && !detailHasMore;
        const detailPages = payloadPagesFetched(detail.value);
        const detailStopReason = detailComplete
          ? undefined
          : payloadStopReason(detail.value) || (detailHasMore ? "page_limit" : "incomplete_ledger");
        failures += detailFailures;
        hasMore ||= detailHasMore;
        pagesFetched += detailPages;

        const messages = deduplicateMessages(requiredRecordList(
          detail.value,
          ["messages", "result.items", "items", "data.items", "result"],
          "chat.messages",
        ).filter((message) => happenedOnWorkDate(
          pickText(message, ["sendTime", "createTime", "createdAt", "timestamp"]),
          input.workDate,
        ))).sort((a, b) => Date.parse(normalizeTime(pickText(a, ["sendTime", "createTime", "createdAt", "timestamp"])))
          - Date.parse(normalizeTime(pickText(b, ["sendTime", "createTime", "createdAt", "timestamp"]))));

        ledgers.push({
          kind: "chat_conversation",
          conversationId: target.conversationId,
          conversationType: target.conversationType,
          pagesFetched: detailPages,
          messagesFetched: messages.length,
          complete: detailComplete,
          hasMore: detailHasMore,
          stopReason: detailStopReason,
          failures: detailFailures,
          failedPages: failedPages(detail.value),
        });

        const title = pickText(target.conversation, ["conversationName", "title", "name", "conversationTitle"]) || "工作会话";
        return messages.map((message, messageIndex) => {
          const occurredAt = normalizeTime(pickText(message, ["sendTime", "createTime", "createdAt", "timestamp"]));
          const content = pickText(message, ["text", "content.text", "content", "message", "body.text"]);
          const senderName = pickText(message, ["senderName", "userName", "creatorName", "sender.name", "sender"]);
          const senderIds = identifierAliases(message, [
            "senderUserId", "senderId", "sender.userId", "sender.userid", "senderStaffId",
            "sender.staffId", "sender.openDingTalkId", "sender.openDingtalkId", "sender.openId", "sender.unionId",
            "senderOpenDingTalkId", "senderOpenDingtalkId", "fromUserId", "creatorUserId",
          ]);
          const senderId = senderIds.find((value) => [input.ddUserid, ...(input.selfUserIds ?? [])].includes(value))
            ?? senderIds[0]
            ?? "";
          const atUserIds = identifierAliases(message, ["atUsers", "atUserIds", "content.atUsers", "mentions"]);
          const assigneeUserIds = identifierAliases(message, [
            "assigneeUserIds", "assignees", "executorUserIds", "executors",
            "task.assigneeUserIds", "task.assignees", "content.assigneeUserIds",
          ]);
          const repliedUserIds = identifierAliases(message, [
            "replyTo.senderId", "replyTo.senderUserId", "replyTo.sender.staffId", "replyTo.sender.openDingTalkId", "replyTo.sender.openId",
            "quote.senderId", "quote.senderUserId", "quote.sender.openDingTalkId",
            "quotedMessage.senderId", "quotedMessage.senderUserId", "quotedMessage.sender.openDingTalkId",
            "parentMessage.senderId", "parentMessage.senderUserId", "parentMessage.sender.openDingTalkId",
            "inReplyTo.senderId", "inReplyTo.senderUserId", "inReplyTo.sender.openDingTalkId",
          ]);
          const relation = classifyMessageRelation({
            senderId,
            senderIds,
            senderType: pickText(message, ["senderType", "sender.type", "creatorType"]),
            messageType: pickText(message, ["messageType", "msgType", "type", "contentType"]),
            content,
            ddUserid: input.ddUserid,
            selfUserIds: input.selfUserIds,
            displayName: input.displayName,
            atUserIds,
            assigneeUserIds,
            repliedUserIds,
          });
          // A human message in a one-to-one conversation is addressed to the current
          // employee by topology. The model still decides whether it is actual work;
          // requiring a small verb dictionary here caused terse follow-ups to vanish.
          const privateTask = target.conversationType === "private"
            && relation.relationToSelf === "others"
            && relation.senderKind === "user";
          const effectiveRelation = privateTask
            ? { relationToSelf: "addressed" as const, senderKind: relation.senderKind }
            : relation;
          const workUse = effectiveRelation.relationToSelf === "self"
            ? ("direct_work" as const)
            : effectiveRelation.relationToSelf === "addressed"
              ? ("task_signal" as const)
              : ("background_only" as const);
          const refs = resourceRefs(message, content);
          return {
            sourceType: target.conversationType === "private" ? ("chat_private" as const) : ("chat_group" as const),
            externalId: pickText(message, ["messageId", "msgId", "id"]) || `${target.conversationId}-${messageIndex}`,
            title,
            summary: shorten(content, 600),
            occurredAt,
            actorUserIds: senderIds,
            actorNames: [senderName].filter(Boolean),
            participantNames: stringList(target.conversation, ["members", "participants"]),
            url: refs[0],
            privacyScope: target.conversationType === "private" ? ("employee_only" as const) : ("normal" as const),
            projectSignals: projectSignals(content),
            evidenceStrength: "medium" as const,
            ...effectiveRelation,
            groupMemberCount: target.conversationType === "private" ? 2 : listSize(target.conversation, ["members", "participants"]),
            conversationId: target.conversationId,
            threadId: pickText(message, ["threadId", "topicId", "conversationThreadId"]) || undefined,
            replyToMessageId: pickText(message, ["replyTo.messageId", "replyToMessageId", "parentMessageId", "inReplyTo.messageId"]) || undefined,
            quotedMessageId: pickText(message, ["quote.messageId", "quotedMessage.messageId", "quotedMessageId"]) || undefined,
            resourceRefs: refs,
            linkedObjectIds: linkedObjectIds(message),
            sourceCompleteness: detailComplete ? ("complete" as const) : ("partial" as const),
            temporalRole: "today" as const,
            workUse,
            resultEligible: effectiveRelation.relationToSelf === "self",
          };
        }).filter((evidence) => evidence.summary);
      });

      const listComplete = conversationPages.complete && conversationPages.failures === 0 && !conversationPages.hasMore;
      const complete = listComplete && ledgers.every((ledger) => ledger.complete);
      const stopReason = complete
        ? undefined
        : conversationPages.stopReason
          || (conversationPages.hasMore ? "page_limit" : undefined)
          || ledgers.find((ledger) => !ledger.complete)?.stopReason
          || "incomplete_ledger";
      const detailErrors = details.flatMap((detail) => detail.status === "rejected" ? [detail.reason] : []);
      return sourceResult("chat", evidences, {
        failures,
        errorCode: primaryFailureCode([
          ...(conversationPages.error === undefined ? [] : [conversationPages.error]),
          ...detailErrors,
        ]),
        hasMore,
        complete,
        pagesFetched,
        itemCount: ledgers.reduce((sum, ledger) => sum + ledger.messagesFetched, 0),
        stopReason,
        failureStage: "conversation_or_message",
        details: ledgers,
      });
    } catch (error) {
      return errorResult("chat", error);
    }
  },
};
