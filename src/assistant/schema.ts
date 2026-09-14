import type { DwsRunOptions } from "../dws/client";

export type JsonObject = Record<string, unknown>;

export type CollectorSourceType =
  | "chat"
  | "document"
  | "wiki"
  | "calendar"
  | "minutes"
  | "todo"
  | "dingtalk_report"
  | "attendance_approval"
  | "work_interactions"
  | "platform_log";

export type EvidenceSourceType =
  | "chat_group"
  | "chat_private"
  | "document"
  | "wiki"
  | "calendar"
  | "minutes"
  | "todo"
  | "dingtalk_report"
  | "platform_log"
  | "attendance"
  | "approval"
  | "ding";

export type CollectorStatus = "complete" | "partial" | "empty" | "error";

export type EvidenceTemporalRole = "today" | "previous_workday" | "history";
export type EvidenceWorkUse = "direct_work" | "task_signal" | "continuation_hint" | "background_only";
export type EvidenceRelationToSelf = "self" | "addressed" | "bot_or_unknown" | "others";
export type EvidenceSenderKind = "user" | "bot" | "unknown";
export type EvidenceSourceCompleteness = "complete" | "partial";

export interface ChatConversationLedger {
  kind: "chat_conversation";
  conversationId: string;
  conversationType: "group" | "private";
  pagesFetched: number;
  messagesFetched: number;
  complete: boolean;
  hasMore: boolean;
  stopReason?: string;
  failures: number;
  failedPages: number[];
}

export interface SourceCompleteness {
  complete: boolean;
  hasMore: boolean;
  stopReason?: string;
  failures: number;
  pagesFetched: number;
  itemCount: number;
  details?: ChatConversationLedger[];
}

export interface CollectedEvidence {
  sourceType: EvidenceSourceType;
  externalId: string;
  title: string;
  summary: string;
  occurredAt: string;
  actorUserIds: string[];
  actorNames: string[];
  participantNames: string[];
  url?: string;
  privacyScope: "employee_only" | "normal";
  projectSignals: string[];
  evidenceStrength: "strong" | "medium" | "weak";
  /** 旧加密载荷可能缺失；资格闸门会重新推断，仍无法判断时 fail closed。 */
  relationToSelf?: EvidenceRelationToSelf;
  senderKind?: EvidenceSenderKind;
  /** 群成员数仅用于限制 others 类证据贡献项目信号，不返回给前端。 */
  groupMemberCount?: number;
  conversationId?: string;
  threadId?: string;
  replyToMessageId?: string;
  quotedMessageId?: string;
  resourceRefs?: string[];
  linkedObjectIds?: string[];
  sourceCompleteness?: EvidenceSourceCompleteness;
  /** 服务端时态闸门输入；旧载荷缺失时按最保守的 background_only 处理。 */
  temporalRole?: EvidenceTemporalRole;
  workUse?: EvidenceWorkUse;
  /** 仅供事项分析使用，Reference 仍展示 title/summary 中的原始最小摘要。 */
  analysisTitle?: string;
  analysisSummary?: string;
  resultEligible?: boolean;
}

export interface CollectorInput {
  platformUserId: number;
  ddUserid: string;
  selfUserIds?: string[];
  displayName?: string;
  profile: string;
  workDate: string;
  historyWorkDates: string[];
  now: Date;
  signal?: AbortSignal;
  referencedExternalIds?: string[];
  run: (args: string[], options?: DwsRunOptions) => Promise<JsonObject>;
}

export interface CollectorResult {
  source: CollectorSourceType;
  status: CollectorStatus;
  evidences: CollectedEvidence[];
  errorCode?: string;
  errorMessage?: string;
  failureStage?: string;
  durationMs?: number;
  completeness?: SourceCompleteness;
}

export interface ContextCollector {
  source: CollectorSourceType;
  collect(input: CollectorInput): Promise<CollectorResult>;
}
