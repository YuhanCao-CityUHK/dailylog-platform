export const DRAFT_OPERATION_NAMES = [
  "add_item",
  "delete_item",
  "update_summary",
  "set_result",
  "set_hours",
  "set_project",
  "set_finance_code",
  "set_status",
  "set_blocker",
  "set_next_action",
  "set_support",
  "set_tomorrow_plan",
  "merge_items",
  "split_item",
  "confirm_items",
  "mark_no_outside_work",
] as const;

export type DraftOperationName = (typeof DRAFT_OPERATION_NAMES)[number];
export type AgentScopeType = "project" | "department_daily" | "unconfirmed";
export type AgentWorkStatus = "completed" | "in_progress" | "blocked" | "no_progress";
export type ReplyFocusField =
  | "today"
  | "result"
  | "hours"
  | "project"
  | "finance_code"
  | "status"
  | "blocker"
  | "next_action"
  | "support"
  | "person"
  | "tomorrow_plan"
  | "outside_work"
  | "submit"
  | "clarify_target";
export type ReplyQuestionKind = "ask_missing" | "clarify" | "confirm_submit" | "none";

export interface ReplyFocus {
  itemId: string | null;
  field: ReplyFocusField;
  questionKind: ReplyQuestionKind;
}

export interface ReplyPayload {
  message: string;
  focus: ReplyFocus | null;
  options: string[];
}

export interface AgentProject {
  id: number;
  name: string;
  status: "in_progress" | "completed";
}

export interface AgentDraftItem {
  recordId: number | null;
  itemId: string;
  displayAlias: string;
  order: number;
  scopeType: AgentScopeType;
  projectId: number | null;
  projectName: string | null;
  financeCodeId: number | null;
  financeCode: string | null;
  recommendedProjectId: number | null;
  status: AgentWorkStatus;
  summary: string;
  result: string;
  hours: number | null;
  blocker: string;
  nextAction: string;
  supportNeeded: string;
  supportPeople: string[];
  tomorrowPlan: string;
  confirmed: boolean;
  origin: "today" | "continuation" | "employee";
  sourceKind: "candidate" | "employee";
  referenceIds: string[];
  needsConfirmation: string[];
  sourceCompleteness: "complete" | "partial";
  confidence: number;
  missingFacts: string[];
}

export interface DraftGap {
  priority: number;
  itemId: string | null;
  field: ReplyFocusField;
  text: string;
}

export interface AgentChangeSummary {
  changeId: string;
  revision: number;
  op: string;
  summary: string;
  undone: boolean;
}

export interface AgentDraftState {
  sessionId: number;
  userId: number;
  workDate: string;
  mode: "complete" | "partial" | "manual";
  status: "active" | "submitted" | "abandoned";
  revision: number;
  outsideWorkAsked: boolean;
  outsideWorkAnswered: boolean;
  items: AgentDraftItem[];
  visibleProjects: AgentProject[];
  financeCodes: Record<string, Array<{ id: number; code: string; name: string }>>;
  lastFocus: ReplyFocus | null;
  recentChanges: AgentChangeSummary[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
  prepared: { hash: string; revision: number; messageId: number } | null;
}

interface OperationBase {
  op: DraftOperationName;
}

export type DraftOperation =
  | (OperationBase & {
      op: "add_item";
      summary: string;
      result?: string;
      hours?: number | null;
      projectId?: number | null;
      status?: AgentWorkStatus;
      blocker?: string;
      nextAction?: string;
      tomorrowPlan?: string;
    })
  | (OperationBase & { op: "delete_item"; itemId: string; reason?: string })
  | (OperationBase & { op: "update_summary"; itemId: string; summary: string })
  | (OperationBase & { op: "set_result"; itemId: string; result: string })
  | (OperationBase & { op: "set_hours"; itemId: string; hours: number })
  | (OperationBase & { op: "set_project"; itemId: string; projectId: number | null })
  | (OperationBase & { op: "set_finance_code"; itemId: string; financeCodeId: number })
  | (OperationBase & { op: "set_status"; itemId: string; status: AgentWorkStatus })
  | (OperationBase & {
      op: "set_blocker";
      itemId: string;
      blocker: string;
      nextAction?: string;
      supportNeeded?: string;
      supportPeople?: string[];
    })
  | (OperationBase & { op: "set_next_action"; itemId: string; nextAction: string })
  | (OperationBase & { op: "set_support"; itemId: string; supportNeeded: string; supportPeople?: string[] })
  | (OperationBase & { op: "set_tomorrow_plan"; itemId: string; tomorrowPlan: string })
  | (OperationBase & { op: "merge_items"; itemIds: string[]; summary?: string })
  | (OperationBase & { op: "split_item"; itemId: string; summaries: string[] })
  | (OperationBase & { op: "confirm_items"; itemIds: string[] | "all" })
  | (OperationBase & { op: "mark_no_outside_work" });

export interface PatchRequest {
  expectedRevision: number;
  operations: DraftOperation[];
}

export interface ChangeReceipt {
  changeId: string;
  text: string;
  undoable: boolean;
}

export interface ToolTraceEntry {
  round: number;
  tool: string;
  status: "ok" | "rejected" | "error";
  durationMs: number;
  summary: string;
}

export interface AssistantTurnResponse {
  assistantMessage: { messageId: number; text: string };
  receipts: ChangeReceipt[];
  draftProjection: { items: AgentDraftItem[]; gaps: DraftGap[] };
  revision: number;
  focus: ReplyFocus | null;
  options: string[];
  submitted: boolean;
  model: string;
}

export interface AssistantConversationMessage {
  messageId: number;
  role: "user" | "assistant";
  kind: string;
  text: string;
  receipts: ChangeReceipt[];
  focus: ReplyFocus | null;
  options: string[];
  createdAt: string;
}

export interface AssistantConversationView {
  engine: "v2";
  sessionId: number;
  workDate: string;
  mode: AgentDraftState["mode"];
  status: AgentDraftState["status"];
  revision: number;
  submitted: boolean;
  messages: AssistantConversationMessage[];
  draft: {
    items: AgentDraftItem[];
    gaps: DraftGap[];
    totalHours: number;
    canSubmit: boolean;
    visibleProjects: AgentProject[];
    financeCodes: Record<string, Array<{ id: number; code: string; name: string }>>;
  };
  focus: ReplyFocus | null;
  options: string[];
  sources: { read: string[]; unavailable: string[]; reading: string[] } | null;
}

export class AssistantV2Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export function cloneAgentState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
