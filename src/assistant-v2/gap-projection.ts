import type { AgentDraftState, DraftGap } from "./types";

const AMBIGUOUS_PEOPLE = ["同事", "领导", "他们", "她们", "研发那边", "销售那边"];

function alias(state: AgentDraftState, itemId: string): string {
  return state.items.find((item) => item.itemId === itemId)?.displayAlias ?? itemId;
}

/** 提交、提示和 UI 共用的唯一缺口计算。 */
export function projectDraftGaps(state: AgentDraftState): DraftGap[] {
  const gaps: DraftGap[] = [];
  const unconfirmed = state.items.filter((item) => !item.confirmed);
  if (unconfirmed.length) {
    const partial = unconfirmed.some((item) => item.sourceCompleteness === "partial");
    gaps.push({
      priority: 1,
      itemId: null,
      field: "today",
      text: `${unconfirmed.map((item) => item.displayAlias).join("、")} 未确认是否属于今天${partial ? "；部分来源未完整读取" : ""}`,
    });
  }
  for (const item of state.items.filter((candidate) => !candidate.confirmed)) {
    if (item.missingFacts.includes("actor")) {
      gaps.push({ priority: 2, itemId: item.itemId, field: "person", text: `${item.displayAlias} 的本人动作归属待确认` });
    }
    if (item.missingFacts.includes("status")) {
      gaps.push({ priority: 2, itemId: item.itemId, field: "status", text: `${item.displayAlias} 的工作状态待确认` });
    }
    if (item.missingFacts.includes("project")) {
      gaps.push({ priority: 4, itemId: item.itemId, field: "project", text: `${item.displayAlias} 的项目事实待确认` });
    }
  }
  for (const item of state.items) {
    const hasResult = item.result.trim() || (item.status === "no_progress" && (item.blocker.trim() || item.nextAction.trim()));
    if (!hasResult) gaps.push({ priority: 2, itemId: item.itemId, field: "result", text: `${item.displayAlias} 缺结果或进展` });
  }
  for (const item of state.items) {
    if (item.scopeType !== "project" || !item.projectId) continue;
    const options = state.financeCodes[String(item.projectId)] || [];
    // 项目尚未配置任何财务编码时没有可选值，不应把员工卡在提交前；
    // 一旦项目已有编码，仍要求选择具体编码，保证已配置项目的归集口径。
    if (options.length > 0 && !item.financeCodeId) {
      gaps.push({
        priority: 5,
        itemId: item.itemId,
        field: "finance_code",
        text: `${item.displayAlias} 缺少财务项目编码，请在草稿面板选择`,
      });
    }
  }
  for (const item of state.items) {
    if ((item.status === "blocked" || item.blocker.trim()) && !item.nextAction.trim() && !item.supportNeeded.trim()) {
      gaps.push({ priority: 3, itemId: item.itemId, field: "next_action", text: `${item.displayAlias} 有阻塞但没有下一步或支持人` });
    }
  }
  for (const item of state.items) {
    if (item.scopeType === "unconfirmed") {
      const recommended = state.visibleProjects.find((project) => project.id === item.recommendedProjectId);
      gaps.push({
        priority: 4,
        itemId: item.itemId,
        field: "project",
        text: `${item.displayAlias} 项目归属待确认${recommended ? `（推荐：${recommended.name}）` : ""}`,
      });
    }
  }
  const missingHours = state.items.filter((item) => item.hours === null);
  if (missingHours.length) {
    gaps.push({
      priority: 5,
      itemId: missingHours.length === 1 ? missingHours[0].itemId : null,
      field: "hours",
      text: `${missingHours.map((item) => item.displayAlias).join("、")} 缺工时`,
    });
  }
  for (const item of state.items) {
    const combined = `${item.result} ${item.blocker} ${item.nextAction}`;
    if (AMBIGUOUS_PEOPLE.some((label) => combined.includes(label))) {
      gaps.push({ priority: 6, itemId: item.itemId, field: "person", text: `${alias(state, item.itemId)} 使用了模糊称呼，需要真实姓名` });
    }
  }
  if (!state.outsideWorkAnswered) {
    gaps.push({ priority: 7, itemId: null, field: "outside_work", text: "尚未确认钉钉之外是否还有工作" });
  }
  const unique = new Map<string, DraftGap>();
  for (const gap of gaps.sort((left, right) => left.priority - right.priority)) {
    const key = `${gap.itemId ?? "all"}:${gap.field}`;
    if (!unique.has(key)) unique.set(key, gap);
  }
  return [...unique.values()];
}
