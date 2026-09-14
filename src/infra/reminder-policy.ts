export interface ReminderPolicy {
  enabled: boolean;
  scanIntervalMs: number;
  timezone: string;
  tier2AfterOverdueDays: number;
  quietHours: { startMin: number; endMin: number } | null;
  manualLlmEnabled: boolean;
  manualLlmTimeoutMs: number;
  weekdaysOnly: boolean;
  preDueHour: number;
  preDueMinute: number;
}

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (raw === "") return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envInt(name: string, defaultValue: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

/** Parse "HH:MM-HH:MM" into minutes-from-midnight; supports overnight ranges. */
export function parseQuietHours(raw: string): { startMin: number; endMin: number } | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  if (startMin < 0 || startMin >= 24 * 60 || endMin < 0 || endMin >= 24 * 60) return null;
  return { startMin, endMin };
}

export function isInQuietHours(
  now: Date,
  quiet: { startMin: number; endMin: number } | null,
  timezone?: string,
): boolean {
  if (!quiet) return false;
  const tz = timezone?.trim() || process.env.FOLLOWUP_TIMEZONE?.trim() || "Asia/Shanghai";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const cur = hour * 60 + minute;
  const { startMin, endMin } = quiet;
  if (startMin <= endMin) {
    return cur >= startMin && cur < endMin;
  }
  return cur >= startMin || cur < endMin;
}

export function loadReminderPolicy(): ReminderPolicy {
  const quietRaw = env("FOLLOWUP_QUIET_HOURS") || "22:00-08:00";
  return {
    enabled: envFlag("FOLLOWUP_REMINDER_ENABLED", false),
    scanIntervalMs: envInt("FOLLOWUP_SCAN_INTERVAL_MS", 300_000),
    timezone: env("FOLLOWUP_TIMEZONE") || "Asia/Shanghai",
    tier2AfterOverdueDays: envInt("FOLLOWUP_TIER2_AFTER_OVERDUE_DAYS", 1),
    quietHours: parseQuietHours(quietRaw),
    manualLlmEnabled: envFlag("FOLLOWUP_MANUAL_LLM_ENABLED", true),
    manualLlmTimeoutMs: envInt("FOLLOWUP_MANUAL_LLM_TIMEOUT_MS", 5000),
    weekdaysOnly: envFlag("FOLLOWUP_WEEKDAYS_ONLY", true),
    preDueHour: Math.min(23, Math.max(0, Number(env("FOLLOWUP_PRE_DUE_HOUR") || 10) | 0)),
    preDueMinute: Math.min(59, Math.max(0, Number(env("FOLLOWUP_PRE_DUE_MINUTE") || 0) | 0)),
  };
}

export function getLocalTimeParts(
  now: Date,
  timezone: string,
): { hour: number; minute: number; weekday: number; ymd: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const weekdayRaw = parts.find((p) => p.type === "weekday")?.value ?? "";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { hour, minute, weekday: weekdayMap[weekdayRaw] ?? 0, ymd };
}

export function isFollowupWeekdayAllowed(now: Date, policy: ReminderPolicy): boolean {
  if (!policy.weekdaysOnly) return true;
  const { weekday } = getLocalTimeParts(now, policy.timezone);
  return weekday !== 0 && weekday !== 6;
}

export function isPreDueSendWindow(now: Date, policy: ReminderPolicy): boolean {
  if (!isFollowupWeekdayAllowed(now, policy)) return false;
  const { hour, minute } = getLocalTimeParts(now, policy.timezone);
  const windowEndMinute =
    policy.preDueMinute + Math.ceil(policy.scanIntervalMs / 60_000);
  if (hour !== policy.preDueHour) return false;
  return minute >= policy.preDueMinute && minute < windowEndMinute;
}

/** YYYY-MM-DD in policy timezone. */
export function formatDateInTz(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Calendar YMD add/subtract (UTC date math on Y-M-D components). */
export function addDaysToYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + delta));
  return dt.toISOString().slice(0, 10);
}

