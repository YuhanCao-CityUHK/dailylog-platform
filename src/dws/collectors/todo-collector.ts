import type { ContextCollector, JsonObject } from "../../assistant/schema";
import {
  errorResult,
  happenedOnWorkDate,
  normalizeTime,
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
  safeLink,
  shorten,
  sourceResult,
} from "./shared";

function todoEvidence(payload: JsonObject, completed: boolean, workDate: string) {
  return requiredRecordList(
    payload,
    ["data.todos", "todos", "todoCards", "result.todoCards", "result.items", "items", "data.todoCards", "data.items", "result"],
    "todo.items",
  )
    .filter((item) => {
      if (!completed) return true;
      return happenedOnWorkDate(pickText(item, ["finishTime", "completedAt", "modifiedTime"]), workDate);
    })
    .map((item, index) => {
      const title = pickText(item, ["title", "subject", "todoTitle", "todoDetailModel.subject"]) || "待办";
      const description = pickText(item, ["description", "content", "todoDetailModel.description"]);
      const datePaths = completed
        ? ["finishTime", "completedAt", "modifiedTime"]
        : ["dueTime", "planFinishTime", "planFinishDate", "due", "createdAt", "modifiedTime"];
      const dates = datePaths.map((path) => pickText(item, [path])).filter(Boolean);
      const todayDate = dates.find((value) => happenedOnWorkDate(value, workDate));
      return {
        sourceType: "todo" as const,
        externalId: pickText(item, ["id", "taskId", "todoTaskId"]) || `todo-${completed ? "done" : "open"}-${index}`,
        title,
        summary: shorten(`${completed ? "今天标记完成" : "未完成"}${description ? `：${description}` : ""}`, 600),
        occurredAt: normalizeTime(todayDate ?? dates[0] ?? ""),
        actorUserIds: [],
        actorNames: [],
        participantNames: [],
        url: safeLink(pickText(item, ["url", "pcUrl", "mobileUrl", "dingTalkUrl"])),
        privacyScope: "normal" as const,
        projectSignals: projectSignals(title, description),
        evidenceStrength: completed ? ("medium" as const) : ("weak" as const),
        relationToSelf: "addressed" as const,
        senderKind: "unknown" as const,
        temporalRole: "today" as const,
        workUse: todayDate ? ("task_signal" as const) : ("background_only" as const),
        resultEligible: false,
      };
    });
}

export const todoCollector: ContextCollector = {
  source: "todo",
  async collect(input) {
    try {
      const results = await Promise.allSettled([
        runCommand(input, [
          "todo", "+get-my-tasks", "--all", "--max-pages", "40", "--size", "20",
          "--status", "false", "--role-types", "executor",
        ]),
        runCommand(input, [
          "todo", "+get-my-tasks", "--all", "--max-pages", "40", "--size", "20",
          "--status", "true", "--role-types", "executor",
        ]),
      ]);
      const successes = results.filter((result): result is PromiseFulfilledResult<JsonObject> => result.status === "fulfilled");
      if (successes.length === 0) return errorResult("todo", (results[0] as PromiseRejectedResult).reason);
      const open = results[0].status === "fulfilled" ? todoEvidence(results[0].value, false, input.workDate) : [];
      const completed = results[1].status === "fulfilled" ? todoEvidence(results[1].value, true, input.workDate) : [];
      const hasMore = successes.some((result) => payloadHasMore(result.value));
      const ledgerFailures = successes.reduce((sum, result) => sum + payloadFailureCount(result.value), 0);
      const ledgerStopReason = successes.map((result) => payloadStopReason(result.value)).find(Boolean);
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      const complete = successes.length === results.length && successes.every((result) => payloadComplete(result.value));
      return sourceResult("todo", [...open, ...completed], {
        failures: results.length - successes.length + ledgerFailures,
        errorCode: primaryFailureCode(errors),
        hasMore,
        complete,
        pagesFetched: successes.reduce((sum, result) => sum + payloadPagesFetched(result.value), 0),
        itemCount: open.length + completed.length,
        stopReason: hasMore ? "page_limit" : ledgerStopReason,
        failureStage: "todo_list",
      });
    } catch (error) {
      return errorResult("todo", error);
    }
  },
};
