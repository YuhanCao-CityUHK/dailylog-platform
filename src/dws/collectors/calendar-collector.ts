import type { ContextCollector } from "../../assistant/schema";
import {
  dayWindow,
  happenedOnWorkDate,
  errorResult,
  normalizeTime,
  pickText,
  primaryFailureCode,
  primaryFailureStage,
  projectSignals,
  requiredRecordList,
  runPaginatedCommand,
  safeLink,
  shorten,
  sourceResult,
  stringList,
} from "./shared";

export const calendarCollector: ContextCollector = {
  source: "calendar",
  async collect(input) {
    try {
      const window = dayWindow(input.workDate);
      const ledger = await runPaginatedCommand(input, (pageIndex, previous) => {
        const cursor = pageIndex === 0 ? "" : pickText(previous, ["result.nextCursor", "nextCursor", "data.nextCursor"]);
        if (pageIndex > 0 && !cursor) return null;
        return [
          "calendar", "event", "list", "--start", window.start, "--end", window.end, "--limit", "100",
          ...(cursor ? ["--cursor", cursor] : []),
        ];
      }, { maxPages: 20 });
      const rows = ledger.pages.flatMap((payload) => requiredRecordList(
        payload,
        ["result.events", "events", "result.items", "items", "data.events", "data.items", "result"],
        "calendar.events",
      ));
      const evidences = rows
        .filter((item) => happenedOnWorkDate(pickText(item, ["startTime", "start.dateTime", "beginTime"]), input.workDate))
        .filter((item) => !/cancel|取消/i.test(pickText(item, ["status", "eventStatus"])))
        .filter((item) => {
          const start = Date.parse(normalizeTime(pickText(item, ["startTime", "start.dateTime", "beginTime"])));
          return !Number.isFinite(start) || start <= input.now.getTime();
        })
        .map((item, index) => {
          const title = pickText(item, ["summary", "title", "subject"]) || "日程";
          const description = pickText(item, ["description", "content", "location"]);
          return {
            sourceType: "calendar" as const,
            externalId: pickText(item, ["eventId", "id"]) || `calendar-${index}`,
            title,
            summary: shorten(description || "今天已发生或正在进行的日程", 500),
            occurredAt: normalizeTime(pickText(item, ["startTime", "start.dateTime", "beginTime"])),
            actorUserIds: [],
            actorNames: [pickText(item, ["organizer.displayName", "organizerName"])].filter(Boolean),
            participantNames: stringList(item, ["attendees", "participants"]),
            url: safeLink(pickText(item, ["url", "meetingUrl", "dingTalkUrl"])),
            privacyScope: "normal" as const,
            projectSignals: projectSignals(title, description),
            evidenceStrength: "weak" as const,
            relationToSelf: "addressed" as const,
            senderKind: "unknown" as const,
            temporalRole: "today" as const,
            workUse: "background_only" as const,
            resultEligible: false,
          };
        });
      return sourceResult("calendar", evidences, {
        failures: ledger.failures,
        errorCode: primaryFailureCode(ledger.error ? [ledger.error] : []),
        hasMore: ledger.hasMore,
        complete: ledger.complete,
        pagesFetched: ledger.pagesFetched,
        itemCount: rows.length,
        stopReason: ledger.stopReason,
        failureStage: primaryFailureStage(ledger.error ? [ledger.error] : []) ?? "calendar_list",
      });
    } catch (error) {
      return errorResult("calendar", error);
    }
  },
};
