import type {
  EventClaim,
  EventModelOutput,
  IgnoredEvidence,
  WorkEvent,
  WorkEventClaimType,
  WorkEventMissingFact,
  WorkEventStatus,
} from "./event-types";
import type { EvidenceSourceType } from "../schema";

const SOURCE_TYPES = new Set<EvidenceSourceType>([
  "chat_group", "chat_private", "document", "wiki", "calendar", "minutes", "todo",
  "dingtalk_report", "platform_log", "attendance", "approval",
]);
const EVENT_STATUS = new Set<WorkEventStatus>(["completed", "in_progress", "blocked", "no_progress", "uncertain"]);
const CLAIM_TYPES = new Set<WorkEventClaimType>(["action", "result", "decision", "blocker", "next_action"]);
const MISSING_FACTS = new Set<WorkEventMissingFact>(["today", "result", "project", "hours", "status", "actor"]);
const IGNORE_REASONS = new Set<IgnoredEvidence["reason"]>([
  "noise", "empty", "bot_or_unknown", "background_only", "duplicate", "insufficient_context",
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

function claim(value: unknown, field: string): EventClaim {
  const raw = object(value, field);
  exactKeys(raw, field, ["type", "text", "evidenceIds", "certainty"]);
  if (!CLAIM_TYPES.has(raw.type as WorkEventClaimType)) throw new Error(`${field}.type 无效`);
  if (!new Set(["explicit", "corroborated", "inferred"]).has(raw.certainty as string)) throw new Error(`${field}.certainty 无效`);
  return {
    type: raw.type as WorkEventClaimType,
    text: text(raw.text, `${field}.text`, 400),
    evidenceIds: stringList(raw.evidenceIds, `${field}.evidenceIds`, 100, 100),
    certainty: raw.certainty as EventClaim["certainty"],
  };
}

function event(value: unknown, index: number): WorkEvent {
  const field = `events[${index}]`;
  const raw = object(value, field);
  exactKeys(raw, field, [
    "eventKey", "title", "action", "object", "result", "status", "decision", "blockers", "nextActions",
    "participantNames", "projectSignals", "sourceTypes", "evidenceIds", "claims", "origin", "confidence", "missingFacts",
  ]);
  if (!EVENT_STATUS.has(raw.status as WorkEventStatus)) throw new Error(`${field}.status 无效`);
  if (raw.origin !== "today" && raw.origin !== "continuation") throw new Error(`${field}.origin 无效`);
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`${field}.confidence 无效`);
  const sourceTypes = stringList(raw.sourceTypes, `${field}.sourceTypes`, 20, 40);
  if (sourceTypes.some((source) => !SOURCE_TYPES.has(source as EvidenceSourceType))) throw new Error(`${field}.sourceTypes 无效`);
  const missingFacts = stringList(raw.missingFacts, `${field}.missingFacts`, 6, 30);
  if (missingFacts.some((fact) => !MISSING_FACTS.has(fact as WorkEventMissingFact))) throw new Error(`${field}.missingFacts 无效`);
  if (!Array.isArray(raw.claims) || raw.claims.length > 30) throw new Error(`${field}.claims 无效`);
  return {
    eventKey: text(raw.eventKey ?? "", `${field}.eventKey`, 100, true),
    title: text(raw.title, `${field}.title`, 160),
    action: text(raw.action, `${field}.action`, 300, true),
    object: text(raw.object, `${field}.object`, 200, true),
    result: text(raw.result, `${field}.result`, 500, true),
    status: raw.status as WorkEventStatus,
    decision: text(raw.decision, `${field}.decision`, 400, true),
    blockers: stringList(raw.blockers, `${field}.blockers`, 10, 240),
    nextActions: stringList(raw.nextActions, `${field}.nextActions`, 10, 240),
    participantNames: stringList(raw.participantNames, `${field}.participantNames`, 30, 80),
    projectSignals: stringList(raw.projectSignals, `${field}.projectSignals`, 20, 120),
    sourceTypes: sourceTypes as EvidenceSourceType[],
    evidenceIds: stringList(raw.evidenceIds, `${field}.evidenceIds`, 200, 100),
    claims: raw.claims.map((item, claimIndex) => claim(item, `${field}.claims[${claimIndex}]`)),
    origin: raw.origin,
    confidence: Math.round(confidence * 1000) / 1000,
    missingFacts: missingFacts as WorkEventMissingFact[],
  };
}

export function validateEventModelOutput(value: unknown): EventModelOutput {
  const raw = object(value, "output");
  exactKeys(raw, "output", ["schemaVersion", "events", "ignoredEvidence"]);
  if (raw.schemaVersion !== "work-event-v1") throw new Error("schemaVersion 必须为 work-event-v1");
  if (!Array.isArray(raw.events) || raw.events.length > 8) throw new Error("events 必须是最多 8 项的数组");
  if (!Array.isArray(raw.ignoredEvidence) || raw.ignoredEvidence.length > 500) throw new Error("ignoredEvidence 无效");
  return {
    schemaVersion: "work-event-v1",
    events: raw.events.map(event),
    ignoredEvidence: raw.ignoredEvidence.map((item, index) => {
      const ignored = object(item, `ignoredEvidence[${index}]`);
      exactKeys(ignored, `ignoredEvidence[${index}]`, ["evidenceId", "reason"]);
      if (!IGNORE_REASONS.has(ignored.reason as IgnoredEvidence["reason"])) throw new Error(`ignoredEvidence[${index}].reason 无效`);
      return {
        evidenceId: text(ignored.evidenceId, `ignoredEvidence[${index}].evidenceId`, 100),
        reason: ignored.reason as IgnoredEvidence["reason"],
      };
    }),
  };
}

export function parseAndValidateEventModelOutput(content: string): EventModelOutput {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new Error("模型输出必须是单一 JSON 对象");
  return validateEventModelOutput(JSON.parse(trimmed));
}
