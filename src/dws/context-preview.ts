/** 本人钉钉上下文的只读预览：待办、近期已发日志、今日 AI 听记。 */
import { addDaysYmd, todayYmd } from "../infra/workcal";

type JsonObject = Record<string, unknown>;

export type DwsPreviewSourceStatus = "ok" | "empty" | "partial" | "error";

export interface DwsPreviewItem {
  id: string;
  title: string;
  summary: string;
  occurredAt: string;
  link: string;
  meta: string[];
}

export interface DwsPreviewSource {
  status: DwsPreviewSourceStatus;
  label: string;
  scope: string;
  items: DwsPreviewItem[];
  error?: string;
}

export interface DwsContextPreview {
  generatedAt: string;
  date: string;
  status: "complete" | "partial" | "unavailable";
  sources: {
    todos: DwsPreviewSource;
    reports: DwsPreviewSource;
    minutes: DwsPreviewSource;
  };
}

export type DwsJsonRunner = (args: string[]) => Promise<JsonObject>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function pathValue(root: unknown, path: string): unknown {
  let value = root;
  for (const key of path.split(".")) {
    const current = object(value);
    if (!current) return undefined;
    value = current[key];
  }
  return value;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function pickText(root: unknown, paths: string[]): string {
  for (const path of paths) {
    const value = textValue(pathValue(root, path));
    if (value) return value;
  }
  return "";
}

function recordList(root: JsonObject, paths: string[]): JsonObject[] {
  for (const path of paths) {
    const value = pathValue(root, path);
    if (!Array.isArray(value)) continue;
    return value.map(object).filter((item): item is JsonObject => Boolean(item));
  }
  return [];
}

function requiredRecordList(root: JsonObject, paths: string[], label: string): JsonObject[] {
  for (const path of paths) {
    const value = pathValue(root, path);
    if (!Array.isArray(value)) continue;
    return value.map(object).filter((item): item is JsonObject => Boolean(item));
  }
  throw new Error(`schema_error:${label}`);
}

function shorten(value: string, max = 900): string {
  const normalized = value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function normalizeTime(value: string): string {
  if (!value) return "";
  if (/^\d{13}$/.test(value)) return new Date(Number(value)).toISOString();
  if (/^\d{10}$/.test(value)) return new Date(Number(value) * 1000).toISOString();
  return value;
}

function extractLink(value: string): string {
  const markdown = value.match(/\]\((https?:\/\/|dingtalk:\/\/)([^)]+)\)/i);
  if (markdown) return `${markdown[1]}${markdown[2]}`;
  return /^(https?:\/\/|dingtalk:\/\/)/i.test(value) ? value : "";
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/permission|forbidden|403|无权限/i.test(message)) return "当前账号无权限读取";
  if (/timed?\s*out|timeout/i.test(message)) return "读取超时，请稍后刷新";
  return "暂时无法读取";
}

function sourceStatus(items: DwsPreviewItem[], detailFailures = 0): DwsPreviewSourceStatus {
  if (detailFailures > 0) return items.length > 0 ? "partial" : "error";
  return items.length > 0 ? "ok" : "empty";
}

function priorityLabel(value: string): string {
  return value === "40" ? "紧急" : value === "30" ? "较高优先级" : value === "10" ? "低优先级" : "";
}

async function collectTodos(profile: string, run: DwsJsonRunner): Promise<DwsPreviewSource> {
  try {
    const payload = await run([
      "--profile", profile, "todo", "task", "list", "--page", "1", "--size", "20",
      "--status", "false", "--role-types", "executor", "--format", "json",
    ]);
    const items = requiredRecordList(payload, ["todos", "todoCards", "result.todoCards", "result.items", "items", "data.todoCards", "data.items", "result"], "todo.items").slice(0, 10).map((item, index) => {
      const dueAt = normalizeTime(pickText(item, ["dueTime", "planFinishTime", "planFinishDate", "finishTime"]));
      const priority = priorityLabel(pickText(item, ["priority", "priorityValue"]));
      const description = pickText(item, ["description", "desc", "content", "todoDetailModel.description"]);
      return {
        id: pickText(item, ["id", "taskId", "todoTaskId"]) || `todo-${index + 1}`,
        title: pickText(item, ["title", "subject", "todoTitle", "todoDetailModel.subject"]) || "未命名待办",
        summary: shorten(description, 500),
        occurredAt: dueAt,
        link: extractLink(pickText(item, ["url", "pcUrl", "mobileUrl", "dingTalkUrl"])),
        meta: [priority, dueAt ? "截止时间" : ""].filter(Boolean),
      };
    });
    return {
      status: sourceStatus(items),
      label: "待办",
      scope: "当前组织内本人未完成、本人为执行人的待办，最多展示 10 条",
      items,
    };
  } catch (err) {
    return { status: "error", label: "待办", scope: "当前组织内本人未完成待办", items: [], error: errorMessage(err) };
  }
}

