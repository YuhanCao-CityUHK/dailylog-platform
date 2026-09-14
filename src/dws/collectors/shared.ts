import { assistantReportingWindow, isInAssistantReportingWindow } from "../../assistant/reporting-window";
import { CONFIG } from "../../infra/config";
import type {
  CollectedEvidence,
  CollectorInput,
  CollectorResult,
  CollectorSourceType,
  EvidenceRelationToSelf,
  EvidenceSenderKind,
  JsonObject,
} from "../../assistant/schema";

export function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function pathValue(root: unknown, path: string): unknown {
  let value = root;
  for (const key of path.split(".")) {
    const current = object(value);
    if (!current) return undefined;
    value = current[key];
  }
  return value;
}

export function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function pickText(root: unknown, paths: string[]): string {
  for (const path of paths) {
    const value = textValue(pathValue(root, path));
    if (value) return value;
  }
  return "";
}

export function recordList(root: JsonObject, paths: string[]): JsonObject[] {
  for (const path of paths) {
    const value = pathValue(root, path);
    if (!Array.isArray(value)) continue;
    return value.map(object).filter((item): item is JsonObject => Boolean(item));
  }
  return [];
}

export function requiredRecordList(root: JsonObject, paths: string[], label: string): JsonObject[] {
  for (const path of paths) {
    const value = pathValue(root, path);
    if (!Array.isArray(value)) continue;
    return value.map(object).filter((item): item is JsonObject => Boolean(item));
  }
  throw Object.assign(new Error(`schema_error:${label}`), {
    safeCode: "schema_error",
    failureStage: "response_validation",
  });
}

export function firstRecord(root: JsonObject, paths: string[]): JsonObject | null {
  for (const path of paths) {
    const value = pathValue(root, path);
    const direct = object(value);
    if (direct) return direct;
    if (Array.isArray(value)) {
      const first = value.map(object).find((item): item is JsonObject => Boolean(item));
      if (first) return first;
    }
  }
  return null;
}

export function stringList(root: unknown, paths: string[]): string[] {
  for (const path of paths) {
    const value = pathValue(root, path);
    if (!Array.isArray(value)) continue;
    return value
      .map((item) => (typeof item === "object" ? pickText(item, ["name", "userName", "displayName"]) : textValue(item)))
      .filter(Boolean);
  }
  return [];
}

export function identifierList(root: unknown, paths: string[]): string[] {
  for (const path of paths) {
    const value = pathValue(root, path);
    if (!Array.isArray(value)) continue;
    return value.map((item) => {
      if (typeof item !== "object") return textValue(item);
      return pickText(item, ["userId", "userid", "id", "staffId", "openDingTalkId", "openDingtalkId", "openId", "unionId"]);
    }).filter(Boolean);
  }
  return [];
}

export function identifierAliases(root: unknown, paths: string[]): string[] {
  const fromObject = (value: object): string[] => [
    "userId", "userid", "staffId", "openDingTalkId", "openDingtalkId", "openId", "unionId", "id",
  ]
    .map((key) => textValue((value as JsonObject)[key]))
    .filter(Boolean);
  const values = paths.flatMap((path) => {
    const value = pathValue(root, path);
    if (Array.isArray(value)) {
      return value.flatMap((item) => item && typeof item === "object" ? fromObject(item) : [textValue(item)]);
    }
    if (value && typeof value === "object") {
      return fromObject(value);
    }
    return [textValue(value)];
  });
  return [...new Set(values.filter(Boolean))];
}

