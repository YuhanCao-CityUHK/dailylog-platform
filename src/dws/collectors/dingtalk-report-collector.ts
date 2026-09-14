import type { CollectedEvidence, ContextCollector } from "../../assistant/schema";
import {
  extractContinuationHints,
  reportReferenceSummary,
  type HistoricalReportField,
} from "../../assistant/historical-report-parser";
import {
  errorResult,
  normalizeTime,
  pickText,
  primaryFailureCode,
  primaryFailureStage,
  projectSignals,
  recordList,
  requiredRecordList,
  runPaginatedCommand,
  safeLink,
  shorten,
  sourceResult,
} from "./shared";

function reportFields(payload: Record<string, unknown>): HistoricalReportField[] {
  const fields = recordList(payload, ["result.report_content", "result.reportContent", "report_content"]);
  if (fields.length > 0) {
    return fields
      .map((field) => {
        const key = pickText(field, ["key", "name", "fieldName"]);
        const value = pickText(field, ["value", "content", "text"]);
        return { key, value };
      })
      .filter((field) => Boolean(field.value));
  }
  const fallback = pickText(payload, [
    "result.content",
    "result.summary",
    "content",
    "summary",
    "text",
    "日志内容",
  ]);
  return fallback ? [{ key: "", value: fallback }] : [];
}

export const dingtalkReportCollector: ContextCollector = {
  source: "dingtalk_report",
  async collect(input) {
    try {
      const dates = input.historyWorkDates.slice(-5);
      const start = `${dates[0] ?? input.workDate}T00:00:00+08:00`;
      const end = `${input.workDate}T23:59:59+08:00`;
      const ledger = await runPaginatedCommand(input, (pageIndex, previous) => {
        const cursor = pageIndex === 0 ? "0" : pickText(previous, ["cursor", "result.cursor", "data.cursor"]);
        if (pageIndex > 0 && !cursor) return null;
        return [
          "report", "outbox", "list", "--start", start, "--end", end,
          "--cursor", cursor, "--size", "20",
        ];
      }, { maxPages: 20 });
      const rows = ledger.pages.flatMap((list) => requiredRecordList(
        list,
        ["result.items", "items", "data.items", "result"],
        "report.entries",
      ));
      const previousWorkDate = input.historyWorkDates.filter((date) => date < input.workDate).sort().at(-1);
      const evidences = rows.flatMap((row, index): CollectedEvidence[] => {
        const fields = reportFields(row);
        const content = reportReferenceSummary(fields);
        const title = pickText(row, ["reportName", "report_name", "title", "report_template_name", "标题"]) || "历史日志";
        const occurredAt = normalizeTime(pickText(row, ["createTime", "gmtCreate", "createdAt", "日期"]));
        const externalId = pickText(row, ["reportId", "report_id", "id"])
          || `report-${occurredAt || input.workDate}-${index}`;
        const occurredDate = occurredAt.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
        const continuationHints = occurredDate === previousWorkDate ? extractContinuationHints(fields) : [];
        if (continuationHints.length > 0) {
          return continuationHints.map((hint, hintIndex) => ({
            sourceType: "dingtalk_report" as const,
            externalId: `${externalId}:continuation:${hintIndex}`,
            title,
            summary: shorten(content, 800),
            occurredAt,
            actorUserIds: [input.ddUserid],
            actorNames: [pickText(row, ["creatorName", "senderName", "发送人"])].filter(Boolean),
            participantNames: [],
            url: safeLink(pickText(row, ["dingtalkOpenUrl", "url", "钉钉链接"])),
            privacyScope: "normal" as const,
            projectSignals: projectSignals(hint, content),
            evidenceStrength: "medium" as const,
            relationToSelf: "self" as const,
            senderKind: "user" as const,
            temporalRole: "previous_workday" as const,
            workUse: "continuation_hint" as const,
            analysisTitle: hint,
            analysisSummary: "",
            resultEligible: false,
          }));
        }
        return [{
          sourceType: "dingtalk_report" as const,
          externalId,
          title,
          summary: shorten(content, 800),
          occurredAt,
          actorUserIds: [input.ddUserid],
          actorNames: [pickText(row, ["creatorName", "senderName", "发送人"])].filter(Boolean),
          participantNames: [],
          url: safeLink(pickText(row, ["dingtalkOpenUrl", "url", "钉钉链接"])),
          privacyScope: "normal" as const,
          projectSignals: projectSignals(title, content),
          evidenceStrength: "weak" as const,
          relationToSelf: "self" as const,
          senderKind: "user" as const,
          temporalRole: occurredDate === previousWorkDate ? "previous_workday" as const : "history" as const,
          workUse: "background_only" as const,
          analysisTitle: "",
          analysisSummary: "",
          resultEligible: false,
        }];
      });
      return sourceResult("dingtalk_report", evidences, {
        failures: ledger.failures,
        errorCode: primaryFailureCode(ledger.error ? [ledger.error] : []),
        hasMore: ledger.hasMore,
        complete: ledger.complete,
        pagesFetched: ledger.pagesFetched,
        itemCount: rows.length,
        stopReason: ledger.stopReason,
        failureStage: primaryFailureStage(ledger.error ? [ledger.error] : []) ?? "report_list",
      });
    } catch (error) {
      return errorResult("dingtalk_report", error);
    }
  },
};
