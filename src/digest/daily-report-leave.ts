import type { DailyReportOrgConfig } from "./daily-report-config";
import type { OrgDigest } from "./daily-report-build";
import {
  createDingTalkLeaveClient,
  type DingTalkLeaveClient,
  type LeaveStatusEntry,
} from "./dingtalk-leave-client";
import { logStructured } from "../infra/logger";

export interface EmployeeRef {
  userid: string;
  name: string;
}

/**
 * 公司标准工时：8:30–18:00，扣 1.5h 午休 = 8h 有效工时。
 * 全天请假 = 请满这 8h（或钉钉 percent_day 记 1 天）；1–2h、半天仍算未交。
 */
export const FULL_DAY_LEAVE_WORK_HOURS = 8;

/** percent_hour 的 duration_percent 以「百分之一小时」计（800 = 8 小时）。 */
export function leaveDurationHours(entry: LeaveStatusEntry): number | undefined {
  if (entry.durationUnit === "percent_day") {
    return (entry.durationPercent / 100) * FULL_DAY_LEAVE_WORK_HOURS;
  }
  if (entry.durationUnit === "percent_hour") {
    return entry.durationPercent / 100;
  }
  return undefined;
}

export function isFullDayLeave(entry: LeaveStatusEntry): boolean {
  const hours = leaveDurationHours(entry);
  if (hours == null) return false;
  return hours >= FULL_DAY_LEAVE_WORK_HOURS;
}

/** 请假时段与查询窗口是否有交集。 */
export function leaveOverlapsWindow(
  entry: LeaveStatusEntry,
  startTime: number,
  endTime: number,
): boolean {
  if (!entry.startTime || !entry.endTime) return false;
  return entry.startTime < endTime && entry.endTime > startTime;
}

/** 从 missing 中拆出全天请假的员工（纯函数，便于测试）。 */
export function splitMissingByFullDayLeave(
  missing: EmployeeRef[],
  leaveEntries: LeaveStatusEntry[],
  window: { startTime: number; endTime: number },
): { missing: EmployeeRef[]; onLeave: EmployeeRef[] } {
  const fullDayUserIds = new Set<string>();
  for (const entry of leaveEntries) {
    if (!isFullDayLeave(entry)) continue;
    if (!leaveOverlapsWindow(entry, window.startTime, window.endTime)) continue;
    if (entry.userid) fullDayUserIds.add(entry.userid);
  }
  const onLeave: EmployeeRef[] = [];
  const stillMissing: EmployeeRef[] = [];
  for (const m of missing) {
    if (fullDayUserIds.has(m.userid)) onLeave.push(m);
    else stillMissing.push(m);
  }
  return { missing: stillMissing, onLeave };
}

export async function applyLeaveToOrgDigests(
  orgDigests: OrgDigest[],
  orgConfigs: DailyReportOrgConfig[],
  window: { startTime: number; endTime: number },
  opts?: {
    enabled?: boolean;
    leaveClient?: DingTalkLeaveClient;
    fetchImpl?: typeof fetch;
  },
): Promise<OrgDigest[]> {
  if (opts?.enabled === false) return orgDigests;
  const client = opts?.leaveClient ?? createDingTalkLeaveClient({ fetchImpl: opts?.fetchImpl });
  const configByLabel = new Map(orgConfigs.map((o) => [o.label, o]));

  return Promise.all(
    orgDigests.map(async (digest) => {
      if (digest.missing.length === 0) {
        return { ...digest, onLeave: digest.onLeave ?? [] };
      }
      const org = configByLabel.get(digest.label);
      if (!org) return { ...digest, onLeave: digest.onLeave ?? [] };
      const userids = digest.missing.map((m) => m.userid);
      try {
        const leaveEntries = await client.fetchLeaveStatus({
          appKey: org.appKey,
          appSecret: org.appSecret,
          userids,
          startTime: window.startTime,
          endTime: window.endTime,
        });
        const split = splitMissingByFullDayLeave(digest.missing, leaveEntries, window);
        return { ...digest, missing: split.missing, onLeave: split.onLeave };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logStructured({
          event: "daily_report_leave_fetch_failed",
          org: digest.label,
          reason,
        });
        return { ...digest, onLeave: digest.onLeave ?? [] };
      }
    }),
  );
}
