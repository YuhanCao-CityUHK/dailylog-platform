import type { DatabaseSync } from "node:sqlite";
import { listFinanceProjectCodes } from "../platform/finance-project-codes";
import type { AssistantDraft, AssistantDraftGroup, AssistantSession, AssistantSessionItem } from "./conversation-schema";
import { nextMissingFact } from "./completeness-evaluator";

function sentence(value: string): string {
  const text = value.trim();
  if (!text) return "";
  return /[。！？!?]$/.test(text) ? text : `${text}。`;
}

function itemLine(item: AssistantSessionItem): string {
  const result = sentence(item.resultText || item.workSummary);
  const hours = item.hours === null ? "工时待确认" : `投入 ${item.hours} 小时`;
  return `${item.displayAlias}：${result}${hours}。`;
}

export function buildAssistantDraft(session: AssistantSession, db?: DatabaseSync): AssistantDraft {
  const groups: AssistantDraftGroup[] = [];
  const byKey = new Map<string, AssistantDraftGroup>();
  for (const item of session.items) {
    const key = item.scopeType === "project" && item.projectId ? `project:${item.projectId}` : item.scopeType;
    const label = item.scopeType === "project" ? item.projectName || "项目" : item.scopeType === "unconfirmed" ? "待确认项目" : "部门日常";
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  const sections: string[] = [];
  for (const group of groups) {
    sections.push(`${group.key === "department_daily" ? "部门日常" : group.key === "unconfirmed" ? "待确认项目" : `项目：${group.label}`}\n\n${group.items.map(itemLine).join("\n")}`);
  }
  const blockers = session.items.filter((item) => item.blockerText.trim());
  if (blockers.length) {
    sections.push(`问题与阻塞\n${blockers.map((item) => `- ${item.displayAlias}：${sentence(item.blockerText)}${item.nextAction ? `下一步：${sentence(item.nextAction)}` : ""}${item.supportNeeded ? `需要支持：${sentence(item.supportNeeded)}` : ""}`).join("\n")}`);
  }
  const tomorrow = session.items.filter((item) => item.tomorrowPlan.trim());
  if (tomorrow.length) sections.push(`明日计划\n${tomorrow.map((item) => `- ${item.displayAlias}：${sentence(item.tomorrowPlan)}`).join("\n")}`);
  const totalHours = Math.round(session.items.reduce((sum, item) => sum + (item.hours ?? 0), 0) * 100) / 100;
  const warnings: string[] = [];
  if (session.items.some((item) => item.hours === null)) warnings.push("仍有事项工时待确认，提交前必须补齐。");
  if (session.items.some((item) => item.scopeType === "unconfirmed")) warnings.push("仍有事项项目归属待确认，提交前必须补齐。");
  if (db && session.items.some((item) => item.scopeType === "project" && item.projectId && !item.financeCodeId && listFinanceProjectCodes(item.projectId, db).length > 0)) {
    warnings.push("项目事项仍缺少财务项目编码，提交前必须选择。");
  }
  if (totalHours > 16) warnings.push("总工时明显偏高，请确认是否包含了非实际投入时间。");
  const missing = nextMissingFact(session, db);
  return {
    workDate: session.workDate,
    groups,
    totalHours,
    text: sections.join("\n\n"),
    complete: missing === null,
    warnings,
  };
}
