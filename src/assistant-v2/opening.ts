import type { AgentDraftState, ReplyFocus } from "./types";

export interface SourceStatusSummary {
  read: string[];
  unavailable: string[];
  reading: string[];
}

export interface OpeningMessage {
  text: string;
  focus: ReplyFocus | null;
  options: string[];
}

function scopeLabel(state: AgentDraftState, projectId: number | null, scopeType: string): string {
  if (scopeType === "unconfirmed") return "项目待确认";
  if (projectId === null) return "部门日常";
  return state.visibleProjects.find((project) => project.id === projectId)?.name ?? "项目";
}

/**
 * 首轮开场是确定性的：候选列表和第一问由系统按投影生成，不消耗模型调用，也不会出现两套开场文案。
 * 之后每一轮才由模型决定说什么。
 */
export function buildOpening(
  state: AgentDraftState,
  sources: SourceStatusSummary | null,
  revealTaskSignalTitles = false,
): OpeningMessage {
  const unavailable = sources?.unavailable.filter(Boolean) ?? [];
  const sourceNote = unavailable.length ? `（今天的${unavailable.join("、")}暂时没读到，涉及的工作可以直接补充。）` : "";
  if (!state.items.length) {
    const lead = state.mode === "manual"
      ? "今天没有读到可用的钉钉上下文。"
      : "今天的线索里没有整理出可靠的工作事项，历史已完成的内容不会自动算作今天。";
    return {
      text: `${lead}直接说说今天主要做了什么、形成了什么结果，可以一次说多项，我来整理成日报。${sourceNote}`,
      focus: { itemId: null, field: "result", questionKind: "ask_missing" },
      options: [],
    };
  }
  const lines = state.items.map((item) => {
    const origin = item.origin === "continuation" ? "，昨日延续" : "";
    const taskSignal = !item.confirmed && item.needsConfirmation.includes("task_signal");
    if (taskSignal) {
      const title = revealTaskSignalTitles ? item.summary : "[待确认任务线索]";
      const signal = revealTaskSignalTitles ? "，待确认任务线索" : "";
      return `${item.displayAlias}：${title}（${scopeLabel(state, item.projectId, item.scopeType)}${origin}${signal}）`;
    }
    return `${item.displayAlias}：${item.summary}（${scopeLabel(state, item.projectId, item.scopeType)}${origin}）`;
  });
  const taskSignals = state.items.filter((item) => !item.confirmed && item.needsConfirmation.includes("task_signal")).length;
  const lead = taskSignals
    ? `根据今天的线索整理出 ${state.items.length} 项，其中 ${taskSignals} 项是交办/待跟进线索，还不能算作已完成工作：`
    : `根据今天的线索整理出 ${state.items.length} 项工作：`;
  return {
    text: `${lead}\n${lines.join("\n")}\n\n请确认今天实际做了哪些；哪项尚未处理、不是你的、要合并、改项目或者有遗漏，直接说就行。${sourceNote}`,
    focus: { itemId: null, field: "today", questionKind: "ask_missing" },
    options: ["都是今天的", "有几项不对", "还有别的工作"],
  };
}