export function listSize(root: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = pathValue(root, path);
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

export function classifyMessageRelation(input: {
  senderId: string;
  senderIds?: string[];
  senderType: string;
  messageType: string;
  content: string;
  ddUserid: string;
  selfUserIds?: string[];
  displayName?: string;
  atUserIds?: string[];
  assigneeUserIds?: string[];
  repliedUserId?: string;
  repliedUserIds?: string[];
}): { relationToSelf: EvidenceRelationToSelf; senderKind: EvidenceSenderKind } {
  const senderIds = [...new Set([input.senderId, ...(input.senderIds ?? [])].map((value) => value.trim()).filter(Boolean))];
  const selfUserIds = new Set([input.ddUserid, ...(input.selfUserIds ?? [])].map((value) => value.trim()).filter(Boolean));
  const explicitBot = /bot|robot|application|app|system|机器人|应用/i.test(`${input.senderType} ${input.messageType}`)
    || senderIds.some((senderId) => CONFIG.assistant.botSenderIds.includes(senderId));
  if (senderIds.some((senderId) => selfUserIds.has(senderId))) return { relationToSelf: "self", senderKind: "user" };
  if (senderIds.length === 0 || explicitBot) {
    return { relationToSelf: "bot_or_unknown", senderKind: explicitBot ? "bot" : "unknown" };
  }
  const nameMentioned = Boolean(input.displayName && input.content.includes(`@${input.displayName}`));
  const addressedIds = [
    ...(input.atUserIds ?? []),
    ...(input.assigneeUserIds ?? []),
    input.repliedUserId ?? "",
    ...(input.repliedUserIds ?? []),
  ];
  const addressed = addressedIds.some((value) => selfUserIds.has(value.trim())) || nameMentioned;
  return { relationToSelf: addressed ? "addressed" : "others", senderKind: "user" };
}

export function looksLikeWorkAssignment(content: string): boolean {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length < 4 || text.length > 800) return false;
  const action = "跟进|处理|确认|提供|提交|完成|整理|准备|审批|修改|回复|安排|检查|核对|发布|发送|更新|修复|对接|推进|排查|申请|采购|配置|设计|统计|反馈";
  return /(?:请|麻烦|辛苦|务必|尽快)(?:你|您|大家|协助|帮忙|跟进|处理|确认|提供|提交|完成|整理|准备|审批|修改|回复|安排|检查|核对|发布|发送|更新|修复)/i.test(text)
    || /(?:需要你|由你|你来|交给你|安排给你|指派给你).{0,30}(?:跟进|处理|确认|提供|提交|完成|整理|准备|审批|修改|回复|检查|核对|发布|发送|更新|修复)?/i.test(text)
    || new RegExp(`(?:${action})(?:一下|下|好|掉|完|吧|哈|哦|先|尽快|今天|明天|本周|下午|下班前|之前)(?:[，。！？!?, ]|$)`, "i").test(text)
    || new RegExp(`(?:今天|明天|本周|下午|下班前|周[一二三四五六日天]).{0,30}(?:${action})`, "i").test(text)
    || new RegExp(`(?:要|需要|得|计划).{0,24}(?:${action})`, "i").test(text)
    || /(?:please|need you to|assigned to you)\b.{0,60}(?:follow up|handle|confirm|provide|submit|complete|prepare|review|reply|update|fix)/i.test(text);
}

export function shorten(value: string, max = 800): string {
  const normalized = value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

export function normalizeTime(value: string): string {
  if (!value) return "";
  if (/^\d{13}$/.test(value)) return new Date(Number(value)).toISOString();
  if (/^\d{10}$/.test(value)) return new Date(Number(value) * 1000).toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

export function safeLink(value: string): string | undefined {
  const markdown = value.match(/\]\(((?:https?:\/\/|dingtalk:\/\/)[^)]+)\)/i);
  const link = markdown?.[1] ?? value;
  return /^(https?:\/\/|dingtalk:\/\/)/i.test(link) ? link : undefined;
}

export function dayWindow(workDate: string): { start: string; end: string } {
  return assistantReportingWindow(workDate);
}

export function happenedOnWorkDate(value: string, workDate: string): boolean {
  if (!value) return false;
  return isInAssistantReportingWindow(normalizeTime(value), workDate);
}

export function payloadHasMore(payload: JsonObject): boolean {
  const direct = ["hasMore", "has_more", "result.hasMore", "result.has_more", "data.hasMore"];
  if (direct.some((path) => pathValue(payload, path) === true)) return true;
  if (direct.some((path) => pathValue(payload, path) === false)) return false;
  return Boolean(pickText(payload, [
    "nextCursor", "next_cursor", "nextPageToken", "nextToken",
    "result.nextCursor", "result.next_cursor", "result.nextPageToken", "result.nextToken",
    "data.nextCursor", "data.nextPageToken", "data.nextToken",
  ]));
}

