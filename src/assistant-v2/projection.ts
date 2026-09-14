import { projectDraftGaps } from "./gap-projection";
import type { AgentDraftState } from "./types";

function projectName(state: AgentDraftState, projectId: number | null): string {
  if (projectId === null) return "部门日常";
  return state.visibleProjects.find((project) => project.id === projectId)?.name ?? `项目#${projectId}`;
}

export function renderAgentProjection(state: AgentDraftState): string {
  const lines: string[] = [];
  lines.push(`workDate: ${state.workDate} | revision: ${state.revision} | 模式: ${state.mode}`);
  lines.push("事项：");
  if (!state.items.length) lines.push("  （暂无事项）");
  for (const item of state.items) {
    const scope = item.scopeType === "unconfirmed"
      ? "项目=待确认"
      : `项目=${projectName(state, item.projectId)}`;
    lines.push(`  ${item.displayAlias} [${item.itemId}] ${scope} | 状态=${item.status} | ${item.confirmed ? "已确认" : "未确认"}${item.origin === "continuation" ? " | 昨日延续" : ""}`);
    lines.push(`     证据完整性：${item.sourceCompleteness}  置信度：${item.confidence.toFixed(2)}${item.missingFacts.length ? `  缺失事实：${item.missingFacts.join("、")}` : ""}`);
    lines.push(`     事项：${item.summary}`);
    lines.push(`     结果：${item.result || "（空）"}  工时：${item.hours === null ? "（空）" : `${item.hours} 小时`}`);
    if (item.scopeType === "project") {
      const financeCodes = item.projectId === null ? [] : state.financeCodes[String(item.projectId)] || [];
      lines.push(`     财务项目编码：${item.financeCode || (financeCodes.length ? "（未选择）" : "（项目尚未配置，可直接提交）")}`);
    }
    if (item.blocker) lines.push(`     阻塞：${item.blocker}`);
    if (item.nextAction) lines.push(`     下一步：${item.nextAction}`);
    if (item.supportNeeded || item.supportPeople.length) lines.push(`     需要支持：${item.supportNeeded}${item.supportPeople.length ? `（${item.supportPeople.join("、")}）` : ""}`);
    if (item.tomorrowPlan) lines.push(`     明日计划：${item.tomorrowPlan}`);
  }
  const totalHours = Math.round(state.items.reduce((sum, item) => sum + (item.hours ?? 0), 0) * 100) / 100;
  lines.push(`总工时：${totalHours} 小时`);
  lines.push(`可见项目：${state.visibleProjects.map((project) => `[${project.id}] ${project.name}${project.status === "completed" ? "（已完成）" : ""}`).join("，") || "无"}（null = 部门日常）`);
  lines.push("各项目可选财务编码：" + Object.entries(state.financeCodes)
    .map(([projectId, codes]) => `[${projectId}] ${codes.map((code) => `${code.id}:${code.name}`).join("、") || "未配置"}`)
    .join("；"));
  const gaps = projectDraftGaps(state);
  lines.push("缺口（按优先级）：");
  if (!gaps.length) lines.push("  （无，草稿已完整，可以准备提交）");
  gaps.forEach((gap, index) => lines.push(`  ${index + 1}. ${gap.text}`));
  lines.push(`lastFocus: ${state.lastFocus ? JSON.stringify(state.lastFocus) : "null"}`);
  const changes = state.recentChanges.filter((change) => !change.undone);
  lines.push(`最近变更（可用 undo_draft_change 撤销）：${changes.length ? changes.map((change) => `${change.changeId}：${change.summary}`).join("；") : "无"}`);
  lines.push(`提交状态：${state.status === "submitted" ? "已提交" : state.prepared ? `已准备 revision ${state.prepared.revision}` : "未准备"}`);
  return lines.join("\n");
}
