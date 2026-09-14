import { isInAssistantReportingWindow } from "../reporting-window";
import { createHash } from "node:crypto";
import type { EvidenceWithReference } from "../evidence-store";
import type { CollectedEvidence } from "../schema";
import type {
  InteractionCandidate,
  InteractionMissingFact,
  InteractionModelOutput,
} from "./interaction-types";

export interface InteractionGroundingIssue {
  candidateIndex: number;
  code: string;
}

export interface InteractionGroundingResult {
  candidates: InteractionCandidate[];
  rejectedCandidates: number;
  issues: InteractionGroundingIssue[];
}

export interface InteractionGroundingInput {
  output: InteractionModelOutput;
  userId: number;
  ddUserid: string;
  jobId: string;
  workDate: string;
  evidences: EvidenceWithReference[];
  now?: Date;
  maxCandidates?: number;
}

const UNSAFE_TEXT = /(?:https?:\/\/|dingtalk:\/\/|\[[^\]]+]\([^)]+\)|```|^\s{0,3}#{1,6}\s|media[_-]?id|download[_-]?code)/im;
const RESULT_TEXT = /(完成|已完成|交付|发布|上线|通过|解决|修复|已处理|已提交|已回复|已审批)/;

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u3400-\u9fff.%]/g, "");
}

function corpus(evidences: EvidenceWithReference[]): string {
  return normalize(evidences.flatMap((item) => [
    item.evidence.title,
    item.evidence.summary,
    ...item.evidence.actorNames,
    ...item.evidence.participantNames,
    ...item.evidence.projectSignals,
  ]).join(" "));
}

function hasGrounding(value: string, source: string): boolean {
  const normalized = normalize(value);
  if (!normalized) return true;
  if (normalized.length === 1) return source.includes(normalized);
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    if (source.includes(normalized.slice(index, index + 2))) return true;
  }
  return false;
}

function isToday(evidence: CollectedEvidence, workDate: string): boolean {
  return isInAssistantReportingWindow(evidence.occurredAt, workDate) && evidence.temporalRole === "today";
}

function isSelf(evidence: CollectedEvidence, ddUserid: string): boolean {
  return evidence.relationToSelf === "self" || Boolean(ddUserid && evidence.actorUserIds.includes(ddUserid));
}

function isTaskSignal(evidence: CollectedEvidence): boolean {
  return evidence.workUse === "task_signal"
    || evidence.relationToSelf === "addressed"
    || evidence.sourceType === "todo"
    || evidence.sourceType === "approval"
    || evidence.sourceType === "ding";
}

function addMissing(current: InteractionMissingFact[], values: InteractionMissingFact[]): InteractionMissingFact[] {
  return [...new Set([...current, ...values])];
}

export function validateGroundedInteractions(input: InteractionGroundingInput): InteractionGroundingResult {
  const now = input.now ?? new Date();
  const allowed = new Map(input.evidences.filter((item) => (
    item.jobId === input.jobId
    && item.userId === input.userId
    && item.workDate === input.workDate
    && Date.parse(item.expiresAt) > now.getTime()
  )).map((item) => [item.referenceId, item]));
  const issues: InteractionGroundingIssue[] = [];
  const candidates: InteractionCandidate[] = [];
  let rejectedCandidates = 0;

  input.output.candidates.forEach((raw, candidateIndex) => {
    if (!raw.evidenceIds.length || raw.evidenceIds.some((id) => !allowed.has(id))) {
      issues.push({ candidateIndex, code: "invalid_evidence_scope" });
      rejectedCandidates += 1;
      return;
    }
    const evidenceIds = [...new Set(raw.evidenceIds)];
    const evidence = evidenceIds.map((id) => allowed.get(id)!);
    const hasStrongSignal = evidence.some((item) => (
      isTaskSignal(item.evidence)
      || (isToday(item.evidence, input.workDate) && isSelf(item.evidence, input.ddUserid))
    ));
    if (!hasStrongSignal) {
      issues.push({ candidateIndex, code: "no_task_or_self_signal" });
      rejectedCandidates += 1;
      return;
    }
    const source = corpus(evidence);
    if (UNSAFE_TEXT.test(raw.title) || !hasGrounding(raw.title, source)) {
      issues.push({ candidateIndex, code: "unsafe_or_ungrounded_title" });
      rejectedCandidates += 1;
      return;
    }
    let summary = raw.summary;
    let latestProgress = raw.latestProgress;
    if (UNSAFE_TEXT.test(summary) || !hasGrounding(summary, source)) {
      summary = raw.title;
      issues.push({ candidateIndex, code: "ungrounded_summary_replaced" });
    }
    if (UNSAFE_TEXT.test(latestProgress) || !hasGrounding(latestProgress, source)) {
      latestProgress = "";
      issues.push({ candidateIndex, code: "ungrounded_progress_removed" });
    }

    const selfToday = evidence.some((item) => isToday(item.evidence, input.workDate) && isSelf(item.evidence, input.ddUserid));
    const explicitSelfResult = evidence.some((item) => (
      isToday(item.evidence, input.workDate)
      && isSelf(item.evidence, input.ddUserid)
      && item.evidence.workUse === "direct_work"
      && item.evidence.resultEligible !== false
      && RESULT_TEXT.test(`${item.evidence.title} ${item.evidence.summary}`)
    ));
    const explicitAddressed = evidence.some((item) => item.evidence.relationToSelf === "addressed");
    let direction = raw.direction;
    let state = raw.state;
    let confidence = raw.confidence;
    let selfActionSupported = raw.selfActionSupported && selfToday;
    let resultSupported = raw.resultSupported && explicitSelfResult;
    let missingFacts = [...raw.missingFacts];

    if (direction === "assigned_to_me" && !explicitAddressed) {
      direction = "unknown";
      confidence = Math.min(confidence, 0.6);
      missingFacts = addMissing(missingFacts, ["actor"]);
      issues.push({ candidateIndex, code: "assignment_without_explicit_target" });
    }
    if (!selfActionSupported) {
      state = state === "blocked" ? "blocked" : "pending";
      latestProgress = "";
      resultSupported = false;
      missingFacts = addMissing(missingFacts, ["today", "result", "status"]);
      confidence = Math.min(confidence, 0.65);
    } else if (state === "completed" && !resultSupported) {
      state = "in_progress";
      missingFacts = addMissing(missingFacts, ["result", "status"]);
      confidence = Math.min(confidence, 0.7);
      issues.push({ candidateIndex, code: "completed_without_self_result" });
    }
    if (!resultSupported) missingFacts = addMissing(missingFacts, ["result"]);

    const allowedNames = new Set(evidence.flatMap((item) => [
      ...item.evidence.actorNames, ...item.evidence.participantNames,
    ]).map(normalize).filter(Boolean));
    const allowedProjects = new Set(evidence.flatMap((item) => item.evidence.projectSignals).map(normalize).filter(Boolean));
    const participantNames = raw.participantNames.filter((name) => allowedNames.has(normalize(name)));
    const projectSignals = raw.projectSignals.filter((signal) => allowedProjects.has(normalize(signal)));
    if (participantNames.length !== raw.participantNames.length) missingFacts = addMissing(missingFacts, ["actor"]);
    if (projectSignals.length !== raw.projectSignals.length) missingFacts = addMissing(missingFacts, ["project"]);
    const sourceTypes = [...new Set(evidence.map((item) => item.evidence.sourceType))];
    const latestAt = evidence.map((item) => item.evidence.occurredAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? raw.latestAt;
    const identity = normalize(`${raw.title}|${summary}|${direction}`);
    const candidateKey = `task:${createHash("sha256")
      .update(`${input.userId}:${input.jobId}:${input.workDate}:${identity}:${evidenceIds.slice().sort().join(":")}`, "utf8")
      .digest("hex").slice(0, 24)}`;
    candidates.push({
      ...raw,
      candidateKey,
      summary,
      latestProgress,
      direction,
      state,
      participantNames,
      projectSignals,
      sourceTypes,
      evidenceIds,
      latestAt,
      confidence: Math.round(confidence * 1000) / 1000,
      selfActionSupported,
      resultSupported,
      missingFacts: addMissing(missingFacts, ["hours"]),
    });
  });

  const requestedLimit = Math.max(1, Math.min(100, input.maxCandidates ?? 50));
  // Cross-batch duplicates are merged by the generation service. Keep a bounded
  // grounding buffer here so repeated candidates cannot crowd out later unique work.
  const groundingLimit = Math.min(2_000, Math.max(requestedLimit * 4, input.evidences.length));
  const priorityRank = { P1: 0, P2: 1, P3: 2, unknown: 3 } as const;
  const selected = candidates
    .sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority]
      || Date.parse(right.latestAt) - Date.parse(left.latestAt)
      || right.confidence - left.confidence)
    .slice(0, groundingLimit);
  return { candidates: selected, rejectedCandidates, issues };
}