export function payloadPagesFetched(payload: JsonObject): number {
  for (const path of [
    "pagesFetched", "pages_fetched", "pagesRead", "pageCount", "page_count",
    "meta.pagination.pagesFetched", "meta.pagination.pages_fetched",
    "result.pagesFetched", "result.pagesRead", "data.pagesFetched", "data.pagesRead",
  ]) {
    const value = pathValue(payload, path);
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return 1;
}

export function payloadComplete(payload: JsonObject): boolean {
  for (const path of [
    "complete", "isComplete", "autoPageComplete", "result.complete",
    "data.complete", "data.autoPageComplete", "meta.pagination.complete",
  ]) {
    const value = pathValue(payload, path);
    if (value === true) return true;
    if (value === false) return false;
  }
  return !payloadHasMore(payload) && payloadFailureCount(payload) === 0 && !payloadStopReason(payload);
}

export function payloadFailureCount(payload: JsonObject): number {
  for (const path of ["failedCount", "result.failedCount", "data.failedCount"]) {
    const direct = pathValue(payload, path);
    if (typeof direct === "number" && Number.isFinite(direct)) return Math.max(0, Math.trunc(direct));
  }
  for (const path of ["failures", "result.failures", "data.failures"]) {
    const failures = pathValue(payload, path);
    if (Array.isArray(failures)) return failures.length;
  }
  return 0;
}

export function payloadStopReason(payload: JsonObject): string | undefined {
  const reason = pickText(payload, [
    "stopReason", "autoPageStopReason", "result.stopReason", "data.stopReason",
    "data.autoPageStopReason", "meta.pagination.stop_reason", "meta.pagination.stopReason",
  ]);
  if (reason) return reason;
  if (pathValue(payload, "truncated") === true) return "result_limit";
  if (pathValue(payload, "complete") === false || pathValue(payload, "partial") === true) return "incomplete_ledger";
  return undefined;
}

export function sourceResult(
  source: CollectorSourceType,
  evidences: CollectedEvidence[],
  options: {
    failures?: number;
    errorCode?: string;
    allowEmptyPartial?: boolean;
    hasMore?: boolean;
    pagesFetched?: number;
    stopReason?: string;
    failureStage?: string;
    complete?: boolean;
    itemCount?: number;
    details?: import("../../assistant/schema").ChatConversationLedger[];
  } = {},
): CollectorResult {
  const failures = Math.max(0, options.failures ?? 0);
  const complete = options.complete ?? (failures === 0 && !options.hasMore && !options.stopReason);
  const boundedPartial = !complete || Boolean(options.hasMore || options.stopReason);
  const stopReason = options.stopReason ?? (failures > 0 ? options.errorCode ?? "detail_failed" : undefined);
  const status = failures > 0
    ? (evidences.length > 0 || options.allowEmptyPartial ? "partial" : "error")
    : boundedPartial
      ? "partial"
      : evidences.length > 0
        ? "complete"
        : "empty";
  return {
    source,
    status,
    evidences: evidences.map((evidence) => ({
      ...evidence,
      sourceCompleteness: evidence.sourceCompleteness
        ?? (status === "complete" || status === "empty" ? "complete" : "partial"),
    })),
    errorCode: failures > 0 ? (options.errorCode ?? "detail_failed") : undefined,
    failureStage: failures > 0
      ? (options.failureStage ?? "detail")
      : boundedPartial
        ? "pagination"
        : undefined,
    completeness: {
      complete: status === "complete" || status === "empty",
      hasMore: Boolean(options.hasMore),
      failures,
      pagesFetched: options.pagesFetched ?? 1,
      itemCount: options.itemCount ?? evidences.length,
      stopReason,
      details: options.details,
    },
  };
}

export function collectorErrorCode(error: unknown): string {
  const structured = error as { safeCode?: unknown } | null;
  if (structured && typeof structured.safeCode === "string") return structured.safeCode;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/identity_mismatch/i.test(message)) return "identity_mismatch";
  if (/permission|forbidden|403|无权限/i.test(message)) return "permission_denied";
  if (/abort|取消/i.test(message)) return "aborted";
  if (/timed?\s*out|timeout/i.test(message)) return "timeout";
  if (/schema|json|字段/i.test(message)) return "schema_error";
  return "collector_failed";
}

export function primaryFailureCode(errors: unknown[]): string | undefined {
  const codes = errors.map(collectorErrorCode);
  const priority = [
    "schema_error",
    "identity_mismatch",
    "unauthenticated",
    "permission_denied",
    "timeout",
    "rate_limited",
    "service_unavailable",
    "dws_unavailable",
    "collector_failed",
  ];
  return priority.find((code) => codes.includes(code)) ?? codes[0];
}