function reportContent(root: unknown): string {
  const result = object(pathValue(root, "result")) ?? object(root);
  if (!result) return "";
  const fields = recordList(result, ["report_content", "reportContent"]);
  if (fields.length > 0) {
    return fields
      .map((field) => {
        const key = pickText(field, ["key", "name", "fieldName"]);
        const value = pickText(field, ["value", "content", "text"]);
        return value ? `${key ? `${key}：` : ""}${value}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return pickText(result, ["content", "summary", "text"]);
}

async function collectReports(profile: string, run: DwsJsonRunner, date: string): Promise<DwsPreviewSource> {
  try {
    const payload = await run([
      "--profile", profile, "report", "outbox", "list",
      "--start", `${addDaysYmd(date, -6)}T00:00:00+08:00`,
      "--end", `${date}T23:59:59+08:00`, "--cursor", "0", "--size", "7", "--format", "json",
    ]);
    const rows = recordList(payload, ["result", "result.items", "items", "data.items"]).slice(0, 3);
    const items = rows.map((item, index) => {
      const title = pickText(item, ["标题", "report_name", "reportName", "title", "report_template_name"]);
      const summary = reportContent(item) || pickText(item, ["日志内容", "content", "summary"]);
      const occurredAt = normalizeTime(
        pickText(item, ["日期", "createTime", "modifiedTime", "gmtCreate"]),
      );
      const link = extractLink(pickText(item, ["dingtalkOpenUrl", "钉钉链接", "url"]));
      const creator = pickText(item, ["发送人", "creatorName", "userName"]);
      return {
        id: pickText(item, ["reportId", "report_id", "id", "日志ID"]) || `report-${occurredAt || date}-${index + 1}`,
        title: title || "本人已发日志",
        summary: shorten(summary, 900),
        occurredAt,
        link,
        meta: [creator].filter(Boolean),
      };
    });
    return {
      status: sourceStatus(items),
      label: "近期日志",
      scope: "最近 7 天本人已发日志，最多展示最近 3 篇",
      items,
    };
  } catch (err) {
    return { status: "error", label: "近期日志", scope: "最近 7 天本人已发日志", items: [], error: errorMessage(err) };
  }
}

function summaryText(payload: JsonObject): string {
  const direct = pickText(payload, ["summary", "content", "text", "markdown", "result"]);
  if (direct) return direct;
  const result = pathValue(payload, "result");
  if (Array.isArray(result)) {
    return result.map((item) => pickText(item, ["summary", "content", "text", "value"])).filter(Boolean).join("\n");
  }
  return pickText(result, ["summary", "content", "text", "markdown", "recordSummary", "meetingSummary"]);
}

async function collectMinutes(profile: string, run: DwsJsonRunner, date: string): Promise<DwsPreviewSource> {
  try {
    const payload = await run([
      "--profile", profile, "minutes", "list", "all",
      "--start", `${date}T00:00:00+08:00`, "--end", `${date}T23:59:59+08:00`,
      "--limit", "5", "--format", "json",
    ]);
    const rows = recordList(payload, ["itemList", "result.itemList", "result.items", "result", "items", "data.items"]).slice(0, 5);
    const selected = rows.map((item) => ({ item, id: pickText(item, ["taskUuid", "uuid", "id"]) })).filter((entry) => entry.id);
    const details = await Promise.allSettled(
      selected.map((entry) => run(["--profile", profile, "minutes", "get", "summary", "--id", entry.id, "--format", "json"])),
    );
    let detailFailures = rows.length - selected.length;
    const items = selected.map((entry, index) => {
      const detail = details[index].status === "fulfilled" ? details[index].value : null;
      if (details[index].status === "rejected") detailFailures += 1;
      const item = entry.item;
      const occurredAt = normalizeTime(pickText(item, ["createTime", "startTime", "gmtCreate", "createdAt"]));
      const organization = pickText(item, ["organizationName", "orgName"]);
      const creator = pickText(item, ["creatorName", "ownerName"]);
      const link = extractLink(pickText(item, ["url", "shareUrl", "detailUrl"]));
      return {
        id: entry.id,
        title: pickText(item, ["title", "name", "subject"]) || "未命名听记",
        summary: detail ? shorten(summaryText(detail), 900) : "",
        occurredAt,
        link,
        meta: [organization, creator].filter(Boolean),
      };
    });
    return {
      status: sourceStatus(items, detailFailures),
      label: "AI 听记",
      scope: "今日本人可访问听记，最多展示 5 篇并读取 AI 摘要",
      items,
      error: detailFailures > 0 ? `${detailFailures} 篇摘要暂时无法读取` : undefined,
    };
  } catch (err) {
    return { status: "error", label: "AI 听记", scope: "今日本人可访问听记", items: [], error: errorMessage(err) };
  }
}

export async function collectDwsContextPreview(
  profile: string,
  run: DwsJsonRunner,
  now = new Date(),
): Promise<DwsContextPreview> {
  const date = todayYmd(now);
  const [todos, reports, minutes] = await Promise.all([
    collectTodos(profile, run),
    collectReports(profile, run, date),
    collectMinutes(profile, run, date),
  ]);
  const statuses = [todos.status, reports.status, minutes.status];
  const failed = statuses.filter((status) => status === "error").length;
  const partial = statuses.some((status) => status === "partial");
  return {
    generatedAt: now.toISOString(),
    date,
    status: failed === statuses.length ? "unavailable" : failed > 0 || partial ? "partial" : "complete",
    sources: { todos, reports, minutes },
  };
}
