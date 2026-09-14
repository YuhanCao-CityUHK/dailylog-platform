import type { DatabaseSync } from "node:sqlite";
import type { ContextCollector } from "../schema";
import { getDb } from "../../infra/db";
import { projectSignals, shorten, sourceResult } from "../../dws/collectors/shared";

export function createPlatformLogCollector(db: DatabaseSync = getDb()): ContextCollector {
  return {
    source: "platform_log",
    async collect(input) {
      const dates = input.historyWorkDates.slice(-5);
      if (dates.length === 0) return sourceResult("platform_log", []);
      const previousWorkDate = dates.filter((date) => date < input.workDate).sort().at(-1);
      const rows = db
        .prepare(
          `SELECT i.id, l.date, i.scope_type, i.project_name_snapshot, i.work_status,
                  i.work_summary, i.result_text, i.blocker_text, i.next_action, i.tomorrow_plan
             FROM log_items i JOIN logs l ON l.id = i.log_id
            WHERE l.user_id = ? AND l.status = 'submitted'
              AND l.date IN (${dates.map(() => "?").join(",")})
            ORDER BY l.date DESC, i.ord`,
        )
        .all(input.platformUserId, ...(dates as never[])) as unknown as Array<Record<string, unknown>>;
      const evidences = rows.map((row) => {
        const rowDate = String(row.date ?? "");
        const projectName = String(row.project_name_snapshot ?? "").trim();
        const workSummary = String(row.work_summary ?? "").trim();
        const resultText = String(row.result_text ?? "").trim();
        const blockerText = String(row.blocker_text ?? "").trim();
        const nextAction = String(row.next_action ?? "").trim();
        const tomorrowPlan = String(row.tomorrow_plan ?? "").trim();
        const workStatus = String(row.work_status ?? "").trim();
        const isPrevious = rowDate === previousWorkDate;
        const continuationText = nextAction || tomorrowPlan || workSummary;
        const isContinuation = isPrevious && Boolean(
          nextAction || tomorrowPlan || blockerText || ["in_progress", "blocked", "no_progress"].includes(workStatus),
        );
        return {
          sourceType: "platform_log" as const,
          externalId: `platform-log-item-${row.id}`,
          title: workSummary || resultText || "历史平台日志事项",
          summary: shorten(
            [
              resultText ? `结果/进展：${resultText}` : "",
              blockerText ? `阻塞：${blockerText}` : "",
              nextAction ? `下一步：${nextAction}` : "",
              tomorrowPlan ? `明日计划：${tomorrowPlan}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            700,
          ),
          occurredAt: `${rowDate}T12:00:00+08:00`,
          actorUserIds: [input.ddUserid],
          actorNames: [],
          participantNames: [],
          privacyScope: "employee_only" as const,
          projectSignals: projectSignals(projectName, workSummary, nextAction, tomorrowPlan),
          evidenceStrength: "strong" as const,
          relationToSelf: "self" as const,
          senderKind: "user" as const,
          temporalRole: isPrevious ? "previous_workday" as const : "history" as const,
          workUse: isContinuation ? "continuation_hint" as const : "background_only" as const,
          analysisTitle: isContinuation ? continuationText : "",
          analysisSummary: "",
          resultEligible: false,
        };
      });
      return sourceResult("platform_log", evidences, {
        pagesFetched: 1,
        complete: true,
        itemCount: rows.length,
      });
    },
  };
}
