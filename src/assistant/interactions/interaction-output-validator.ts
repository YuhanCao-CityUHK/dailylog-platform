import type { EvidenceSourceType } from "../schema";
import type {
  InteractionCandidate,
  InteractionDirection,
  InteractionIgnoredEvidence,
  InteractionIntent,
  InteractionMissingFact,
  InteractionModelOutput,
  InteractionPriority,
  InteractionState,
} from "./interaction-types";

const SOURCE_TYPES = new Set<EvidenceSourceType>([
  "chat_group", "chat_private", "document", "wiki", "calendar", "minutes", "todo",
  "dingtalk_report", "platform_log", "attendance", "approval", "ding",
]);
const DIRECTIONS = new Set<InteractionDirection>([
  "assigned_to_me", "assigned_by_me", "self_initiated", "collaboration", "unknown",
]);
const STATES = new Set<InteractionState>(["pending", "in_progress", "completed", "blocked", "unknown"]);
const PRIORITIES = new Set<InteractionPriority>(["P1", "P2", "P3", "unknown"]);
const INTENTS = new Set<InteractionIntent>([
  "assignment", "approval", "support_request", "status_update", "decision", "completion", "other",
]);
const MISSING = new Set<InteractionMissingFact>(["today", "result", "project", "hours", "status", "actor"]);
const IGNORE_REASONS = new Set<InteractionIgnoredEvidence["reason"]>([
  "noise", "not_work", "not_for_employee", "duplicate", "insufficient_context",
]);

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, field: string, allowed: string[]): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${field} 包含未知字段 ${extras.join(",")}`);
}

function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const normalized = value.normalize("NFKC").trim();
  if (!allowEmpty && !normalized) throw new Error(`${field} 不能为空`);
  if (normalized.length > max) throw new Error(`${field} 过长`);
  return normalized;
}

function stringList(value: unknown, field: string, maxItems: number, maxText = 160): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} 必须是最多 ${maxItems} 项的数组`);
  return [...new Set(value.map((item) => text(item, field, maxText)).filter(Boolean))];
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} 必须是布尔值`);
  return value;
}

function candidate(value: unknown, index: number): InteractionCandidate {
  const field = `candidates[${index}]`;
  const raw = object(value, field);
  exactKeys(raw, field, [
    "candidateKey", "title", "summary", "latestProgress", "direction", "state", "priority", "intent",
    "participantNames", "projectSignals", "sourceTypes", "evidenceIds", "latestAt", "confidence",
    "selfActionSupported", "resultSupported", "missingFacts",
  ]);
  if (!DIRECTIONS.has(raw.direction as InteractionDirection)) throw new Error(`${field}.direction 无效`);
  if (!STATES.has(raw.state as InteractionState)) throw new Error(`${field}.state 无效`);
  if (!PRIORITIES.has(raw.priority as InteractionPriority)) throw new Error(`${field}.priority 无效`);
  if (!INTENTS.has(raw.intent as InteractionIntent)) throw new Error(`${field}.intent 无效`);
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`${field}.confidence 无效`);
  const sourceTypes = stringList(raw.sourceTypes, `${field}.sourceTypes`, 20, 40);
  if (sourceTypes.some((source) => !SOURCE_TYPES.has(source as EvidenceSourceType))) throw new Error(`${field}.sourceTypes 无效`);
  const missingFacts = stringList(raw.missingFacts, `${field}.missingFacts`, 6, 30);
  if (missingFacts.some((fact) => !MISSING.has(fact as InteractionMissingFact))) throw new Error(`${field}.missingFacts 无效`);
  const latestAt = text(raw.latestAt, `${field}.latestAt`, 40);
  if (!Number.isFinite(Date.parse(latestAt))) throw new Error(`${field}.latestAt 无效`);
  return {
    candidateKey: text(raw.candidateKey ?? "", `${field}.candidateKey`, 120, true),
    title: text(raw.title, `${field}.title`, 160),
    summary: text(raw.summary, `${field}.summary`, 400),
    latestProgress: text(raw.latestProgress, `${field}.latestProgress`, 400, true),
    direction: raw.direction as InteractionDirection,
    state: raw.state as InteractionState,
    priority: raw.priority as InteractionPriority,
    intent: raw.intent as InteractionIntent,
    participantNames: stringList(raw.participantNames, `${field}.participantNames`, 30, 80),
    projectSignals: stringList(raw.projectSignals, `${field}.projectSignals`, 20, 120),
    sourceTypes: sourceTypes as EvidenceSourceType[],
    evidenceIds: stringList(raw.evidenceIds, `${field}.evidenceIds`, 100, 100),
    latestAt,
    confidence: Math.round(confidence * 1000) / 1000,
    selfActionSupported: boolean(raw.selfActionSupported, `${field}.selfActionSupported`),
    resultSupported: boolean(raw.resultSupported, `${field}.resultSupported`),
    missingFacts: missingFacts as InteractionMissingFact[],
  };
}

export function validateInteractionModelOutput(value: unknown): InteractionModelOutput {
  const raw = object(value, "output");
  exactKeys(raw, "output", ["schemaVersion", "candidates", "ignoredEvidence"]);
  if (raw.schemaVersion !== "interaction-candidate-v1") throw new Error("schemaVersion 必须为 interaction-candidate-v1");
  if (!Array.isArray(raw.candidates) || raw.candidates.length > 50) throw new Error("candidates 必须是最多 50 项的数组");
  if (!Array.isArray(raw.ignoredEvidence) || raw.ignoredEvidence.length > 500) throw new Error("ignoredEvidence 无效");
  return {
    schemaVersion: "interaction-candidate-v1",
    candidates: raw.candidates.map(candidate),
    ignoredEvidence: raw.ignoredEvidence.map((value, index) => {
      const field = `ignoredEvidence[${index}]`;
      const item = object(value, field);
      exactKeys(item, field, ["evidenceId", "reason"]);
      if (!IGNORE_REASONS.has(item.reason as InteractionIgnoredEvidence["reason"])) throw new Error(`${field}.reason 无效`);
      return {
        evidenceId: text(item.evidenceId, `${field}.evidenceId`, 100),
        reason: item.reason as InteractionIgnoredEvidence["reason"],
      };
    }),
  };
}

export function parseAndValidateInteractionModelOutput(content: string): InteractionModelOutput {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new Error("模型输出必须是单一 JSON 对象");
  return validateInteractionModelOutput(JSON.parse(trimmed));
}
