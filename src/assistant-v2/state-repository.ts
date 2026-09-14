import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { canReportToProject } from "../projects/permissions";
import { listFinanceProjectCodes } from "../platform/finance-project-codes";
import { AssistantV2Error, type AgentDraftItem, type AgentDraftState, type ReplyFocus } from "./types";

function stringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function withReceipts(content: string, structuredJson: string): string {
  try {
    const parsed = JSON.parse(structuredJson) as { response?: { receipts?: Array<{ text?: string }> } };
    const receipts = (parsed.response?.receipts ?? []).map((receipt) => String(receipt.text ?? "")).filter(Boolean);
    return receipts.length ? `【已执行】${receipts.join("；")}\n${content}` : content;
  } catch {
    return content;
  }
}

function focusValue(value: unknown): ReplyFocus | null {
  try {
    const parsed = JSON.parse(String(value ?? "null")) as ReplyFocus | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

interface SessionRow {
  id: number;
  user_id: number;
  work_date: string;
  mode: AgentDraftState["mode"];
  status: AgentDraftState["status"];
  revision: number;
  outside_work_asked: number;
  outside_work_answered: number;
  prepared_hash: string | null;
  prepared_revision: number | null;
  prepared_message_id: number | null;
}

export class AssistantV2StateRepository {
  constructor(private readonly db: DatabaseSync) {}

  read(user: SessionUser, sessionId: number, sourceMessageId?: number): AgentDraftState {
    const session = this.db.prepare("SELECT * FROM assistant_sessions WHERE id = ? AND user_id = ?").get(sessionId, user.id) as SessionRow | undefined;
    if (!session) throw new AssistantV2Error("session_not_found", "日报助手会话不存在");
    const rows = this.db
      .prepare(
        `SELECT i.*, f.code AS finance_project_code
           FROM assistant_session_items i
           LEFT JOIN finance_project_codes f ON f.id = i.finance_project_code_id
          WHERE i.session_id = ? AND i.deleted = 0 ORDER BY i.ord, i.id`,
      )
      .all(sessionId) as unknown as Array<Record<string, unknown>>;
    const items: AgentDraftItem[] = rows.map((row, index) => ({
      recordId: Number(row.id),
      itemId: String(row.item_key),
      displayAlias: `第 ${index + 1} 项`,
      order: index + 1,
      scopeType: row.scope_type === "project" ? "project" : row.scope_type === "unconfirmed" ? "unconfirmed" : "department_daily",
      projectId: row.project_id === null || row.project_id === undefined ? null : Number(row.project_id),
      projectName: String(row.project_name_snapshot ?? "").trim() || null,
      financeCodeId: Number(row.finance_project_code_id) || null,
      financeCode: String(row.finance_project_code ?? "").trim() || null,
      recommendedProjectId: null,
      status: ["completed", "blocked", "no_progress"].includes(String(row.work_status))
        ? (String(row.work_status) as AgentDraftItem["status"])
        : "in_progress",
      summary: String(row.work_summary ?? ""),
      result: String(row.result_text ?? ""),
      hours: row.hours === null || row.hours === undefined ? null : Number(row.hours),
      blocker: String(row.blocker_text ?? ""),
      nextAction: String(row.next_action ?? ""),
      supportNeeded: String(row.support_needed ?? ""),
      supportPeople: stringArray(row.support_people_json),
      tomorrowPlan: String(row.tomorrow_plan ?? ""),
      confirmed: Number(row.employee_confirmed) === 1,
      origin: row.candidate_origin === "continuation" ? "continuation" : row.candidate_origin === "employee" ? "employee" : "today",
      sourceKind: row.source_kind === "employee" ? "employee" : "candidate",
      referenceIds: stringArray(row.reference_ids_json),
      needsConfirmation: stringArray(row.needs_confirmation_json),
      sourceCompleteness: row.source_completeness === "partial" ? "partial" : "complete",
      confidence: Math.min(1, Math.max(0, Number(row.candidate_confidence ?? 1))),
      missingFacts: stringArray(row.missing_facts_json),
    }));
    const visibleProjects = (this.db
      .prepare("SELECT id, name, status FROM projects WHERE source <> 'dingtalk' ORDER BY status, name, id")
      .all() as unknown as Array<{ id: number; name: string; status: string }>)
      .filter((project) => canReportToProject(user, project.id, this.db))
      .map((project) => ({ id: project.id, name: project.name, status: project.status === "completed" ? "completed" as const : "in_progress" as const }));
    const financeCodes = Object.fromEntries(
      visibleProjects.map((project) => [
        String(project.id),
        listFinanceProjectCodes(project.id, this.db).map((code) => ({ id: code.id, code: code.code, name: code.name })),
      ]),
    );
    const beforeId = sourceMessageId ?? Number.MAX_SAFE_INTEGER;
    const focusRow = this.db
      .prepare(
        `SELECT focus_json FROM assistant_messages
          WHERE session_id = ? AND role = 'assistant' AND id < ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, beforeId) as { focus_json: string } | undefined;
    // 只把 V2 内核自己的消息放进模型上下文：旧内核的固定追问文案（“你可以说‘第 1 项删掉’”）不能进入新模型的对话历史。
    // 助手回复前面拼上当时的真实回执，模型才记得自己上一轮做了什么（“刚才删错了”才能对上号）。
    const history = (this.db
      .prepare(
        `SELECT role, content, kind, structured_json FROM (
           SELECT id, role, content, kind, structured_json FROM assistant_messages
            WHERE session_id = ? AND id < ?
              AND kind IN ('agent_v2_user', 'agent_v2_reply', 'agent_v2_error', 'agent_v2_opening', 'agent_v2_context_refresh')
            ORDER BY id DESC LIMIT 8
         ) ORDER BY id`,
      )
      .all(sessionId, beforeId) as unknown as Array<{ role: "user" | "assistant"; content: string; kind: string; structured_json: string }>)
      .map((row) => ({ role: row.role, content: row.kind === "agent_v2_reply" ? withReceipts(row.content, row.structured_json) : row.content }));
    const recentChanges = (this.db
      .prepare(
        `SELECT change_id, revision, op, receipts_json, undone_at FROM assistant_changes
          WHERE session_id = ? ORDER BY revision DESC LIMIT 3`,
      )
      .all(sessionId) as unknown as Array<{ change_id: string; revision: number; op: string; receipts_json: string | null; undone_at: string | null }>).map((change) => ({
      changeId: change.change_id,
      revision: change.revision,
      op: change.op,
      summary: stringArray(change.receipts_json).join("；") || change.op,
      undone: Boolean(change.undone_at),
    }));
    return {
      sessionId: session.id,
      userId: session.user_id,
      workDate: session.work_date,
      mode: session.mode,
      status: session.status,
      revision: session.revision,
      outsideWorkAsked: session.outside_work_asked === 1,
      outsideWorkAnswered: session.outside_work_answered === 1,
      items,
      visibleProjects,
      financeCodes,
      lastFocus: focusValue(focusRow?.focus_json),
      recentChanges,
      history,
      prepared: session.prepared_hash && session.prepared_revision !== null && session.prepared_message_id !== null
        ? { hash: session.prepared_hash, revision: session.prepared_revision, messageId: session.prepared_message_id }
        : null,
    };
  }
}
