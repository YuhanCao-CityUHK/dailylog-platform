import { addDaysYmd } from "../infra/workcal";

/** 日报日期归属于窗口结束日；相邻窗口左闭右开，避免边界内容重复。 */
export function assistantReportingWindow(workDate: string): { start: string; end: string } {
  return {
    start: `${addDaysYmd(workDate, -1)}T17:30:00+08:00`,
    end: `${workDate}T17:30:00+08:00`,
  };
}

export function isInAssistantReportingWindow(value: string, workDate: string): boolean {
  const stamp = Date.parse(value);
  const window = assistantReportingWindow(workDate);
  return Number.isFinite(stamp) && stamp >= Date.parse(window.start) && stamp < Date.parse(window.end);
}

export const ASSISTANT_REPORTING_WINDOW_INSTRUCTION =
  "本日报的今天/today 指 workDate 对应的统计窗口：北京时间前一天17:30（含）至当天17:30（不含）。前一天17:30之后的证据属于本期，不得仅因日历日期为昨天而丢弃；窗口外的历史线索只作背景或待确认延续，不得写为本期已完成。";
