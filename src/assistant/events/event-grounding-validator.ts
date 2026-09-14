import { isInAssistantReportingWindow } from "../reporting-window";
import { createHash } from "node:crypto";
import type { EvidenceWithReference } from "../evidence-store";
import type { CollectedEvidence } from "../schema";
import type { EventClaim, EventModelOutput, WorkEvent, WorkEventMissingFact } from "./event-types";
import { isSourceContainerTitle } from "../historical-report-parser";

const PLAN_TEXT = /(计划|拟|建议|待办|准备|安排|邀请|将要|后续需要|下一步)/;
const UNSAFE_TEXT = /(?:https?:\/\/|dingtalk:\/\/|\[[^\]]+]\([^)]+\)|```|^\s{0,3}#{1,6}\s|media[_-]?id|download[_-]?code|space[_-]?id)/im;

export interface GroundingValidationIssue {
  eventIndex: number;
  code: string;
}

export interface GroundingValidationResult {
  events: WorkEvent[];
  rejectedEvents: number;
  issues: GroundingValidationIssue[];
}

export interface GroundingValidationInput {
  output: EventModelOutput;
  userId: number;
  ddUserid: string;
  jobId: string;
  workDate: string;
  evidences: EvidenceWithReference[];
  now?: Date;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u3400-\u9fff.%]/g, "");
}

function sourceCorpus(evidences: EvidenceWithReference[]): string {
  return normalize(evidences.flatMap((item) => [
    item.evidence.title,
    item.evidence.summary,
    ...item.evidence.projectSignals,
    ...item.evidence.actorNames,
    ...item.evidence.participantNames,
  ]).join(" "));
}

function hasTextGrounding(text: string, corpus: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (normalized.length === 1) return corpus.includes(normalized);
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    if (corpus.includes(normalized.slice(index, index + 2))) return true;
  }
  return false;
}

function directToday(evidence: CollectedEvidence, workDate: string): boolean {
  return evidence.temporalRole === "today"
    && evidence.workUse === "direct_work"
    && isInAssistantReportingWindow(evidence.occurredAt, workDate);
}

function selfEvidence(evidence: CollectedEvidence, ddUserid: string): boolean {
  return evidence.relationToSelf === "self" || evidence.actorUserIds.includes(ddUserid);
}

function explicitResultEvidence(evidence: CollectedEvidence, workDate: string, ddUserid: string): boolean {
  if (!directToday(evidence, workDate) || !selfEvidence(evidence, ddUserid) || evidence.resultEligible === false) return false;
  if (evidence.sourceType === "calendar" || evidence.sourceType === "todo") return false;
  return !PLAN_TEXT.test(`${evidence.title} ${evidence.summary}`);
}

function unsafeOrCopied(text: string, evidences: EvidenceWithReference[]): boolean {
  if (!text) return false;
  if (UNSAFE_TEXT.test(text)) return true;
  const normalized = normalize(text);
  if (normalized.length < 10) return false;
  return evidences.some((item) => {
    if (item.evidence.sourceType !== "chat_group" && item.evidence.sourceType !== "chat_private") return false;
    const chat = normalize(item.evidence.summary);
    if (chat.length < 10) return false;
    return normalized === chat
      || (normalized.includes(chat) && chat.length / normalized.length >= 0.8)
      || (chat.includes(normalized) && normalized.length / chat.length >= 0.8);
  });
}

function unsupportedEntities(text: string, corpus: string): boolean {
  const normalized = normalize(text);
  for (const number of normalized.match(/\d+(?:\.\d+)?%?/g) ?? []) {
    if (!corpus.includes(number)) return true;
  }
  for (const latin of normalized.match(/[a-z][a-z0-9_.-]{1,}/g) ?? []) {
    if (!corpus.includes(latin)) return true;
  }
  for (const match of text.matchAll(/([\u3400-\u9fffA-Za-z0-9]{2,16})(客户|项目)/g)) {
    const prefix = normalize(match[1]);
    const suffix = normalize(match[2]);
    let found = false;
    for (let length = 2; length <= Math.min(prefix.length, 12); length += 1) {
      if (corpus.includes(`${prefix.slice(-length)}${suffix}`)) {
        found = true;
        break;
      }
    }
    if (!found) return true;
  }
  return false;
}

function uniqueFacts(current: WorkEventMissingFact[], extra: WorkEventMissingFact[]): WorkEventMissingFact[] {
  return [...new Set([...current, ...extra])];
}

function safeClaim(
  claim: EventClaim,
  eventEvidenceIds: Set<string>,
  allowed: Map<string, EvidenceWithReference>,
  corpus: string,
  evidences: EvidenceWithReference[],
): EventClaim | null {
  if (!claim.evidenceIds.length || claim.evidenceIds.some((id) => !eventEvidenceIds.has(id) || !allowed.has(id))) return null;
  if (unsafeOrCopied(claim.text, evidences) || unsupportedEntities(claim.text, corpus) || !hasTextGrounding(claim.text, corpus)) return null;
  return claim;
}

function groundedProjectSignals(event: WorkEvent, evidences: EvidenceWithReference[]): string[] {
  const allowed = new Set(evidences.flatMap((item) => item.evidence.projectSignals).map(normalize).filter(Boolean));
  return event.projectSignals.filter((signal) => allowed.has(normalize(signal)));
}

export function validateGroundedEvents(input: GroundingValidationInput): GroundingValidationResult {
  const now = input.now ?? new Date();
  const allowed = new Map(input.evidences
    .filter((item) => (
      item.jobId === input.jobId
      && item.userId === input.userId
      && item.workDate === input.workDate
      && Date.parse(item.expiresAt) > now.getTime()
    ))
    .map((item) => [item.referenceId, item]));
  const issues: GroundingValidationIssue[] = [];
  const events: WorkEvent[] = [];
  let rejectedEvents = 0;

  input.output.events.forEach((rawEvent, eventIndex) => {
    if (!rawEvent.evidenceIds.length || rawEvent.evidenceIds.some((id) => !allowed.has(id))) {
      issues.push({ eventIndex, code: "invalid_evidence_scope" });
      rejectedEvents += 1;
      return;
    }
    const evidenceIds = [...new Set(rawEvent.evidenceIds)];
    const evidences = evidenceIds.map((id) => allowed.get(id)!);
    const corpus = sourceCorpus(evidences);
    if (
      isSourceContainerTitle(rawEvent.title)
      || unsafeOrCopied(rawEvent.title, evidences)
      || unsupportedEntities(rawEvent.title, corpus)
      || !hasTextGrounding(rawEvent.title, corpus)
    ) {
      issues.push({ eventIndex, code: "unsafe_or_ungrounded_title" });
      rejectedEvents += 1;
      return;
    }

    const eventIdSet = new Set(evidenceIds);
    let claims = rawEvent.claims
      .map((claim) => safeClaim(claim, eventIdSet, allowed, corpus, evidences))
      .filter((claim): claim is EventClaim => Boolean(claim));
    let action = rawEvent.action;
    let object = rawEvent.object;
    let result = rawEvent.result;
    let decision = rawEvent.decision;
    let blockers = rawEvent.blockers;
    let nextActions = rawEvent.nextActions;
    let status = rawEvent.status;
    let confidence = rawEvent.confidence;
    let missingFacts = [...rawEvent.missingFacts];

    const todayEvidence = evidences.some((item) => directToday(item.evidence, input.workDate));
    if (rawEvent.origin === "today" && !todayEvidence) {
      issues.push({ eventIndex, code: "today_without_direct_evidence" });
      rejectedEvents += 1;
      return;
    }
    const selfTodayEvidence = evidences.some((item) => (
      directToday(item.evidence, input.workDate) && selfEvidence(item.evidence, input.ddUserid)
    ));
    if (rawEvent.origin === "today" && !selfTodayEvidence) {
      issues.push({ eventIndex, code: "today_without_self_evidence" });
      rejectedEvents += 1;
      return;
    }

    const claimHasSelfSupport = (type: EventClaim["type"]): boolean => claims
      .filter((claim) => claim.type === type)
      .flatMap((claim) => claim.evidenceIds)
      .some((id) => selfEvidence(allowed.get(id)!.evidence, input.ddUserid));
    if (action && (!claims.some((claim) => claim.type === "action") || !claimHasSelfSupport("action"))) {
      action = "";
      claims = claims.filter((claim) => claim.type !== "action");
      status = "uncertain";
      missingFacts = uniqueFacts(missingFacts, ["actor"]);
      issues.push({ eventIndex, code: "action_without_self_evidence" });
    }
    if (result && (!claims.some((claim) => claim.type === "result") || !claimHasSelfSupport("result"))) {
      result = "";
      claims = claims.filter((claim) => claim.type !== "result");
      status = "uncertain";
      missingFacts = uniqueFacts(missingFacts, ["result", "actor"]);
      issues.push({ eventIndex, code: "result_without_self_evidence" });
    }

    const unsafeFields: Array<["action" | "object" | "result" | "decision", string]> = [
      ["action", action], ["object", object], ["result", result], ["decision", decision],
    ];
    for (const [field, value] of unsafeFields) {
      if (!value || (!unsafeOrCopied(value, evidences) && !unsupportedEntities(value, corpus) && hasTextGrounding(value, corpus))) continue;
      if (field === "action") action = "";
      if (field === "object") object = "";
      if (field === "result") result = "";
      if (field === "decision") decision = "";
      if (field !== "object") claims = claims.filter((claim) => claim.type !== field);
      missingFacts = uniqueFacts(missingFacts, field === "result" ? ["result"] : []);
      issues.push({ eventIndex, code: `unsafe_or_ungrounded_${field}` });
    }
    if (decision && !claims.some((claim) => claim.type === "decision")) {
      decision = "";
      issues.push({ eventIndex, code: "decision_without_claim" });
    }
    blockers = blockers.filter((value) => (
      !unsafeOrCopied(value, evidences)
      && !unsupportedEntities(value, corpus)
      && hasTextGrounding(value, corpus)
      && claims.some((claim) => claim.type === "blocker")
    ));
    nextActions = nextActions.filter((value) => (
      !unsafeOrCopied(value, evidences)
      && !unsupportedEntities(value, corpus)
      && hasTextGrounding(value, corpus)
      && claims.some((claim) => claim.type === "next_action")
    ));

    if (rawEvent.origin === "continuation") {
      result = "";
      claims = claims.filter((claim) => claim.type !== "result");
      if (status === "completed") status = "uncertain";
      missingFacts = uniqueFacts(missingFacts, ["today", "result"]);
      confidence = Math.min(confidence, 0.6);
    }

    const explicitResultClaim = claims.find((claim) => claim.type === "result" && claim.certainty === "explicit");
    const explicitCompleted = Boolean(result && explicitResultClaim?.evidenceIds.some((id) => (
      explicitResultEvidence(allowed.get(id)!.evidence, input.workDate, input.ddUserid)
    )));
    if (status === "completed" && (!explicitCompleted || PLAN_TEXT.test(result))) {
      status = "uncertain";
      result = "";
      claims = claims.filter((claim) => claim.type !== "result");
      missingFacts = uniqueFacts(missingFacts, ["result", "status"]);
      confidence = Math.min(confidence, 0.6);
      issues.push({ eventIndex, code: "completed_without_explicit_result" });
    }

    if (evidences.some((item) => item.evidence.sourceCompleteness !== "complete")) {
      confidence = Math.min(confidence, 0.75);
      missingFacts = uniqueFacts(missingFacts, ["status"]);
      if (status === "completed") status = "uncertain";
      issues.push({ eventIndex, code: "partial_source_confidence_cap" });
    }

    const allowedNames = new Set(evidences.flatMap((item) => [
      ...item.evidence.actorNames,
      ...item.evidence.participantNames,
    ]).map(normalize).filter(Boolean));
    const participantNames = rawEvent.participantNames.filter((name) => allowedNames.has(normalize(name)));
    const projectSignals = groundedProjectSignals(rawEvent, evidences);
    if (projectSignals.length !== rawEvent.projectSignals.length) {
      missingFacts = uniqueFacts(missingFacts, ["project"]);
      issues.push({ eventIndex, code: "ungrounded_project_signal_removed" });
    }
    if (participantNames.length !== rawEvent.participantNames.length) {
      missingFacts = uniqueFacts(missingFacts, ["actor"]);
      issues.push({ eventIndex, code: "ungrounded_participant_removed" });
    }

    const sourceTypes = [...new Set(evidences.map((item) => item.evidence.sourceType))];
    const eventIdentity = normalize(`${rawEvent.title}|${action}|${object}`);
    const eventKey = createHash("sha256")
      .update(`${input.userId}:${input.jobId}:${input.workDate}:${eventIdentity}:${evidenceIds.slice().sort().join(":")}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    events.push({
      ...rawEvent,
      eventKey,
      action,
      object,
      result,
      decision,
      blockers,
      nextActions,
      status,
      participantNames,
      projectSignals,
      sourceTypes,
      evidenceIds,
      claims,
      confidence: Math.round(confidence * 1000) / 1000,
      missingFacts,
    });
  });
  return { events, rejectedEvents, issues };
}
