import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../infra/db";

export type ReportScopeType = "project" | "department_daily";
export type ReportWorkStatus = "completed" | "in_progress" | "blocked" | "no_progress";

export interface FormalReportItem {
  id: number;
  order: number;
  scopeType: ReportScopeType;
  projectId?: number;
  projectNameSnapshot?: string;
  financeCodeId?: number;
  financeCode?: string;
  financeCodeName?: string;
  status: ReportWorkStatus;
  workSummary: string;
  resultText: string;
  hours: number;
  blockerText?: string;
  nextAction?: string;
  supportNeeded?: string;
  supportPersonNames: string[];
  tomorrowPlan?: string;
}

export interface FormalReport {
  id: number;
  userId: number;
  workDate: string;
  status: "submitted";
  totalHours: number;
  submittedAt: string;
  updatedAt: string;
  currentVersion: number;
  items: FormalReportItem[];
}

function optionalText(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function supportPeople(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function readFormalReport(logId: number, db: DatabaseSync = getDb()): FormalReport | null {
  const log = db
    .prepare(
      `SELECT id, user_id, date, status, total_hours, submitted_at, updated_at, current_version
         FROM logs WHERE id = ? AND status = 'submitted'`,
    )
    .get(logId) as
    | {
        id: number;
        user_id: number;
        date: string;
        status: string;
        total_hours: number;
        submitted_at: string;
        updated_at: string;
        current_version: number;
      }
    | undefined;
  if (!log) return null;
  const rows = db
    .prepare(
      `SELECT i.id, i.ord, i.aff, i.text, i.hours, i.scope_type, i.project_id, i.project_name_snapshot,
              i.finance_project_code_id, f.code AS finance_project_code, f.name AS finance_project_code_name,
              work_status, work_summary, result_text, blocker_text, next_action,
              support_needed, support_people_json, tomorrow_plan
         FROM log_items i LEFT JOIN finance_project_codes f ON f.id = i.finance_project_code_id
        WHERE i.log_id = ? ORDER BY i.ord`,
    )
    .all(logId) as unknown as Array<Record<string, unknown>>;
  const items = rows.map((row): FormalReportItem => {
    const projectId = Number(row.project_id) || undefined;
    const scopeType: ReportScopeType = row.scope_type === "project" && projectId ? "project" : "department_daily";
    const status = ["completed", "blocked", "no_progress"].includes(String(row.work_status))
      ? (String(row.work_status) as ReportWorkStatus)
      : "in_progress";
    return {
      id: Number(row.id),
      order: Number(row.ord),
      scopeType,
      projectId: scopeType === "project" ? projectId : undefined,
      projectNameSnapshot: scopeType === "project" ? optionalText(row.project_name_snapshot) : undefined,
      financeCodeId: scopeType === "project" ? (Number(row.finance_project_code_id) || undefined) : undefined,
      financeCode: scopeType === "project" ? optionalText(row.finance_project_code) : undefined,
      financeCodeName: scopeType === "project" ? optionalText(row.finance_project_code_name) : undefined,
      status,
      workSummary: String(row.work_summary ?? row.text ?? "").trim(),
      resultText: String(row.result_text ?? row.text ?? "").trim(),
      hours: Number(row.hours) || 0,
      blockerText: optionalText(row.blocker_text),
      nextAction: optionalText(row.next_action),
      supportNeeded: optionalText(row.support_needed),
      supportPersonNames: supportPeople(row.support_people_json),
      tomorrowPlan: optionalText(row.tomorrow_plan),
    };
  });
  const totalHours = Math.round(items.reduce((sum, item) => sum + item.hours, 0) * 100) / 100;
  return {
    id: log.id,
    userId: log.user_id,
    workDate: log.date,
    status: "submitted",
    totalHours,
    submittedAt: log.submitted_at,
    updatedAt: log.updated_at,
    currentVersion: log.current_version,
    items,
  };
}
