/**
 * 钉钉考勤「查询请假状态」客户端。
 * API: POST oapi.dingtalk.com/topapi/attendance/getleavestatus
 * 需应用开通「查询企业考勤数据」权限（qyapi_get_attendance_data）。
 */
import { createDingTalkReportClient } from "./dingtalk-report-client";

export interface LeaveStatusEntry {
  userid: string;
  startTime: number;
  endTime: number;
  durationUnit: string;
  durationPercent: number;
}

interface LeaveListResp {
  errcode?: number;
  errmsg?: string;
  result?: {
    has_more?: boolean;
    leave_status?: Array<Record<string, unknown>>;
    next_cursor?: number;
  };
}

const PAGE_SIZE = 20;
const MAX_PAGES = 10;

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function normalizeLeaveEntry(raw: Record<string, unknown>): LeaveStatusEntry {
  return {
    userid: asString(raw.userid),
    startTime: Number(raw.start_time ?? raw.startTime ?? 0) || 0,
    endTime: Number(raw.end_time ?? raw.endTime ?? 0) || 0,
    durationUnit: asString(raw.duration_unit ?? raw.durationUnit),
    durationPercent: Number(raw.duration_percent ?? raw.durationPercent ?? 0) || 0,
  };
}

export function createDingTalkLeaveClient(opts?: { fetchImpl?: typeof fetch }) {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const reportClient = createDingTalkReportClient({ fetchImpl });

  async function fetchLeaveStatus(params: {
    appKey: string;
    appSecret: string;
    userids: string[];
    startTime: number;
    endTime: number;
  }): Promise<LeaveStatusEntry[]> {
    if (params.userids.length === 0) return [];
    const token = await reportClient.getAccessToken(params.appKey, params.appSecret);
    const entries: LeaveStatusEntry[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await fetchImpl(
        `https://oapi.dingtalk.com/topapi/attendance/getleavestatus?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userid_list: params.userids.join(","),
            start_time: params.startTime,
            end_time: params.endTime,
            offset,
            size: PAGE_SIZE,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as LeaveListResp;
      if (!res.ok || (typeof data.errcode === "number" && data.errcode !== 0)) {
        throw new Error(
          `getleavestatus failed: ${res.status} ${JSON.stringify({
            errcode: data.errcode,
            errmsg: data.errmsg,
          })}`,
        );
      }
      const list = data.result?.leave_status ?? [];
      for (const item of list) entries.push(normalizeLeaveEntry(item));
      if (!data.result?.has_more || list.length === 0) break;
      offset += PAGE_SIZE;
    }
    return entries;
  }

  return { fetchLeaveStatus };
}

export type DingTalkLeaveClient = ReturnType<typeof createDingTalkLeaveClient>;
