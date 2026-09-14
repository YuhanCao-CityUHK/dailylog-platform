import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { CONFIG } from "../infra/config";
import { nowIso } from "../infra/db";
import { inspectDwsConnection, parseDwsJson, runDwsForUser } from "../dws/client";
import { attendanceApprovalCollector } from "../dws/collectors/attendance-approval-collector";
import type { CollectedEvidence } from "./schema";

export type EmployeeDayStatus = "normal" | "full_leave" | "partial_leave" | "business_trip" | "outing";

export interface RefreshedDayStatus {
  status: EmployeeDayStatus;
  dwsValid: boolean;
}

export function classifyEmployeeDayStatus(evidences: CollectedEvidence[]): EmployeeDayStatus {
  let partialLeave = false;
  let businessTrip = false;
  let outing = false;
  for (const evidence of evidences) {
    if (evidence.sourceType !== "attendance" && evidence.sourceType !== "approval") continue;
    const text = `${evidence.title} ${evidence.summary}`;
    if (/请假|leave/i.test(text)) {
      if (/全天|全日|整天|(?:^|\D)1(?:\.0)?\s*天|8(?:\.0)?\s*小时|00:00.{0,40}(?:23:59|24:00)/i.test(text)) return "full_leave";
      partialLeave = true;
    }
    if (/出差|business\s*trip|travel/i.test(text)) businessTrip = true;
    if (/外出|outing|field\s*work/i.test(text)) outing = true;
  }
  if (partialLeave) return "partial_leave";
  if (businessTrip) return "business_trip";
  if (outing) return "outing";
  return "normal";
}

export class WorkStatusService {
  constructor(private readonly db: DatabaseSync) {}

  get(userId: number, workDate: string): EmployeeDayStatus {
    const row = this.db
      .prepare("SELECT status FROM employee_day_status WHERE user_id = ? AND work_date = ?")
      .get(userId, workDate) as { status: EmployeeDayStatus } | undefined;
    return row?.status ?? "normal";
  }

  save(userId: number, workDate: string, status: EmployeeDayStatus): void {
    this.db.prepare(
      `INSERT INTO employee_day_status (user_id, work_date, status, source, updated_at)
       VALUES (?, ?, ?, 'attendance_approval', ?)
       ON CONFLICT(user_id, work_date) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    ).run(userId, workDate, status, nowIso());
  }

  recordEvidence(userId: number, workDate: string, evidences: CollectedEvidence[]): EmployeeDayStatus {
    const status = classifyEmployeeDayStatus(evidences);
    this.save(userId, workDate, status);
    return status;
  }

  async refresh(user: SessionUser, workDate: string): Promise<RefreshedDayStatus> {
    const connection = await inspectDwsConnection({
      platformUserId: user.id,
      corpId: CONFIG.dingtalk.corpId,
      ddUserid: String(user.ddUserid ?? ""),
    });
    if (!connection.connected || !connection.profile || connection.state !== "connected") {
      return { status: this.get(user.id, workDate), dwsValid: false };
    }
    const result = await attendanceApprovalCollector.collect({
      platformUserId: user.id,
      ddUserid: String(user.ddUserid ?? ""),
      profile: connection.profile,
      workDate,
      historyWorkDates: [workDate],
      now: new Date(),
      run: (args, options) => runDwsForUser(user.id, args, options).then(parseDwsJson),
    });
    const status = result.status === "error" ? this.get(user.id, workDate) : this.recordEvidence(user.id, workDate, result.evidences);
    return { status, dwsValid: true };
  }
}
