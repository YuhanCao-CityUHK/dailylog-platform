import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../infra/db";
import type { DailyAssistantCandidate } from "./candidate-service";
import type { WorkItemAnalysisMode } from "./work-item-analysis-service";
import {
  listUnconfirmedTaskSignalSecrets,
  scrubTaskSignalSecrets,
  taskSignalSecretFromRow,
  type TaskSignalSecret,
} from "./task-signal-privacy";
import {
  candidateToSessionDefaults,
  type AssistantMessage,
  type AssistantMode,
  type AssistantSession,
  type AssistantSessionItem,
} from "./conversation-schema";

interface SessionRow {
  id: number;
  user_id: number;
  work_date: string;
  context_job_id: string | null;
  analysis_mode: WorkItemAnalysisMode | "manual";
  mode: AssistantMode;
  status: "active" | "submitted" | "abandoned";
  outside_work_asked: number;
  outside_work_answered: number;
  force_draft: number;
  revision: number;
  updated_at: string;
}

function stringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function itemFromRow(row: Record<string, unknown>): Omit<AssistantSessionItem, "displayAlias"> {
  return {
    id: Number(row.id),
    itemKey: String(row.item_key),
    order: Number(row.ord),
    scopeType: row.scope_type === "project" ? "project" : row.scope_type === "unconfirmed" ? "unconfirmed" : "department_daily",
    projectId: Number(row.project_id) || undefined,
    projectName: String(row.project_name_snapshot ?? "").trim() || undefined,
    financeCodeId: Number(row.finance_project_code_id) || undefined,
    workStatus: ["completed", "blocked", "no_progress"].includes(String(row.work_status))
      ? (String(row.work_status) as AssistantSessionItem["workStatus"])
      : "in_progress",
    workSummary: String(row.work_summary ?? ""),
    resultText: String(row.result_text ?? ""),
    hours: row.hours === null || row.hours === undefined ? null : Number(row.hours),
    blockerText: String(row.blocker_text ?? ""),
    nextAction: String(row.next_action ?? ""),
    supportNeeded: String(row.support_needed ?? ""),
    supportPeople: stringArray(row.support_people_json),
    tomorrowPlan: String(row.tomorrow_plan ?? ""),
    sourceKind: row.source_kind === "employee" ? "employee" : "candidate",
    referenceIds: stringArray(row.reference_ids_json),
    needsConfirmation: stringArray(row.needs_confirmation_json),
    sourceCompleteness: row.source_completeness === "partial" ? "partial" : "complete",
    confidence: Math.min(1, Math.max(0, Number(row.candidate_confidence ?? 1))),
    missingFacts: stringArray(row.missing_facts_json),
    employeeConfirmed: Number(row.employee_confirmed) === 1,
    origin: row.candidate_origin === "continuation" ? "continuation" : row.candidate_origin === "employee" ? "employee" : "today",
  };
}

