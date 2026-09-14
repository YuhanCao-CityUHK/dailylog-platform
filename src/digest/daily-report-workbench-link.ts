import { normalizePublicPageUrl, wrapUrlForDingtalkClient } from "../infra/workbench-chat-link";

export type DailyReportsViewMode =
  | "project"
  | "company"
  | `custom:${string}`
  | `catalog:${string}`;
export type DailyReportsRolePath = "manager" | "employee" | "admin" | "neutral";

export function buildDailyReportsPublicUrl(input: {
  dateYmd: string;
  view?: DailyReportsViewMode;
  role?: DailyReportsRolePath;
}): string {
  const base = String(process.env.ASSIGNMENT_WEB_PUBLIC_BASE_URL ?? "").trim().replace(/\/$/, "");
  if (!base) return "";
  const role = input.role ?? "neutral";
  const path =
    role === "employee"
      ? "/workbench/employee/daily-reports"
      : role === "admin"
        ? "/workbench/admin/daily-reports"
        : role === "manager"
          ? "/workbench/manager/daily-reports"
          : "/workbench/daily-reports";
  const params = new URLSearchParams();
  if (input.dateYmd) params.set("date", input.dateYmd);
  params.set("view", input.view ?? "project");
  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

/** 钉钉 outbound（群 Markdown / 机器人卡片）：角色中立日报入口 + applink 内开。 */
export function buildDailyReportsPublicUrlForDingtalkOutbound(input: {
  dateYmd: string;
  view?: DailyReportsViewMode;
}): string {
  const direct = buildDailyReportsPublicUrl({ ...input, role: "neutral" });
  if (!direct) return "";
  return wrapUrlForDingtalkClient(normalizePublicPageUrl(direct));
}
