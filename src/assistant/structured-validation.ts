import type { AssistantAction, AssistantItemPatch, AssistantWorkStatus } from "./conversation-schema";

const WORK_STATUSES = new Set<AssistantWorkStatus>(["completed", "in_progress", "blocked", "no_progress"]);

export class AssistantValidationError extends Error {}

export function validatedText(value: unknown, field: string, max = 1000, allowEmpty = true): string {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!allowEmpty && !text) throw new AssistantValidationError(`${field}不能为空`);
  if (text.length > max) throw new AssistantValidationError(`${field}不能超过 ${max} 个字符`);
  return text;
}

export function validatedHours(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) throw new AssistantValidationError("单项工时应在 0 至 24 小时之间");
  return Math.round(hours * 100) / 100;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AssistantValidationError(`${field}无效`);
  return id;
}

function validatePatch(value: unknown): AssistantItemPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantValidationError("修改内容无效");
  const input = value as Record<string, unknown>;
  const patch: AssistantItemPatch = {};
  if ("workSummary" in input) patch.workSummary = validatedText(input.workSummary, "工作事项", 500, false);
  if ("resultText" in input) patch.resultText = validatedText(input.resultText, "结果", 1000);
  if ("hours" in input) patch.hours = validatedHours(input.hours);
  if ("workStatus" in input) {
    if (!WORK_STATUSES.has(input.workStatus as AssistantWorkStatus)) throw new AssistantValidationError("工作状态无效");
    patch.workStatus = input.workStatus as AssistantWorkStatus;
  }
  if ("blockerText" in input) patch.blockerText = validatedText(input.blockerText, "阻塞", 1000);
  if ("nextAction" in input) patch.nextAction = validatedText(input.nextAction, "下一步", 1000);
  if ("supportNeeded" in input) patch.supportNeeded = validatedText(input.supportNeeded, "支持诉求", 1000);
  if ("tomorrowPlan" in input) patch.tomorrowPlan = validatedText(input.tomorrowPlan, "明日计划", 1000);
  if ("supportPeople" in input) {
    if (!Array.isArray(input.supportPeople)) throw new AssistantValidationError("支持人员格式无效");
    patch.supportPeople = input.supportPeople.map((item) => validatedText(item, "支持人员", 100, false)).slice(0, 20);
  }
  if (Object.keys(patch).length === 0) throw new AssistantValidationError("没有可执行的修改");
  return patch;
}

/** 所有模型或客户端动作必须先经过该结构校验，不能直接写库。 */
export function validateAssistantAction(value: unknown): AssistantAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantValidationError("结构化指令无效");
  const input = value as Record<string, unknown>;
  switch (input.type) {
    case "confirm":
      return {
        type: "confirm",
        itemIds: Array.isArray(input.itemIds) ? input.itemIds.map((id) => positiveId(id, "事项")) : undefined,
      };
    case "delete":
      return { type: "delete", itemId: positiveId(input.itemId, "事项") };
    case "merge": {
      if (!Array.isArray(input.itemIds)) throw new AssistantValidationError("请选择需要合并的事项");
      const itemIds = [...new Set(input.itemIds.map((id) => positiveId(id, "事项")))];
      if (itemIds.length < 2) throw new AssistantValidationError("合并至少需要两项");
      return { type: "merge", itemIds };
    }
    case "split": {
      if (!Array.isArray(input.summaries)) throw new AssistantValidationError("拆分内容无效");
      const summaries = input.summaries.map((item) => validatedText(item, "拆分事项", 500, false)).filter(Boolean);
      if (summaries.length < 2 || summaries.length > 8) throw new AssistantValidationError("请将事项拆为 2 至 8 项");
      return { type: "split", itemId: positiveId(input.itemId, "事项"), summaries };
    }
    case "assign_project":
      return {
        type: "assign_project",
        itemId: positiveId(input.itemId, "事项"),
        projectId: input.projectId === null ? null : positiveId(input.projectId, "项目"),
      };
    case "assign_finance_code":
      return {
        type: "assign_finance_code",
        itemId: positiveId(input.itemId, "事项"),
        financeCodeId: positiveId(input.financeCodeId, "财务项目编码"),
      };
    case "update":
      return { type: "update", itemId: positiveId(input.itemId, "事项"), patch: validatePatch(input.patch) };
    case "add": {
      if (!input.item || typeof input.item !== "object" || Array.isArray(input.item)) throw new AssistantValidationError("补充事项无效");
      const item = input.item as Record<string, unknown>;
      const workStatus = item.workStatus === undefined ? undefined : (item.workStatus as AssistantWorkStatus);
      if (workStatus && !WORK_STATUSES.has(workStatus)) throw new AssistantValidationError("工作状态无效");
      return {
        type: "add",
        item: {
          workSummary: validatedText(item.workSummary, "工作事项", 500, false),
          resultText: item.resultText === undefined ? undefined : validatedText(item.resultText, "结果", 1000),
          hours: item.hours === undefined ? undefined : validatedHours(item.hours),
          workStatus,
          projectId: item.projectId === undefined || item.projectId === null ? item.projectId as null | undefined : positiveId(item.projectId, "项目"),
        },
      };
    }
    case "outside_work_answered":
      return { type: "outside_work_answered" };
    case "force_draft":
      return { type: "force_draft" };
    default:
      throw new AssistantValidationError("不支持的结构化指令");
  }
}
