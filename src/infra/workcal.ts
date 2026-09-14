/** 工作日历：周一至周五为工作日，扣除 holidays 表、加上 workdays_extra（调休补班）。时区固定 Asia/Shanghai。 */
import { getDb } from "./db";

const TZ = "Asia/Shanghai";

export function todayYmd(now = new Date()): string {
  return formatYmd(now);
}

export function formatYmd(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

export function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta, 12, 0, 0));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function weekdayOfYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

const WD_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function wdLabel(ymd: string): string {
  return WD_CN[weekdayOfYmd(ymd)];
}

export function isWorkday(ymd: string): boolean {
  const db = getDb();
  const extra = db.prepare("SELECT 1 AS x FROM workdays_extra WHERE date = ?").get(ymd);
  if (extra) return true;
  const holiday = db.prepare("SELECT 1 AS x FROM holidays WHERE date = ?").get(ymd);
  if (holiday) return false;
  const wd = weekdayOfYmd(ymd);
  return wd >= 1 && wd <= 5;
}

/** 严格早于 ymd 的最近一个工作日。 */
export function prevWorkday(ymd: string): string {
  let cur = addDaysYmd(ymd, -1);
  for (let i = 0; i < 60; i += 1) {
    if (isWorkday(cur)) return cur;
    cur = addDaysYmd(cur, -1);
  }
  return cur;
}

/** 最近 n 个工作日（含 endYmd 当天，若其为工作日），升序返回。 */
export function recentWorkdays(n: number, endYmd: string): string[] {
  const out: string[] = [];
  let cur = endYmd;
  for (let guard = 0; guard < 120 && out.length < n; guard += 1) {
    if (isWorkday(cur)) out.push(cur);
    cur = addDaysYmd(cur, -1);
  }
  return out.reverse();
}

/** 主管首页默认日：最近一个完整工作日（今天不算，即使今天是工作日）。 */
export function lastCompleteWorkday(now = new Date()): string {
  return prevWorkday(todayYmd(now));
}

/** ISO 周（采纳率按周统计） */
export function isoWeekOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function dateLabel(ymd: string): string {
  return `${ymd} ${wdLabel(ymd)}`;
}
