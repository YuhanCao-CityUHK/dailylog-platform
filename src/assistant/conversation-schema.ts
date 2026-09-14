import type { DailyAssistantCandidate } from "./candidate-service";
import type { WorkItemAnalysisMode } from "./work-item-analysis-service";
import type { WorkItemOrigin } from "./temporal-gate";

export type AssistantMode = "complete" | "partial" | "manual";
export type AssistantScopeType = "project" | "department_daily" | "unconfirmed";
export type AssistantWorkStatus = "completed" | "in_progress" | "blocked" | "no_progress";

export interface AssistantSessionItem {
  id: number;
  itemKey: string;
  order: number;
  /** 会话内唯一、全局连续的显示别名；所有 UI、草稿和解析均使用此值。 */
  displayAlias: string;
  scopeType: AssistantScopeType;
  projectId?: number;
  projectName?: string;
  financeCodeId?: number;
  workStatus: AssistantWorkStatus;
  workSummary: string;
  resultText: string;
  hours: number | null;
  blockerText: string;
  nextAction: string;
  supportNeeded: string;
  supportPeople: string[];
  tomorrowPlan: string;
  sourceKind: "candidate" | "employee";
  referenceIds: string[];
  needsConfirmation: string[];
  sourceCompleteness: "complete" | "partial";
  confidence: number;
  missingFacts: string[];
  employeeConfirmed: boolean;
  origin: WorkItemOrigin | "employee";
}

export interface AssistantMessage {
  id: number;
  role: "user" | "assistant" | "system";
  kind: string;
  content: string;
  createdAt: string;
}

export interface AssistantSession {
  id: number;
  userId: number;
  workDate: string;
  mode: AssistantMode;
  status: "active" | "submitted" | "abandoned";
  contextJobId?: string;
  analysisMode: WorkItemAnalysisMode | "manual";
  outsideWorkAsked: boolean;
  outsideWorkAnswered: boolean;
  forceDraft: boolean;
  revision: number;
  items: AssistantSessionItem[];
  messages: AssistantMessage[];
  updatedAt: string;
}

export type AssistantItemPatch = Partial<
  Pick<
    AssistantSessionItem,
    | "workSummary"
    | "resultText"
    | "hours"
    | "workStatus"
    | "blockerText"
    | "nextAction"
    | "supportNeeded"
    | "supportPeople"
    | "tomorrowPlan"
  >
>;

export type AssistantAction =
  | { type: "confirm"; itemIds?: number[] }
  | { type: "delete"; itemId: number }
  | { type: "merge"; itemIds: number[] }
  | { type: "split"; itemId: number; summaries: string[] }
  | { type: "assign_project"; itemId: number; projectId: number | null }
  | { type: "assign_finance_code"; itemId: number; financeCodeId: number }
  | { type: "update"; itemId: number; patch: AssistantItemPatch }
  | {
      type: "add";
      item: {
        workSummary: string;
        resultText?: string;
        hours?: number | null;
        workStatus?: AssistantWorkStatus;
        projectId?: number | null;
      };
    }
  | { type: "outside_work_answered" }
  | { type: "force_draft" };

export interface AssistantConversationState {
  session: AssistantSession;
  prompt: string;
  promptKind: "confirm_candidates" | "result" | "person" | "outside_work" | "project" | "finance_code" | "hours" | "blocked_loop" | "draft" | "manual_start";
  draft?: AssistantDraft;
}

export interface AssistantDraftGroup {
  key: string;
  label: string;
  items: AssistantSessionItem[];
}

export interface AssistantDraft {
  workDate: string;
  groups: AssistantDraftGroup[];
  totalHours: number;
  text: string;
  complete: boolean;
  warnings: string[];
}

export function modeFromCompleteness(value: unknown): AssistantMode {
  return value === "complete" || value === "partial" ? value : "manual";
}

export function candidateToSessionDefaults(candidate: DailyAssistantCandidate): Omit<AssistantSessionItem, "id" | "order" | "displayAlias"> {
  const continuation = candidate.origin === "continuation";
  const taskSignal = candidate.candidateKind === "task_signal";
  return {
    itemKey: candidate.candidateId,
    scopeType: candidate.scopeType,
    projectId: candidate.selectedProjectId,
    projectName: candidate.selectedProjectName,
    financeCodeId: undefined,
    workStatus: taskSignal
      ? "in_progress"
      : candidate.workStatus ?? (!continuation && /^(完成|已完成|交付|发布|上线|通过)/.test(candidate.resultHint.trim()) ? "completed" : "in_progress"),
    workSummary: (taskSignal ? candidate.title : candidate.workSummary).trim(),
    resultText: continuation || taskSignal ? "" : candidate.resultHint.trim(),
    hours: null,
    blockerText: candidate.blockerText ?? "",
    nextAction: taskSignal ? "" : candidate.nextAction ?? "",
    supportNeeded: "",
    supportPeople: [],
    tomorrowPlan: "",
    sourceKind: "candidate",
    referenceIds: [...new Set(candidate.referenceIds)],
    needsConfirmation: [...new Set([
      ...(continuation ? ["today"] : []),
      ...(taskSignal ? ["task_signal", "today", "result", "status"] : []),
      ...candidate.needsConfirmation,
    ])],
    sourceCompleteness: candidate.sourceCompleteness ?? "complete",
    confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : 0.5,
    missingFacts: [...new Set([
      ...(taskSignal ? ["today", "result", "status"] : []),
      ...(candidate.missingFacts ?? []),
    ])],
    employeeConfirmed: false,
    origin: continuation ? "continuation" : "today",
  };
}
