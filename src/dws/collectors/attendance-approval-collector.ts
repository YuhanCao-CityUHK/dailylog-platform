import type { CollectedEvidence, ContextCollector, JsonObject } from "../../assistant/schema";
import {
  errorResult,
  normalizeTime,
  payloadComplete,
  payloadFailureCount,
  payloadHasMore,
  payloadPagesFetched,
  payloadStopReason,
  pickText,
  requiredRecordList,
  runCommand,
  shorten,
  sourceResult,
} from "./shared";

function backgroundEvidence(payload: JsonObject, sourceType: "attendance" | "approval", workDate: string): CollectedEvidence[] {
  return requiredRecordList(
    payload,
    ["data.approvals", "approvals", "result.items", "items", "data.items", "result"],
    "attendance.approvals",
  )
    .filter((item) => /请假|出差|外出|加班|补卡|leave|trip|travel|out/i.test(pickText(item, ["type", "title", "processName", "bizType"])))
    .map((item, index) => {
      const title = pickText(item, ["title", "processName", "typeName", "bizType"]) || "工作状态";
      const status = pickText(item, ["status", "result", "approveResult"]);
      const start = pickText(item, ["startTime", "beginTime", "startAt"]);
      const end = pickText(item, ["endTime", "finishTime", "endAt"]);
      const duration = pickText(item, ["duration", "durationHours", "leaveDuration", "dayType", "period"]);
      return {
        sourceType,
        externalId: pickText(item, ["id", "processInstanceId", "approveId"]) || `${sourceType}-${workDate}-${index}`,
        title,
        summary: shorten([title, status, start && end ? `${start} 至 ${end}` : start || end, duration].filter(Boolean).join("："), 300),
        occurredAt: normalizeTime(pickText(item, ["startTime", "createTime", "beginTime"])),
        actorUserIds: [],
        actorNames: [],
        participantNames: [],
        privacyScope: "employee_only",
        projectSignals: [],
        evidenceStrength: "weak",
        relationToSelf: "self",
        senderKind: "user",
      };
    });
}

export const attendanceApprovalCollector: ContextCollector = {
  source: "attendance_approval",
  async collect(input) {
    try {
      const payload = await runCommand(input, [
        "attendance", "+list-approve",
        "--users", input.ddUserid,
        "--types", "overtime,leave,trip,patch",
        "--start", input.workDate,
        "--end", input.workDate,
      ], 15_000);
      const attendance = backgroundEvidence(payload, "attendance", input.workDate);
      const hasMore = payloadHasMore(payload);
      return sourceResult("attendance_approval", attendance, {
        failures: payloadFailureCount(payload),
        hasMore,
        complete: payloadComplete(payload),
        pagesFetched: payloadPagesFetched(payload),
        itemCount: attendance.length,
        stopReason: hasMore ? "page_limit" : payloadStopReason(payload),
        failureStage: "attendance_list",
      });
    } catch (error) {
      return errorResult("attendance_approval", error);
    }
  },
};