export function primaryFailureStage(errors: unknown[]): string | undefined {
  for (const error of errors) {
    const structured = error as { failureStage?: unknown } | null;
    if (structured && typeof structured.failureStage === "string" && structured.failureStage.trim()) {
      return structured.failureStage.trim().slice(0, 80);
    }
  }
  return undefined;
}

export function errorResult(source: CollectorSourceType, error: unknown): CollectorResult {
  const code = collectorErrorCode(error);
  const structured = error as { failureStage?: unknown } | null;
  return {
    source,
    status: "error",
    evidences: [],
    errorCode: code,
    failureStage: structured && typeof structured.failureStage === "string"
      ? structured.failureStage.slice(0, 80)
      : "command",
    errorMessage:
      code === "permission_denied"
        ? "当前账号无权限读取"
        : code === "timeout"
          ? "读取超时"
          : code === "aborted"
            ? "读取已取消"
            : "暂时无法读取",
    completeness: {
      complete: false,
      hasMore: false,
      stopReason: code,
      failures: 1,
      pagesFetched: 0,
      itemCount: 0,
    },
  };
}

function retryMetadata(error: unknown): { retryable: boolean; delayMs: number } {
  const structured = error as { retryable?: unknown; retryAfterMs?: unknown } | null;
  const delay = structured && typeof structured.retryAfterMs === "number" && Number.isFinite(structured.retryAfterMs)
    ? Math.max(0, Math.min(5_000, Math.trunc(structured.retryAfterMs)))
    : 0;
  return { retryable: structured?.retryable === true, delayMs: delay };
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { safeCode: "aborted", failureStage: "retry_wait" }));
    }, { once: true });
  });
}

export async function runCommand(
  input: CollectorInput,
  args: string[],
  timeoutMs = 15_000,
): Promise<JsonObject> {
  const fullArgs = ["--profile", input.profile, ...args, "--format", "json"];
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      return await input.run(fullArgs, { timeoutMs, signal: input.signal });
    } catch (error) {
      const retry = retryMetadata(error);
      if (!retry.retryable || input.signal?.aborted || attempt === 2) throw error;
      await waitForRetry(retry.delayMs, input.signal);
    }
  }
  throw new Error("unreachable");
}

export interface PaginatedCommandResult {
  pages: JsonObject[];
  complete: boolean;
  hasMore: boolean;
  failures: number;
  pagesFetched: number;
  stopReason?: string;
  error?: unknown;
}

export async function runPaginatedCommand(
  input: CollectorInput,
  argsForPage: (pageIndex: number, previous?: JsonObject) => string[] | null,
  options: { maxPages?: number; timeoutMs?: number } = {},
): Promise<PaginatedCommandResult> {
  const maxPages = Math.max(1, Math.min(100, Math.trunc(options.maxPages ?? 20)));
  const pages: JsonObject[] = [];
  const seenCommands = new Set<string>();
  let failures = 0;
  let pagesFetched = 0;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const args = argsForPage(pageIndex, pages.at(-1));
    if (!args) {
      return { pages, complete: false, hasMore: true, failures, pagesFetched, stopReason: "pagination_cursor_missing" };
    }
    const commandKey = JSON.stringify(args);
    if (seenCommands.has(commandKey)) {
      return { pages, complete: false, hasMore: true, failures, pagesFetched, stopReason: "pagination_cursor_stalled" };
    }
    seenCommands.add(commandKey);

    let payload: JsonObject;
    try {
      payload = await runCommand(input, args, options.timeoutMs);
    } catch (error) {
      if (pages.length === 0) throw error;
      return {
        pages,
        complete: false,
        hasMore: true,
        failures: failures + 1,
        pagesFetched,
        stopReason: collectorErrorCode(error),
        error,
      };
    }

    pages.push(payload);
    failures += payloadFailureCount(payload);
    pagesFetched += payloadPagesFetched(payload);
    if (!payloadHasMore(payload)) {
      return {
        pages,
        complete: payloadComplete(payload) && failures === 0,
        hasMore: false,
        failures,
        pagesFetched,
        stopReason: payloadStopReason(payload),
      };
    }
  }

  return { pages, complete: false, hasMore: true, failures, pagesFetched, stopReason: "page_limit" };
}

export function projectSignals(...values: string[]): string[] {
  return [...new Set(values.map((value) => shorten(value, 120)).filter(Boolean))].slice(0, 6);
}