export class AssistantSessionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly candidateTtlHours = 12,
  ) {}

  cleanupExpiredTaskSignals(now = new Date()): number {
    const ttlMs = Math.max(1, this.candidateTtlHours) * 3600 * 1000;
    const cutoff = new Date(now.getTime() - ttlMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(
        `SELECT session_id, item_key, work_summary, reference_ids_json
           FROM assistant_session_items
          WHERE source_kind = 'candidate'
            AND employee_confirmed = 0
            AND created_at <= ?
            AND needs_confirmation_json LIKE '%"task_signal"%'`,
      ).all(cutoff) as unknown as Array<Record<string, unknown>>;
      const secretsBySession = new Map<number, TaskSignalSecret[]>();
      for (const row of rows) {
        const sessionId = Number(row.session_id);
        const secrets = secretsBySession.get(sessionId) ?? [];
        secrets.push(taskSignalSecretFromRow(row));
        secretsBySession.set(sessionId, secrets);
      }
      for (const [sessionId, secrets] of secretsBySession) scrubTaskSignalSecrets(this.db, sessionId, secrets);
      const deleted = Number(this.db.prepare(
        `DELETE FROM assistant_session_items
          WHERE source_kind = 'candidate'
            AND employee_confirmed = 0
            AND created_at <= ?
            AND needs_confirmation_json LIKE '%"task_signal"%'`,
      ).run(cutoff).changes);
      this.db.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensure(
    userId: number,
    workDate: string,
    mode: AssistantMode,
    contextJobId: string | undefined,
    candidates: DailyAssistantCandidate[],
    analysisMode: WorkItemAnalysisMode | "manual" = candidates.length ? "deterministic" : "manual",
  ): AssistantSession {
    const stamp = nowIso();
    this.cleanupExpiredTaskSignals(new Date(stamp));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let changedContext = false;
      let firstReadyProjection = false;
      let shouldSyncCandidates = false;
      let projectionChanged = false;
      let createdSession = false;
      let row = this.db
        .prepare("SELECT * FROM assistant_sessions WHERE user_id = ? AND work_date = ?")
        .get(userId, workDate) as SessionRow | undefined;
      if (!row) {
        createdSession = true;
        shouldSyncCandidates = true;
        const created = this.db
          .prepare(
            `INSERT INTO assistant_sessions
              (user_id, work_date, context_job_id, mode, analysis_mode, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(userId, workDate, contextJobId ?? null, mode, analysisMode, stamp, stamp);
        row = this.db.prepare("SELECT * FROM assistant_sessions WHERE id = ?").get(Number(created.lastInsertRowid)) as unknown as SessionRow;
      } else {
        changedContext = Boolean(contextJobId && contextJobId !== row.context_job_id);
        firstReadyProjection = !changedContext && row.analysis_mode === "manual" && analysisMode !== "manual";
        shouldSyncCandidates = changedContext || firstReadyProjection;
        if (changedContext) {
          scrubTaskSignalSecrets(this.db, row.id, listUnconfirmedTaskSignalSecrets(this.db, row.id));
          const removed = this.db.prepare(
            "DELETE FROM assistant_session_items WHERE session_id = ? AND source_kind = 'candidate' AND employee_confirmed = 0",
          ).run(row.id);
          projectionChanged = Number(removed.changes) > 0;
        }
        const nextMode: AssistantMode = contextJobId ? mode : row.mode;
        this.db.prepare(
          "UPDATE assistant_sessions SET context_job_id = COALESCE(?, context_job_id), mode = ?, analysis_mode = ?, updated_at = ? WHERE id = ?",
        ).run(contextJobId ?? null, nextMode, analysisMode, stamp, row.id);
      }

      if (shouldSyncCandidates) {
        const existingKeys = new Set(
          (this.db.prepare("SELECT item_key FROM assistant_session_items WHERE session_id = ?").all(row.id) as unknown as Array<{ item_key: string }>).map(
            (item) => item.item_key,
          ),
        );
        let nextOrder = Number(
          (this.db.prepare("SELECT COALESCE(MAX(ord), 0) AS value FROM assistant_session_items WHERE session_id = ?").get(row.id) as { value: number }).value,
        );
        for (const candidate of candidates) {
          if (existingKeys.has(candidate.candidateId)) continue;
          const item = candidateToSessionDefaults(candidate);
          nextOrder += 1;
          this.insertItem(row.id, nextOrder, item, stamp);
          projectionChanged = true;
        }
      }
      if (!createdSession && projectionChanged) {
        this.db.prepare("UPDATE assistant_sessions SET revision = revision + 1, updated_at = ? WHERE id = ?").run(stamp, row.id);
      }
      if (changedContext || firstReadyProjection) this.syncV2AfterContextRefresh(row.id, stamp);
      this.db.exec("COMMIT");
      return this.readById(row.id, userId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private syncV2AfterContextRefresh(sessionId: number, stamp: string): void {
    const hasV2 = this.db.prepare(
      "SELECT 1 AS present FROM assistant_messages WHERE session_id = ? AND kind LIKE 'agent_v2_%' LIMIT 1",
    ).get(sessionId) as { present: number } | undefined;
    if (!hasV2) return;
    const hasUserTurn = this.db.prepare(
      "SELECT 1 AS present FROM assistant_messages WHERE session_id = ? AND kind = 'agent_v2_user' LIMIT 1",
    ).get(sessionId) as { present: number } | undefined;
    if (!hasUserTurn) {
      // No employee-authored V2 history exists, so the deterministic opening can be rebuilt in place on next read.
      this.db.prepare("DELETE FROM assistant_messages WHERE session_id = ? AND kind LIKE 'agent_v2_%'").run(sessionId);
      return;
    }
    const counts = this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN needs_confirmation_json LIKE '%"task_signal"%' THEN 1 ELSE 0 END) AS signals
         FROM assistant_session_items
        WHERE session_id = ? AND deleted = 0 AND employee_confirmed = 0`,
    ).get(sessionId) as { total: number; signals: number | null };
    const text = `上下文已重新整理，当前有 ${Number(counts.total)} 项待确认事项，其中 ${Number(counts.signals ?? 0)} 项是交办/待跟进线索。请以右侧最新草稿为准；旧开场中的事项数量已经失效。`;
    this.db.prepare(
      `INSERT INTO assistant_messages
        (session_id, role, kind, content, structured_json, focus_json, tool_trace_json, created_at)
       VALUES (?, 'assistant', 'agent_v2_context_refresh', ?, ?, ?, '[]', ?)`,
    ).run(
      sessionId,
      text,
      JSON.stringify({ response: { receipts: [], options: ["逐项确认", "还有别的工作"] } }),
      JSON.stringify({ itemId: null, field: "today", questionKind: "ask_missing" }),
      stamp,
    );
  }

  readForDate(userId: number, workDate: string): AssistantSession | null {
    const row = this.db
      .prepare("SELECT id FROM assistant_sessions WHERE user_id = ? AND work_date = ?")
      .get(userId, workDate) as { id: number } | undefined;
    return row ? this.readById(row.id, userId) : null;
  }

  readById(sessionId: number, userId: number): AssistantSession {
    this.cleanupExpiredTaskSignals();
    const row = this.db
      .prepare("SELECT * FROM assistant_sessions WHERE id = ? AND user_id = ?")
      .get(sessionId, userId) as SessionRow | undefined;
    if (!row) throw new Error("assistant_session_not_found");
    const items = (this.db
      .prepare("SELECT * FROM assistant_session_items WHERE session_id = ? AND deleted = 0 ORDER BY ord, id")
      .all(sessionId) as unknown as Array<Record<string, unknown>>)
      .map(itemFromRow)
      .map((item, index): AssistantSessionItem => ({ ...item, displayAlias: `第 ${index + 1} 项` }));
    const messages = (this.db
      .prepare("SELECT id, role, kind, content, created_at FROM assistant_messages WHERE session_id = ? ORDER BY id")
      .all(sessionId) as unknown as Array<{ id: number; role: AssistantMessage["role"]; kind: string; content: string; created_at: string }>).map(
      (message) => ({ id: message.id, role: message.role, kind: message.kind, content: message.content, createdAt: message.created_at }),
    );
    return {
      id: row.id,
      userId: row.user_id,
      workDate: row.work_date,
      mode: row.mode,
      status: row.status,
      contextJobId: row.context_job_id ?? undefined,
      analysisMode: row.analysis_mode ?? "manual",
      outsideWorkAsked: row.outside_work_asked === 1,
      outsideWorkAnswered: row.outside_work_answered === 1,
      forceDraft: row.force_draft === 1,
      revision: row.revision,
      items,
      messages,
      updatedAt: row.updated_at,
    };
  }

  insertEmployeeItem(sessionId: number, item: Omit<AssistantSessionItem, "id" | "order" | "displayAlias">): number {
    const max = this.db.prepare("SELECT COALESCE(MAX(ord), 0) AS value FROM assistant_session_items WHERE session_id = ?").get(sessionId) as {
      value: number;
    };
    return this.insertItem(sessionId, Number(max.value) + 1, { ...item, itemKey: item.itemKey || `employee:${randomUUID()}` }, nowIso());
  }

  private insertItem(
    sessionId: number,
    order: number,
    item: Omit<AssistantSessionItem, "id" | "order" | "displayAlias">,
    stamp: string,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO assistant_session_items
          (session_id, item_key, ord, scope_type, project_id, project_name_snapshot, finance_project_code_id, work_status,
           work_summary, result_text, hours, blocker_text, next_action, support_needed,
           support_people_json, tomorrow_plan, source_kind, reference_ids_json,
           needs_confirmation_json, source_completeness, candidate_confidence, missing_facts_json,
           employee_confirmed, candidate_origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
          sessionId,
        item.itemKey,
        order,
        item.scopeType,
        item.projectId ?? null,
        item.projectName ?? null,
        item.financeCodeId ?? null,
        item.workStatus,
        item.workSummary,
        item.resultText,
        item.hours,
        item.blockerText,
        item.nextAction,
        item.supportNeeded,
        JSON.stringify(item.supportPeople),
        item.tomorrowPlan,
        item.sourceKind,
        JSON.stringify(item.referenceIds),
        JSON.stringify(item.needsConfirmation),
        item.sourceCompleteness,
        item.confidence,
        JSON.stringify(item.missingFacts),
        item.employeeConfirmed ? 1 : 0,
        item.origin,
        stamp,
        stamp,
      );
    return Number(result.lastInsertRowid);
  }

  addMessage(
    sessionId: number,
    role: AssistantMessage["role"],
    kind: string,
    content: string,
    structured: unknown = {},
    clientMessageId?: string,
  ): { id: number; duplicate: boolean } {
    if (clientMessageId) {
      const existing = this.db
        .prepare("SELECT id FROM assistant_messages WHERE session_id = ? AND client_message_id = ?")
        .get(sessionId, clientMessageId) as { id: number } | undefined;
      if (existing) return { id: existing.id, duplicate: true };
    }
    const result = this.db
      .prepare(
        `INSERT INTO assistant_messages
          (session_id, role, kind, content, structured_json, client_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, role, kind, content, JSON.stringify(structured), clientMessageId ?? null, nowIso());
    return { id: Number(result.lastInsertRowid), duplicate: false };
  }

  touch(sessionId: number): void {
    this.db.prepare("UPDATE assistant_sessions SET revision = revision + 1, updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
  }

  markOutsideWorkAsked(sessionId: number): void {
    this.db.prepare("UPDATE assistant_sessions SET outside_work_asked = 1, updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
  }

  markOutsideWorkAnswered(sessionId: number): void {
    this.db.prepare("UPDATE assistant_sessions SET outside_work_asked = 1, outside_work_answered = 1, updated_at = ? WHERE id = ?").run(
      nowIso(),
      sessionId,
    );
  }

  markForceDraft(sessionId: number): void {
    this.db.prepare("UPDATE assistant_sessions SET force_draft = 1, updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
  }

  dbHandle(): DatabaseSync {
    return this.db;
  }
}
