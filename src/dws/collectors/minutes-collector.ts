import type { ContextCollector } from "../../assistant/schema";
import {
  dayWindow,
  happenedOnWorkDate,
  errorResult,
  normalizeTime,
  payloadFailureCount,
  pickText,
  primaryFailureCode,
  primaryFailureStage,
  projectSignals,
  recordList,
  requiredRecordList,
  runCommand,
  runPaginatedCommand,
  safeLink,
  shorten,
  sourceResult,
  stringList,
} from "./shared";

export const minutesCollector: ContextCollector = {
  source: "minutes",
  async collect(input) {
    try {
      const window = dayWindow(input.workDate);
      const ledger = await runPaginatedCommand(input, (pageIndex, previous) => {
        const cursor = pageIndex === 0 ? "" : pickText(previous, ["result.nextToken", "nextToken", "result.nextCursor", "nextCursor"]);
        if (pageIndex > 0 && !cursor) return null;
        return [
          "minutes", "list", "all", "--start", window.start, "--end", window.end, "--limit", "20",
          ...(cursor ? ["--cursor", cursor] : []),
        ];
      }, { maxPages: 20 });
      const rows = ledger.pages.flatMap((list) => requiredRecordList(
        list,
        ["itemList", "result.itemList", "result.items", "items", "result"],
        "minutes.items",
      )).filter((row) => happenedOnWorkDate(pickText(row, ["startTime", "createTime", "createdAt"]), input.workDate));
      const details = await Promise.allSettled(
        rows.map(async (row) => {
          const id = pickText(row, ["taskUuid", "uuid", "id"]);
          if (!id) {
            throw Object.assign(new Error("schema_error:minutes.id"), {
              safeCode: "schema_error",
              failureStage: "minutes_projection",
            });
          }
          const [summary, todos] = await Promise.allSettled([
            runCommand(input, ["minutes", "get", "summary", "--id", id], 20_000),
            runCommand(input, ["minutes", "get", "todos", "--id", id], 15_000),
          ]);
          return { summary, todos };
        }),
      );
      let failures = ledger.failures;
      const evidences = rows.flatMap((row, index) => {
        const detail = details[index];
        if (detail.status === "rejected") {
          failures += 1;
          return [];
        }
        const summaryPayload = detail.value.summary.status === "fulfilled" ? detail.value.summary.value : null;
        const todoPayload = detail.value.todos.status === "fulfilled" ? detail.value.todos.value : null;
        failures += detail.value.summary.status === "rejected" ? 1 : payloadFailureCount(summaryPayload!);
        failures += detail.value.todos.status === "rejected" ? 1 : payloadFailureCount(todoPayload!);
        const title = pickText(row, ["title", "name", "subject"]) || "会议听记";
        const summary = summaryPayload
          ? pickText(summaryPayload, ["result.summary", "summary", "result.content", "content", "text"])
          : "";
        const todoText = todoPayload ? recordList(todoPayload, ["result.items", "items", "result"])
          .map((todo) => pickText(todo, ["title", "content", "text"]))
          .filter(Boolean)
          .join("；") : "";
        return [{
          sourceType: "minutes" as const,
          externalId: pickText(row, ["taskUuid", "uuid", "id"]),
          title,
          summary: shorten([summary, todoText ? `行动项：${todoText}` : ""].filter(Boolean).join("\n"), 800),
          occurredAt: normalizeTime(pickText(row, ["startTime", "createTime", "createdAt"])),
          actorUserIds: [],
          actorNames: [pickText(row, ["creatorName", "ownerName"])].filter(Boolean),
          participantNames: stringList(row, ["participants", "attendees"]),
          url: safeLink(pickText(row, ["url", "shareUrl", "detailUrl"])),
          privacyScope: "normal" as const,
          projectSignals: projectSignals(title, summary),
          evidenceStrength: summary ? ("medium" as const) : ("weak" as const),
          relationToSelf: "addressed" as const,
          senderKind: "unknown" as const,
          temporalRole: "today" as const,
          workUse: "background_only" as const,
          resultEligible: false,
        }];
      });
      const detailErrors = details.flatMap((detail) => {
        if (detail.status === "rejected") return [detail.reason];
        return [detail.value.summary, detail.value.todos]
          .flatMap((part) => part.status === "rejected" ? [part.reason] : []);
      });
      const errors = [...(ledger.error ? [ledger.error] : []), ...detailErrors];
      return sourceResult("minutes", evidences, {
        failures,
        errorCode: primaryFailureCode(errors),
        hasMore: ledger.hasMore,
        complete: ledger.complete && failures === 0,
        pagesFetched: ledger.pagesFetched,
        itemCount: rows.length,
        stopReason: ledger.stopReason,
        failureStage: primaryFailureStage(errors) ?? "minutes_detail",
      });
    } catch (error) {
      return errorResult("minutes", error);
    }
  },
};
