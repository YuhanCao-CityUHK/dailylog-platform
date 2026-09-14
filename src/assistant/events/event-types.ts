import type {
  EvidenceRelationToSelf,
  EvidenceSourceCompleteness,
  EvidenceSourceType,
  EvidenceTemporalRole,
  EvidenceWorkUse,
} from "../schema";

export type WorkEventStatus = "completed" | "in_progress" | "blocked" | "no_progress" | "uncertain";
export type WorkEventOrigin = "today" | "continuation";
export type WorkEventMissingFact = "today" | "result" | "project" | "hours" | "status" | "actor";
export type WorkEventClaimType = "action" | "result" | "decision" | "blocker" | "next_action";

export interface EventClaim {
  type: WorkEventClaimType;
  text: string;
  evidenceIds: string[];
  certainty: "explicit" | "corroborated" | "inferred";
}

export interface WorkEvent {
  eventKey: string;
  title: string;
  action: string;
  object: string;
  result: string;
  status: WorkEventStatus;
  decision: string;
  blockers: string[];
  nextActions: string[];
  participantNames: string[];
  projectSignals: string[];
  sourceTypes: EvidenceSourceType[];
  evidenceIds: string[];
  claims: EventClaim[];
  origin: WorkEventOrigin;
  confidence: number;
  missingFacts: WorkEventMissingFact[];
}

export interface EvidenceBundleItem {
  evidenceId: string;
  sourceType: EvidenceSourceType;
  title: string;
  summary: string;
  occurredAt: string;
  actorNames: string[];
  participantNames: string[];
  relationToSelf: EvidenceRelationToSelf;
  temporalRole: EvidenceTemporalRole;
  workUse: EvidenceWorkUse;
  sourceCompleteness: EvidenceSourceCompleteness;
  projectSignals: string[];
  conversationId?: string;
  threadId?: string;
  replyToMessageId?: string;
  quotedMessageId?: string;
  resourceRefs: string[];
  linkedObjectIds: string[];
}

export interface EvidenceBundle {
  bundleId: string;
  bundleType: "chat_context" | "cross_source";
  evidenceIds: string[];
  sourceTypes: EvidenceSourceType[];
  completeness: EvidenceSourceCompleteness;
  items: EvidenceBundleItem[];
}

export interface IgnoredEvidence {
  evidenceId: string;
  reason: "noise" | "empty" | "bot_or_unknown" | "background_only" | "duplicate" | "insufficient_context";
}

export interface EvidenceBundleBuildResult {
  bundles: EvidenceBundle[];
  includedEvidenceIds: string[];
  ignoredEvidence: IgnoredEvidence[];
}

export interface SourceCompletenessSummary {
  source: string;
  complete: boolean;
  hasMore: boolean;
  stopReason?: string;
  failures: number;
  pagesFetched: number;
  itemCount: number;
}

export interface EventModelOutput {
  schemaVersion: "work-event-v1";
  events: WorkEvent[];
  ignoredEvidence: IgnoredEvidence[];
}
