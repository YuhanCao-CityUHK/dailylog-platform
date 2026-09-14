import {
  formatYmdDisplayInTz,
  getLocalTimeParts,
  previousCalendarDayRangeInTz,
  reportDayRangeForYmd,
} from "../infra/reminder-policy";
import type { DailyReportDigestConfig } from "./daily-report-config";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportTimeRange {
  /** Unix 毫秒，業務日開始時刻（本地時區 cutoffHour:cutoffMinute） */
  startTime: number;
  /** Unix 毫秒，業務日結束時刻（次日 cutoff 前 1ms，左閉右開） */
  endTime: number;
  /** YYYY-MM-DD（業務日，本地時區） */
  labelYmd: string;
  /** 友好展示，如 "6月8日" */
  labelDisplay: string;
}

export interface ReportRangeOpts {
  cutoffHour?: number;
  cutoffMinute?: number;
}

/** 是否处于「每天 sendHour:sendMinute」的发送窗口。
 * 规则：周二–周六 07:00 发「昨日」汇总；周六发周五；周日、周一不发。
 */
export function isDailyReportSendWindow(
  now: Date,
  config: DailyReportDigestConfig,
): boolean {
  const { hour, minute, weekday } = getLocalTimeParts(now, config.timezone);
  // 0=周日、1=周一不发；6=周六发（resolveReportRange 自然取周五）
  if (weekday === 0 || weekday === 1) return false;
  if (hour !== config.sendHour) return false;
  const windowEndMinute = config.sendMinute + Math.ceil(config.scanIntervalMs / 60_000);
  return minute >= config.sendMinute && minute < windowEndMinute;
}

/**
 * 解析「昨日」业务日的日志时间范围。
 * labelYmd 仍为上一自然日（与 7:00 早报「昨日」文案一致），
 * 但时间窗口改为 [昨日 cutoff, 今日 cutoff) 以支持次日上午补交计入昨日。
 */
export function resolveReportRange(
  now: Date,
  timezone: string,
  opts?: ReportRangeOpts,
): ReportTimeRange {
  const yesterday = previousCalendarDayRangeInTz(now, timezone);
  const cutoffHour = opts?.cutoffHour ?? 0;
  const cutoffMinute = opts?.cutoffMinute ?? 0;
  const range = reportDayRangeForYmd(yesterday.labelYmd, timezone, cutoffHour, cutoffMinute);
  return {
    startTime: Date.parse(range.sinceIso),
    endTime: Date.parse(range.untilIso) - 1,
    labelYmd: range.labelYmd,
    labelDisplay: range.labelDisplay,
  };
}

/** 解析指定某一天（YYYY-MM-DD，本地时区）的业务日日志时间范围。 */
export function resolveDayRangeForYmd(
  ymd: string,
  timezone: string,
  opts?: ReportRangeOpts,
): ReportTimeRange {
  if (!YMD_RE.test(ymd)) {
    throw new Error(`非法日期格式: ${ymd}（应为 YYYY-MM-DD）`);
  }
  const cutoffHour = opts?.cutoffHour ?? 0;
  const cutoffMinute = opts?.cutoffMinute ?? 0;
  const range = reportDayRangeForYmd(ymd, timezone, cutoffHour, cutoffMinute);
  return {
    startTime: Date.parse(range.sinceIso),
    endTime: Date.parse(range.untilIso) - 1,
    labelYmd: ymd,
    labelDisplay: formatYmdDisplayInTz(ymd, timezone),
  };
}
