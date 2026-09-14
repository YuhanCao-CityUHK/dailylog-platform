import {
  AssistantV2Error,
  DRAFT_OPERATION_NAMES,
  type AgentWorkStatus,
  type DraftOperation,
  type PatchRequest,
  type ReplyFocus,
  type ReplyFocusField,
  type ReplyPayload,
  type ReplyQuestionKind,
} from "./types";

const FOCUS_FIELDS = new Set<ReplyFocusField>([
  "today", "result", "hours", "project", "status", "blocker", "next_action", "support",
  "person", "finance_code", "tomorrow_plan", "outside_work", "submit", "clarify_target",
]);
const QUESTION_KINDS = new Set<ReplyQuestionKind>(["ask_missing", "clarify", "confirm_submit", "none"]);
const WORK_STATUSES = new Set<AgentWorkStatus>(["completed", "in_progress", "blocked", "no_progress"]);
const OP_NAMES = new Set<string>(DRAFT_OPERATION_NAMES);

function schemaError(message: string): never {
  throw new AssistantV2Error("invalid_tool_arguments", message, true);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) schemaError(`${label} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allow = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allow.has(key));
  if (extra.length) schemaError(`${label} 包含未知字段：${extra.join("、")}`);
}

function requiredText(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== "string") schemaError(`${label} 必须是字符串`);
  const text = value.normalize("NFKC").trim();
  if (!text) schemaError(`${label} 不能为空`);
  if (text.length > max) schemaError(`${label} 不能超过 ${max} 字`);
  return text;
}

function optionalText(value: unknown, label: string, max = 2_000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") schemaError(`${label} 必须是字符串`);
  const text = value.normalize("NFKC").trim();
  if (text.length > max) schemaError(`${label} 不能超过 ${max} 字`);
  return text;
}

function stringList(value: unknown, label: string, min = 0, max = 20): string[] {
  if (!Array.isArray(value)) schemaError(`${label} 必须是字符串数组`);
  const result = value.map((entry, index) => requiredText(entry, `${label}[${index}]`, 200));
  if (result.length < min || result.length > max) schemaError(`${label} 数量必须在 ${min} 到 ${max} 之间`);
  return result;
}

function itemId(value: unknown): string {
  return requiredText(value, "itemId", 160);
}

function hoursValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 24) {
    schemaError("hours 必须是 0 到 24 之间的数字");
  }
  return Math.round(value * 100) / 100;
}

function projectIdValue(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) schemaError("projectId 必须是正整数或 null");
  return value;
}

function statusValue(value: unknown): AgentWorkStatus {
  if (typeof value !== "string" || !WORK_STATUSES.has(value as AgentWorkStatus)) schemaError("status 不在允许枚举中");
  return value as AgentWorkStatus;
}

function parseOperation(value: unknown, index: number): DraftOperation {
  const input = objectValue(value, `operations[${index}]`);
  if (typeof input.op !== "string" || !OP_NAMES.has(input.op)) schemaError(`operations[${index}].op 不受支持`);
  const label = `operations[${index}]`;
  switch (input.op) {
    case "add_item": {
      exactKeys(input, ["op", "summary", "result", "hours", "projectId", "status", "blocker", "nextAction", "tomorrowPlan"], label);
      return {
        op: "add_item",
        summary: requiredText(input.summary, `${label}.summary`),
        ...(input.result !== undefined ? { result: optionalText(input.result, `${label}.result`) } : {}),
        ...(input.hours !== undefined ? { hours: input.hours === null ? null : hoursValue(input.hours) } : {}),
        ...(input.projectId !== undefined ? { projectId: projectIdValue(input.projectId) } : {}),
        ...(input.status !== undefined ? { status: statusValue(input.status) } : {}),
        ...(input.blocker !== undefined ? { blocker: optionalText(input.blocker, `${label}.blocker`) } : {}),
        ...(input.nextAction !== undefined ? { nextAction: optionalText(input.nextAction, `${label}.nextAction`) } : {}),
        ...(input.tomorrowPlan !== undefined ? { tomorrowPlan: optionalText(input.tomorrowPlan, `${label}.tomorrowPlan`) } : {}),
      };
    }
    case "delete_item":
      exactKeys(input, ["op", "itemId", "reason"], label);
      return { op: "delete_item", itemId: itemId(input.itemId), ...(input.reason !== undefined ? { reason: optionalText(input.reason, `${label}.reason`) } : {}) };
    case "update_summary":
      exactKeys(input, ["op", "itemId", "summary"], label);
      return { op: "update_summary", itemId: itemId(input.itemId), summary: requiredText(input.summary, `${label}.summary`) };
    case "set_result":
      exactKeys(input, ["op", "itemId", "result"], label);
      return { op: "set_result", itemId: itemId(input.itemId), result: requiredText(input.result, `${label}.result`) };
    case "set_hours":
      exactKeys(input, ["op", "itemId", "hours"], label);
      return { op: "set_hours", itemId: itemId(input.itemId), hours: hoursValue(input.hours) };
    case "set_project":
      exactKeys(input, ["op", "itemId", "projectId"], label);
      return { op: "set_project", itemId: itemId(input.itemId), projectId: projectIdValue(input.projectId) };
    case "set_finance_code":
      exactKeys(input, ["op", "itemId", "financeCodeId"], label);
      if (typeof input.financeCodeId !== "number" || !Number.isSafeInteger(input.financeCodeId) || input.financeCodeId <= 0) {
        schemaError(`${label}.financeCodeId 必须是正整数`);
      }
      return { op: "set_finance_code", itemId: itemId(input.itemId), financeCodeId: input.financeCodeId };
    case "set_status":
      exactKeys(input, ["op", "itemId", "status"], label);
      return { op: "set_status", itemId: itemId(input.itemId), status: statusValue(input.status) };
    case "set_blocker":
      exactKeys(input, ["op", "itemId", "blocker", "nextAction", "supportNeeded", "supportPeople"], label);
      return {
        op: "set_blocker",
        itemId: itemId(input.itemId),
        blocker: optionalText(input.blocker, `${label}.blocker`) ?? "",
        ...(input.nextAction !== undefined ? { nextAction: optionalText(input.nextAction, `${label}.nextAction`) } : {}),
        ...(input.supportNeeded !== undefined ? { supportNeeded: optionalText(input.supportNeeded, `${label}.supportNeeded`) } : {}),
        ...(input.supportPeople !== undefined ? { supportPeople: stringList(input.supportPeople, `${label}.supportPeople`) } : {}),
      };
    case "set_next_action":
      exactKeys(input, ["op", "itemId", "nextAction"], label);
      return { op: "set_next_action", itemId: itemId(input.itemId), nextAction: requiredText(input.nextAction, `${label}.nextAction`) };
    case "set_support":
      exactKeys(input, ["op", "itemId", "supportNeeded", "supportPeople"], label);
      return {
        op: "set_support",
        itemId: itemId(input.itemId),
        supportNeeded: optionalText(input.supportNeeded, `${label}.supportNeeded`) ?? "",
        ...(input.supportPeople !== undefined ? { supportPeople: stringList(input.supportPeople, `${label}.supportPeople`) } : {}),
      };
    case "set_tomorrow_plan":
      exactKeys(input, ["op", "itemId", "tomorrowPlan"], label);
      return { op: "set_tomorrow_plan", itemId: itemId(input.itemId), tomorrowPlan: requiredText(input.tomorrowPlan, `${label}.tomorrowPlan`) };
    case "merge_items":
      exactKeys(input, ["op", "itemIds", "summary"], label);
      return {
        op: "merge_items",
        itemIds: stringList(input.itemIds, `${label}.itemIds`, 2, 20),
        ...(input.summary !== undefined ? { summary: requiredText(input.summary, `${label}.summary`) } : {}),
      };
    case "split_item":
      exactKeys(input, ["op", "itemId", "summaries"], label);
      return { op: "split_item", itemId: itemId(input.itemId), summaries: stringList(input.summaries, `${label}.summaries`, 2, 20) };
    case "confirm_items":
      exactKeys(input, ["op", "itemIds"], label);
      return { op: "confirm_items", itemIds: input.itemIds === "all" ? "all" : stringList(input.itemIds, `${label}.itemIds`, 1, 100) };
    case "mark_no_outside_work":
      exactKeys(input, ["op"], label);
      return { op: "mark_no_outside_work" };
  }
  return schemaError(`${label}.op 不受支持`);
}

export function parseJsonArguments(raw: string, tool: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    return schemaError(`${tool} 参数不是合法 JSON`);
  }
  return objectValue(value, `${tool} 参数`);
}

export function parsePatchRequest(raw: string): PatchRequest {
  const input = parseJsonArguments(raw, "apply_draft_patch");
  exactKeys(input, ["expectedRevision", "operations"], "apply_draft_patch");
  if (!Number.isSafeInteger(input.expectedRevision)) schemaError("expectedRevision 必须是整数");
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 20) {
    schemaError("operations 必须包含 1 到 20 项");
  }
  return { expectedRevision: Number(input.expectedRevision), operations: input.operations.map(parseOperation) };
}

export function parseReplyArguments(raw: string): ReplyPayload & { normalizedStringFocus: boolean } {
  const input = parseJsonArguments(raw, "reply");
  exactKeys(input, ["message", "focus", "options"], "reply");
  const message = requiredText(input.message, "reply.message", 600);
  const options = input.options === undefined ? [] : stringList(input.options, "reply.options", 0, 4);
  if (input.focus === null) return { message, focus: null, options, normalizedStringFocus: false };
  let focusValue: unknown = input.focus;
  let normalizedStringFocus = false;
  if (typeof focusValue === "string") {
    try {
      focusValue = JSON.parse(focusValue) as unknown;
      normalizedStringFocus = true;
    } catch {
      schemaError("reply.focus 字符串不是合法 JSON 对象");
    }
  }
  const focus = objectValue(focusValue, "reply.focus");
  exactKeys(focus, ["itemId", "field", "questionKind"], "reply.focus");
  if (focus.itemId !== null && typeof focus.itemId !== "string") schemaError("reply.focus.itemId 必须是字符串或 null");
  if (typeof focus.field !== "string" || !FOCUS_FIELDS.has(focus.field as ReplyFocusField)) schemaError("reply.focus.field 不在允许枚举中");
  if (typeof focus.questionKind !== "string" || !QUESTION_KINDS.has(focus.questionKind as ReplyQuestionKind)) {
    schemaError("reply.focus.questionKind 不在允许枚举中");
  }
  const parsedFocus: ReplyFocus = {
    itemId: focus.itemId,
    field: focus.field as ReplyFocusField,
    questionKind: focus.questionKind as ReplyQuestionKind,
  };
  return { message, focus: parsedFocus, options, normalizedStringFocus };
}
