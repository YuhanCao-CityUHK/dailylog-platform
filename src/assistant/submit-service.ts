import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { nowIso } from "../infra/db";
import { todayYmd } from "../infra/workcal";
import { canReportToProject } from "../projects/permissions";
import { getFormalProject } from "../projects/service";
import { readFormalReport, type FormalReport } from "../reports/service";
import { recordReportVersion } from "../reports/versions";
import { nextMissingFact } from "./completeness-evaluator";
import { getFinanceProjectCode, listFinanceProjectCodes } from "../platform/finance-project-codes";
import type { AssistantSessionItem } from "./conversation-schema";
import { AssistantSessionService } from "./session-service";
import { AssistantValidationError, validatedText } from "./structured-validation";

export interface AssistantSubmissionResult {
  report: FormalReport;
  version: number;
  idempotent: boolean;
}

export function isExplicitSubmissionIntent(value: unknown): boolean {
  const text = String(value ?? "").normalize("NFKC").trim().replace(/[。！!]+$/, "");
  return /^(确认提交|确认并提交|提交这版|确认提交这版|就按这版提交|提交日报)$/.test(text);
}

function formalText(item: AssistantSessionItem): string {
  return (item.resultText || item.workSummary).trim();
}

function readVersionReport(logId: number, version: number, db: DatabaseSync): FormalReport | null {
  const row = db
    .prepare("SELECT snapshot_json FROM log_versions WHERE log_id = ? AND version = ?")
    .get(logId, version) as { snapshot_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.snapshot_json) as FormalReport;
  } catch {
    return null;
  }
}

export class AssistantSubmitService {
  private readonly sessions: AssistantSessionService;

  constructor(private readonly db: DatabaseSync) {
    this.sessions = new AssistantSessionService(db);
  }

  submit(
    user: SessionUser,
    sessionId: number,
    confirmation: unknown,
    rawIdempotencyKey: unknown,
  ): AssistantSubmissionResult {
    if (!isExplicitSubmissionIntent(confirmation)) {
      throw new AssistantValidationError("只有明确表达“确认提交”或“提交这版”后才能提交日报");
    }
    return this.submitAuthorized(user, sessionId, rawIdempotencyKey);
  }

