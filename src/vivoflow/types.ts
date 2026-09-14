export interface VivoProject { id: string; name: string; status: string; productLine?: string | null; }
export interface VivoProgress { id: string; createdAt: string; staff: { id: string; name: string }; content: unknown; attachmentCount?: number; }
export interface VivoTask {
  id: string; name: string; status: string; phase: string; riskFlag: string | null;
  startDate: string | null; endDate: string | null; assignee: { id: string; name?: string } | null;
  parentTaskId: string | null; depth: number; directChildCount: number;
}
export interface TaskSummary extends VivoTask {
  sourceProjectId: string; sourceProjectName: string; url: string; overdue: boolean;
  progress: Array<{ id: string; createdAt: string; author: string; text: string; attachmentCount: number }>;
  progressComplete: boolean;
}
export interface ProjectSnapshot {
  date: string; syncedAt: string; projects: VivoProject[]; tasks: TaskSummary[];
  complete: boolean; warnings: string[];
}
export class VivoError extends Error {
  constructor(public code: string, message: string, public status = 502) { super(message); }
}
export function entityId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,29}$/.test(value)) throw new VivoError("invalid_id", "项目或任务编号无效", 400);
  return value;
}
export function workDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new VivoError("invalid_date", "请选择有效日期", 400);
  }
  return value;
}
export function beijingDate(value = new Date()): string {
  return new Date(value.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
/** 只提取富文本正文，不执行来源中的 HTML，不持久化附件签名地址。 */
export function progressText(value: unknown, depth = 0): string {
  if (depth > 20 || value == null) return "";
  if (typeof value === "string") return value.slice(0, 12000);
  if (Array.isArray(value)) return value.map((item) => progressText(item, depth + 1)).filter(Boolean).join("\n").slice(0, 12000);
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row.text === "string") return row.text.slice(0, 12000);
    if (row.type === "hardBreak") return "\n";
    return progressText(row.content, depth + 1);
  }
  return "";
}
