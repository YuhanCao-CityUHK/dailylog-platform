import type { EvidenceSourceType } from "../schema";

export type InteractionDirection =
  | "assigned_to_me"
  | "assigned_by_me"
  | "self_initiated"
  | "collaboration"
  | "unknown";

export type InteractionState = "pending" | "in_progress" | "completed" | "blocked" | "unknown";
export type InteractionPriority = "P1" | "P2" | "P3" | "unknown";
export type InteractionMissingFact = "today" | "result" | "project" | "hours" | "status" | "actor";
export type InteractionIntent =
  | "assignment"
  | "approval"
  | "support_request"
  | "status_update"
  | "decision"
  | "completion"
  | "other";

/**
 * A task-shaped interaction is deliberately not a WorkEvent. It may describe work
 * the employee has not started, and therefore can only become an unconfirmed draft
 * candidate until the employee supplies today's action/result.
 */
export interface InteractionCandidate {
  candidateKey: string;
  title: string;
  summary: string;
  latestProgress: string;
  direction: InteractionDirection;
  state: InteractionState;
  priority: InteractionPriority;
  intent: InteractionIntent;
  participantNames: string[];
  projectSignals: string[];
  sourceTypes: EvidenceSourceType[];
  evidenceIds: string[];
  latestAt: string;
  confidence: number;
  selfActionSupported: boolean;
  resultSupported: boolean;
  missingFacts: InteractionMissingFact[];
}
export interface InteractionIgnoredEvidence {
  evidenceId: string;
  reason: "noise" | "not_work" | "not_for_employee" | "duplicate" | "insufficient_context";
}

export interface InteractionModelOutput {
  schemaVersion: "interaction-candidate-v1";
  candidates: InteractionCandidate[];
  ignoredEvidence: InteractionIgnoredEvidence[];
}

export interface InteractionDiscoveryCoverage {
  scannedReferences: number;
  signalEvidence: number;
  interactionCandidates: number;
  ignoredEvidence: number;
}