  /** 已通过 V2 Policy Guard 的结构化授权入口；不再从原话二次猜测提交意图。 */
  submitAuthorized(
    user: SessionUser,
    sessionId: number,
    rawIdempotencyKey: unknown,
  ): AssistantSubmissionResult {
    const idempotencyKey = validatedText(rawIdempotencyKey, "幂等键", 120, false);
    const session = this.sessions.readById(sessionId, user.id);
    if (session.workDate !== todayYmd()) throw new AssistantValidationError("日报助手只提交当天日报");
    if (session.items.length === 0) throw new AssistantValidationError("至少需要一条工作事项");
    const missing = nextMissingFact(session, this.db);
    if (missing) throw new AssistantValidationError("草稿仍有未确认信息，补齐后才能提交");
    for (const item of session.items) {
      if (item.scopeType === "unconfirmed") throw new AssistantValidationError("仍有事项未确认项目归属");
      if (item.hours === null) throw new AssistantValidationError("每项实际工时都必须由员工确认");
      if (!formalText(item)) throw new AssistantValidationError("每项都需要可理解的结果或进展");
      if (item.scopeType === "project") {
        if (!item.projectId || !canReportToProject(user, item.projectId, this.db)) {
          throw new AssistantValidationError("无权将事项归入所选项目");
        }
        const hasConfiguredFinanceCodes = listFinanceProjectCodes(item.projectId, this.db).length > 0;
        if (hasConfiguredFinanceCodes && (!item.financeCodeId || !getFinanceProjectCode(item.projectId, item.financeCodeId, this.db))) {
          throw new AssistantValidationError("项目事项必须选择具体财务项目编码");
        }
      }
    }

    const stamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingIdempotency = this.db
        .prepare(
          `SELECT log_id, version FROM assistant_submission_idempotency
            WHERE user_id = ? AND work_date = ? AND idempotency_key = ?`,
        )
        .get(user.id, session.workDate, idempotencyKey) as { log_id: number; version: number } | undefined;
      if (existingIdempotency) {
        const report = readVersionReport(existingIdempotency.log_id, existingIdempotency.version, this.db);
        if (!report) throw new Error("幂等记录对应的日报不存在");
        this.db.exec("COMMIT");
        return { report, version: existingIdempotency.version, idempotent: true };
      }
      const existing = this.db
        .prepare("SELECT id FROM logs WHERE user_id = ? AND date = ? AND status = 'submitted'")
        .get(user.id, session.workDate) as { id: number } | undefined;
      let logId: number;
      let oldItems: Array<{ id: number; ord: number }> = [];
      if (existing) {
        logId = existing.id;
        oldItems = this.db.prepare("SELECT id, ord FROM log_items WHERE log_id = ? ORDER BY ord").all(logId) as unknown as Array<{
          id: number;
          ord: number;
        }>;
        this.db.prepare("UPDATE logs SET quality = 'normal', updated_at = ? WHERE id = ?").run(stamp, logId);
      } else {
        const inserted = this.db
          .prepare(
            `INSERT INTO logs (user_id, date, status, quality, submitted_at, updated_at, total_hours, current_version)
             VALUES (?, ?, 'submitted', 'normal', ?, ?, 0, 0)`,
          )
          .run(user.id, session.workDate, stamp, stamp);
        logId = Number(inserted.lastInsertRowid);
      }

      const newItemIds = new Map<number, number>();
      for (let index = 0; index < session.items.length; index += 1) {
        const item = session.items[index];
        const order = index + 1;
        let projectName: string | null = null;
        if (item.scopeType === "project" && item.projectId) projectName = getFormalProject(item.projectId, this.db).name;
        const text = formalText(item);
        const inserted = this.db
          .prepare(
            `INSERT INTO log_items
              (log_id, ord, aff, text, hours, scope_type, project_id, project_name_snapshot, finance_project_code_id,
               work_status, work_summary, result_text, blocker_text, next_action, support_needed,
               support_people_json, tomorrow_plan)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            logId,
            order,
            item.scopeType === "project" ? String(item.projectId) : "dept",
            text,
            item.hours,
            item.scopeType === "project" ? "project" : "department_daily",
            item.scopeType === "project" ? (item.projectId ?? null) : null,
            projectName,
            item.scopeType === "project" ? (item.financeCodeId ?? null) : null,
            item.workStatus,
            item.workSummary,
            item.resultText,
            item.blockerText || null,
            item.nextAction || null,
            item.supportNeeded || null,
            JSON.stringify(item.supportPeople),
            item.tomorrowPlan || null,
          );
        newItemIds.set(order, Number(inserted.lastInsertRowid));
      }

      if (oldItems.length) {
        const fallbackItemId = newItemIds.get(1)!;
        for (const old of oldItems) {
          this.db.prepare("DELETE FROM item_cats WHERE item_id = ?").run(old.id);
          this.db.prepare("UPDATE attachments SET item_id = ? WHERE item_id = ?").run(newItemIds.get(old.ord) ?? fallbackItemId, old.id);
        }
        this.db.prepare(`DELETE FROM log_items WHERE id IN (${oldItems.map(() => "?").join(",")})`).run(
          ...(oldItems.map((item) => item.id) as never[]),
        );
      }

      const version = recordReportVersion(logId, user.id, "current_day_assistant", this.db);
      this.db.prepare(
        `INSERT INTO assistant_submission_idempotency
          (user_id, work_date, idempotency_key, log_id, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(user.id, session.workDate, idempotencyKey, logId, version, stamp);
      this.db.prepare(
        `UPDATE assistant_sessions
            SET status = 'submitted', submitted_log_id = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`,
      ).run(logId, stamp, stamp, session.id, user.id);
      const report = readFormalReport(logId, this.db);
      if (!report) throw new Error("正式日报保存后读取失败");
      this.db.exec("COMMIT");
      return { report, version, idempotent: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