function localYmdAndMinutes(ms: number, timezone: string): { ymd: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(pick("minute"));
  return {
    ymd: `${pick("year")}-${pick("month")}-${pick("day")}`,
    minutes: hour * 60 + minute,
  };
}

/** UTC ISO instant for local midnight at `ymd` in `timezone`. */
export function zonedMidnightUtcIso(ymd: string, timezone: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  let lo = Date.UTC(y!, m! - 1, d! - 1, 0, 0, 0);
  let hi = Date.UTC(y!, m! - 1, d! + 2, 0, 0, 0);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const { ymd: midYmd } = localYmdAndMinutes(mid, timezone);
    if (midYmd < ymd) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return new Date(lo).toISOString();
}

export function formatYmdDisplayInTz(ymd: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(zonedMidnightUtcIso(ymd, timezone)));
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${month}月${day}日`;
}

export type CalendarDayRange = {
  sinceIso: string;
  untilIso: string;
  labelYmd: string;
  labelDisplay: string;
};

/** Previous calendar day in timezone: [yesterday 00:00, today 00:00). */
export function previousCalendarDayRangeInTz(now: Date, timezone: string): CalendarDayRange {
  const todayYmd = formatDateInTz(now.toISOString(), timezone);
  const labelYmd = addDaysToYmd(todayYmd, -1);
  return {
    sinceIso: zonedMidnightUtcIso(labelYmd, timezone),
    untilIso: zonedMidnightUtcIso(todayYmd, timezone),
    labelYmd,
    labelDisplay: formatYmdDisplayInTz(labelYmd, timezone),
  };
}

export function startOfDayInTz(now: Date, timezone: string): string {
  const ymd = formatDateInTz(now.toISOString(), timezone);
  return zonedMidnightUtcIso(ymd, timezone);
}

/**
 * UTC ISO instant for a specific local HH:MM at `ymd` in `timezone`.
 * Uses binary search on Unix ms, same approach as zonedMidnightUtcIso.
 */
export function zonedLocalDateTimeUtcIso(
  ymd: string,
  hour: number,
  minute: number,
  timezone: string,
): string {
  // Search window: [ymd-1 00:00 UTC, ymd+2 00:00 UTC) — wide enough for any offset
  const [y, m, d] = ymd.split("-").map(Number);
  let lo = Date.UTC(y!, m! - 1, d! - 1, 0, 0, 0);
  let hi = Date.UTC(y!, m! - 1, d! + 2, 0, 0, 0);
  const targetMinutes = hour * 60 + minute;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const { ymd: midYmd, minutes } = localYmdAndMinutes(mid, timezone);
    if (midYmd < ymd || (midYmd === ymd && minutes < targetMinutes)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return new Date(lo).toISOString();
}

export type ReportDayRange = CalendarDayRange;

/**
 * Business-day range for `ymd`: [ymd cutoffHour:cutoffMinute, ymd+1 cutoffHour:cutoffMinute).
 * Reports submitted after cutoff on ymd count as ymd's report; reports submitted before
 * the cutoff on ymd+1 (next morning) also count as ymd. This matches the convention of
 * "submitting yesterday's work report the following morning".
 */
export function reportDayRangeForYmd(
  ymd: string,
  timezone: string,
  cutoffHour: number,
  cutoffMinute = 0,
): ReportDayRange {
  const nextYmd = addDaysToYmd(ymd, 1);
  return {
    sinceIso: zonedLocalDateTimeUtcIso(ymd, cutoffHour, cutoffMinute, timezone),
    untilIso: zonedLocalDateTimeUtcIso(nextYmd, cutoffHour, cutoffMinute, timezone),
    labelYmd: ymd,
    labelDisplay: formatYmdDisplayInTz(ymd, timezone),
  };
}
