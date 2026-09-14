import { isInAssistantReportingWindow } from "../reporting-window";
import type { SessionUser } from "../../auth/types";
import { logStructured } from "../../infra/logger";
import { mapSettledWithConcurrency } from "../bounded-parallel";
import type { EvidenceWithReference } from "../evidence-store";
import { sanitizeChatEvidenceText } from "../evidence-filter";
import type { SourceCompletenessSummary } from "../events/event-types";
import { validateGroundedInteractions, type InteractionGroundingIssue } from "./interaction-grounding-validator";
import {
  InteractionModelClient,
  InteractionModelUnavailableError,
  type ValidatedInteractionModelResponse,
} from "./interaction-model-client";
import { InteractionRepository } from "./interaction-repository";
import type { InteractionCandidate, InteractionModelOutput } from "./interaction-types";
import { TASK_DISCOVERY_SYSTEM_PROMPT } from "./prompts/task-discovery-v1";

export interface InteractionGenerationInput {
  jobId: string;
  user: SessionUser;
  workDate: string;
  evidences: EvidenceWithReference[];
  completeness: SourceCompletenessSummary[];
  expiresAt: string;
  now?: Date;
}

export interface InteractionGenerationResult {
  candidates: InteractionCandidate[];
  analysisMode: "real_model" | "manual";
  runId: string;
  errorCode?: "model_unavailable" | "model_schema_failed";
  scannedReferences: number;
  signalEvidence: number;
  interactionCandidates: number;
  ignoredEvidence: number;
  validationIssues: InteractionGroundingIssue[];
}

export interface InteractionGenerationOptions {
  promptVersion: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCandidates: number;
}

interface DiscoveryItem {
  evidenceId: string;
  sourceType: string;
  title: string;
  summary: string;
  occurredAt: string;
  actorNames: string[];
  participantNames: string[];
  relationToSelf: string;
  workUse: string;
  projectSignals: string[];
  conversationId: string;
  threadId: string;
  replyToMessageId: string;
  quotedMessageId: string;
}

interface DiscoveryThread {
  threadKey: string;
  items: DiscoveryItem[];
}

const CHAT_WINDOW_MS = 30 * 60 * 1000;
const MAX_ADJACENT_EACH_SIDE = 4;
const MAX_CONTEXT_ITEMS_PER_CONVERSATION = 40;
const MAX_THREAD_ITEMS = 60;
export const TASK_DISCOVERY_MAX_BATCH_INPUT_TOKENS = 4_500;
export const TASK_DISCOVERY_MAX_THREADS_PER_BATCH = 4;
export const INTERACTION_BATCH_CONCURRENCY = 2;
const MODEL_MESSAGE_OVERHEAD_TOKENS = 64;

export class InteractionInputBudgetError extends Error {
  constructor() {
    super("task_discovery_item_exceeds_input_budget");
    this.name = "InteractionInputBudgetError";
  }
}

function stamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isChat(item: EvidenceWithReference): boolean {
  return item.evidence.sourceType === "chat_group" || item.evidence.sourceType === "chat_private";
}

function isAnchor(item: EvidenceWithReference, workDate: string): boolean {
  const evidence = item.evidence;
  if (!isInAssistantReportingWindow(evidence.occurredAt, workDate) || evidence.temporalRole !== "today") return false;
  return evidence.workUse === "task_signal"
    || evidence.workUse === "direct_work"
    || evidence.relationToSelf === "addressed"
    || evidence.sourceType === "todo"
    || evidence.sourceType === "approval"
    || evidence.sourceType === "ding";
}

function discoveryItem(item: EvidenceWithReference): DiscoveryItem {
  const evidence = item.evidence;
  const chat = isChat(item);
  return {
    evidenceId: item.referenceId,
    sourceType: evidence.sourceType,
    title: String(evidence.analysisTitle ?? evidence.title).slice(0, 200),
    summary: (chat
      ? sanitizeChatEvidenceText(String(evidence.analysisSummary ?? evidence.summary))
      : String(evidence.analysisSummary ?? evidence.summary).trim()).slice(0, 2_000),
    occurredAt: evidence.occurredAt,
    actorNames: evidence.actorNames.slice(0, 30),
    participantNames: evidence.participantNames.slice(0, 30),
    relationToSelf: evidence.relationToSelf ?? "bot_or_unknown",
    workUse: evidence.workUse ?? "background_only",
    projectSignals: evidence.projectSignals.slice(0, 20),
    conversationId: evidence.conversationId ?? "",
    threadId: evidence.threadId ?? "",
    replyToMessageId: evidence.replyToMessageId ?? "",
    quotedMessageId: evidence.quotedMessageId ?? "",
  };
}

/** Include every strong signal plus bounded same-conversation context without treating a group title as a merge key. */
export function buildInteractionDiscoveryThreads(
  evidences: EvidenceWithReference[],
  workDate: string,
): { threads: DiscoveryThread[]; signalEvidenceIds: string[] } {
  const anchors = evidences.filter((item) => isAnchor(item, workDate));
  const signalEvidenceIds = anchors.map((item) => item.referenceId);
  const selected = new Set(signalEvidenceIds);
  const byConversation = new Map<string, EvidenceWithReference[]>();
  for (const item of evidences.filter(isChat)) {
    const key = item.evidence.conversationId ?? `single:${item.referenceId}`;
    const group = byConversation.get(key) ?? [];
    group.push(item);
    byConversation.set(key, group);
  }
  for (const [conversationId, rawMessages] of byConversation) {
    const messages = rawMessages.slice().sort((left, right) => stamp(left.evidence.occurredAt) - stamp(right.evidence.occurredAt));
    const conversationAnchors = anchors.filter((anchor) => isChat(anchor)
      && (anchor.evidence.conversationId ?? `single:${anchor.referenceId}`) === conversationId);
    const context = new Map<string, { item: EvidenceWithReference; explicit: boolean; distance: number }>();
    const consider = (anchor: EvidenceWithReference, message: EvidenceWithReference, explicit: boolean) => {
      if (selected.has(message.referenceId)) return;
      const distance = Math.abs(stamp(message.evidence.occurredAt) - stamp(anchor.evidence.occurredAt));
      const current = context.get(message.referenceId);
      if (!current || (explicit && !current.explicit) || (explicit === current.explicit && distance < current.distance)) {
        context.set(message.referenceId, { item: message, explicit, distance });
      }
    };
    for (const anchor of conversationAnchors) {
      messages.forEach((message) => {
        const explicitThread = Boolean(anchor.evidence.threadId && message.evidence.threadId === anchor.evidence.threadId);
        const explicitlyLinked = [anchor.evidence.replyToMessageId, anchor.evidence.quotedMessageId].includes(message.evidence.externalId)
          || [message.evidence.replyToMessageId, message.evidence.quotedMessageId].includes(anchor.evidence.externalId);
        if (explicitThread || explicitlyLinked) consider(anchor, message, true);
      });
      const anchorIndex = messages.findIndex((message) => message.referenceId === anchor.referenceId);
      if (anchorIndex < 0) continue;
      for (let offset = 1; offset <= MAX_ADJACENT_EACH_SIDE; offset += 1) {
        for (const index of [anchorIndex - offset, anchorIndex + offset]) {
          const message = messages[index];
          if (!message) continue;
          if (Math.abs(stamp(message.evidence.occurredAt) - stamp(anchor.evidence.occurredAt)) <= CHAT_WINDOW_MS) {
            consider(anchor, message, false);
          }
        }
      }
    }
    [...context.values()]
      .sort((left, right) => Number(right.explicit) - Number(left.explicit)
        || left.distance - right.distance
        || stamp(left.item.evidence.occurredAt) - stamp(right.item.evidence.occurredAt))
      .slice(0, MAX_CONTEXT_ITEMS_PER_CONVERSATION)
      .forEach(({ item }) => selected.add(item.referenceId));
  }

  const groups = new Map<string, EvidenceWithReference[]>();
  for (const item of evidences) {
    if (!selected.has(item.referenceId)) continue;
    const key = isChat(item)
      ? `conversation:${item.evidence.conversationId ?? item.referenceId}`
      : `source:${item.evidence.sourceType}:${item.referenceId}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const threads: DiscoveryThread[] = [];
  for (const [key, raw] of groups) {
    const sorted = raw.slice().sort((left, right) => stamp(left.evidence.occurredAt) - stamp(right.evidence.occurredAt));
    for (let offset = 0; offset < sorted.length; offset += MAX_THREAD_ITEMS) {
      threads.push({
        threadKey: sorted.length > MAX_THREAD_ITEMS ? `${key}:${Math.floor(offset / MAX_THREAD_ITEMS) + 1}` : key,
        items: sorted.slice(offset, offset + MAX_THREAD_ITEMS).map(discoveryItem),
      });
    }
  }
  return { threads, signalEvidenceIds };
}

function estimatedTextTokens(value: string): number {
  let nonAscii = 0;
  let ascii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! > 0x7f) nonAscii += 1;
    else ascii += 1;
  }
  return nonAscii + Math.ceil(ascii / 3);
}

export function estimateInteractionRequestTokens(systemPrompt: string, payload: Record<string, unknown>): number {
  return MODEL_MESSAGE_OVERHEAD_TOKENS
    + estimatedTextTokens(systemPrompt)
    + estimatedTextTokens(JSON.stringify(payload));
}

interface DiscoveryRequestBase {
  workDate: string;
  employee: { userId: number; ddUserid: string; displayName: string };
  sourceCompleteness: SourceCompletenessSummary[];
}

function discoveryPayload(base: DiscoveryRequestBase, taskThreads: DiscoveryThread[]): Record<string, unknown> {
  return { ...base, taskThreads };
}

function compactMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  if (maxChars <= 3) return value.slice(0, maxChars);
  const tailChars = Math.floor((maxChars - 1) / 3);
  const headChars = maxChars - tailChars - 1;
  return `${value.slice(0, headChars)}…${value.slice(-tailChars)}`;
}

function compactLowPriorityFields(
  thread: DiscoveryThread,
  arrayItems: number,
  arrayTextChars: number,
  identifierChars: number,
): DiscoveryThread {
  const item = thread.items[0];
  const list = (values: string[]) => values.slice(0, arrayItems).map((value) => value.slice(0, arrayTextChars));
  const identifier = (value: string) => value.slice(0, identifierChars);
  return {
    threadKey: identifier(thread.threadKey),
    items: [{
      ...item,
      actorNames: list(item.actorNames),
      participantNames: list(item.participantNames),
      projectSignals: list(item.projectSignals),
      conversationId: identifier(item.conversationId),
      threadId: identifier(item.threadId),
      replyToMessageId: identifier(item.replyToMessageId),
      quotedMessageId: identifier(item.quotedMessageId),
    }],
  };
}

function compactOversizedSingleItemThread(
  thread: DiscoveryThread,
  fits: (candidate: DiscoveryThread[]) => boolean,
): DiscoveryThread {
  if (thread.items.length !== 1) throw new InteractionInputBudgetError();
  for (const limits of [
    { arrayItems: 8, arrayTextChars: 80, identifierChars: 160 },
    { arrayItems: 4, arrayTextChars: 60, identifierChars: 80 },
    { arrayItems: 0, arrayTextChars: 0, identifierChars: 0 },
  ]) {
    const compacted = compactLowPriorityFields(
      thread, limits.arrayItems, limits.arrayTextChars, limits.identifierChars,
    );
    if (fits([compacted])) return compacted;
  }

  const minimal = compactLowPriorityFields(thread, 0, 0, 0);
  const originalSummary = minimal.items[0].summary;
  const withSummary = (maxChars: number): DiscoveryThread => ({
    ...minimal,
    items: [{ ...minimal.items[0], summary: compactMiddle(originalSummary, maxChars) }],
  });
  if (!fits([withSummary(0)])) throw new InteractionInputBudgetError();
  let low = 0;
  let high = originalSummary.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits([withSummary(middle)])) low = middle;
    else high = middle - 1;
  }
  return withSummary(low);
}

function batchThreads(
  threads: DiscoveryThread[],
  configuredMaxInputTokens: number,
  base: DiscoveryRequestBase,
): DiscoveryThread[][] {
  const maxInputTokens = Math.max(1, Math.min(configuredMaxInputTokens, TASK_DISCOVERY_MAX_BATCH_INPUT_TOKENS));
  const fits = (candidate: DiscoveryThread[]) => estimateInteractionRequestTokens(
    TASK_DISCOVERY_SYSTEM_PROMPT,
    discoveryPayload(base, candidate),
  ) <= maxInputTokens;
  const batches: DiscoveryThread[][] = [];
  let current: DiscoveryThread[] = [];
  const boundedThreads = threads.flatMap((thread) => {
    if (fits([thread])) return [thread];
    const chunks: DiscoveryThread[] = [];
    let items: DiscoveryItem[] = [];
    const chunk = (chunkItems: DiscoveryItem[]): DiscoveryThread => ({
      threadKey: `${thread.threadKey}:part-${chunks.length + 1}`,
      items: chunkItems,
    });
    for (const item of thread.items) {
      const next = chunk([...items, item]);
      if (items.length && !fits([next])) {
        chunks.push(chunk(items));
        items = [];
      }
      items.push(item);
    }
    if (items.length) chunks.push(chunk(items));
    return chunks.map((chunk) => (
      fits([chunk]) ? chunk : compactOversizedSingleItemThread(chunk, fits)
    ));
  });
  for (const thread of boundedThreads) {
    if (current.length && (current.length >= TASK_DISCOVERY_MAX_THREADS_PER_BATCH || !fits([...current, thread]))) {
      batches.push(current);
      current = [];
    }
    current.push(thread);
  }
  if (current.length) batches.push(current);
  return batches;
}

function aggregateResponses(responses: ValidatedInteractionModelResponse[]) {
  const last = responses.at(-1);
  return {
    provider: last?.provider,
    model: last?.model,
    inputTokens: responses.reduce((sum, response) => sum + response.inputTokens, 0),
    outputTokens: responses.reduce((sum, response) => sum + response.outputTokens, 0),
    durationMs: responses.reduce((sum, response) => sum + response.durationMs, 0),
    retryCount: responses.reduce((sum, response) => sum + response.retryCount, 0),
  };
}

function mergeExactDuplicates(candidates: InteractionCandidate[]): InteractionCandidate[] {
  const result: InteractionCandidate[] = [];
  for (const candidate of candidates) {
    const identity = candidate.title.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
    const candidateEvidence = new Set(candidate.evidenceIds);
    const existingIndex = result.findIndex((item) => {
      const itemIdentity = item.title.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
      return itemIdentity === identity && item.evidenceIds.some((id) => candidateEvidence.has(id));
    });
    const existing = existingIndex >= 0 ? result[existingIndex] : undefined;
    if (!existing) {
      result.push(candidate);
      continue;
    }
    const evidenceIds = [...new Set([...existing.evidenceIds, ...candidate.evidenceIds])];
    result[existingIndex] = {
      ...existing,
      evidenceIds,
      sourceTypes: [...new Set([...existing.sourceTypes, ...candidate.sourceTypes])],
      participantNames: [...new Set([...existing.participantNames, ...candidate.participantNames])],
      projectSignals: [...new Set([...existing.projectSignals, ...candidate.projectSignals])],
      latestAt: stamp(candidate.latestAt) > stamp(existing.latestAt) ? candidate.latestAt : existing.latestAt,
      latestProgress: stamp(candidate.latestAt) > stamp(existing.latestAt) ? candidate.latestProgress : existing.latestProgress,
      confidence: Math.max(existing.confidence, candidate.confidence),
      selfActionSupported: existing.selfActionSupported || candidate.selfActionSupported,
      resultSupported: existing.resultSupported || candidate.resultSupported,
      missingFacts: [...new Set([...existing.missingFacts, ...candidate.missingFacts])],
    };
  }
  return result;
}

export class InteractionGenerationService {
  constructor(
    private readonly client: InteractionModelClient,
    private readonly repository: InteractionRepository,
    private readonly options: InteractionGenerationOptions,
  ) {}

  async generate(input: InteractionGenerationInput): Promise<InteractionGenerationResult> {
    const now = input.now ?? new Date();
    const runId = this.repository.createRun(
      input.jobId, input.user.id, input.workDate, this.options.promptVersion, input.expiresAt, now,
    );
    const built = buildInteractionDiscoveryThreads(input.evidences, input.workDate);
    const responses: ValidatedInteractionModelResponse[] = [];
    try {
      const rawCandidates: InteractionCandidate[] = [];
      const ignored: InteractionModelOutput["ignoredEvidence"] = [];
      const requestBase: DiscoveryRequestBase = {
        workDate: input.workDate,
        employee: { userId: input.user.id, ddUserid: input.user.ddUserid ?? "", displayName: input.user.name },
        sourceCompleteness: input.completeness,
      };
      const batches = batchThreads(built.threads, this.options.maxInputTokens, requestBase);
      const inputBudgetTokens = Math.max(1, Math.min(
        this.options.maxInputTokens,
        TASK_DISCOVERY_MAX_BATCH_INPUT_TOKENS,
      ));
      let failedBatches = 0;
      let lastBatchError: InteractionModelUnavailableError | undefined;
      const batchResults = await mapSettledWithConcurrency(
        batches,
        INTERACTION_BATCH_CONCURRENCY,
        async (threads, batchIndex) => {
          const payload = discoveryPayload(requestBase, threads);
          const estimatedInputTokens = estimateInteractionRequestTokens(TASK_DISCOVERY_SYSTEM_PROMPT, payload);
          logStructured({
            evt: "assistant_interaction_batch_started",
            userId: input.user.id,
            jobId: input.jobId,
            batchIndex: batchIndex + 1,
            batchCount: batches.length,
            threadCount: threads.length,
            itemCount: threads.reduce((sum, thread) => sum + thread.items.length, 0),
            estimatedInputTokens,
            inputBudgetTokens,
          });
          try {
            const response = await this.client.analyze({
              phase: "extract",
              systemPrompt: TASK_DISCOVERY_SYSTEM_PROMPT,
              payload,
              promptVersion: this.options.promptVersion,
              maxOutputTokens: this.options.maxOutputTokens,
            });
            logStructured({
              evt: "assistant_interaction_batch_completed",
              userId: input.user.id,
              jobId: input.jobId,
              batchIndex: batchIndex + 1,
              batchCount: batches.length,
              threadCount: threads.length,
              estimatedInputTokens,
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
              durationMs: response.durationMs,
              candidateCount: response.output.candidates.length,
            });
            return response;
          } catch (error) {
            logStructured({
              evt: "assistant_interaction_batch_failed",
              userId: input.user.id,
              jobId: input.jobId,
              batchIndex: batchIndex + 1,
              batchCount: batches.length,
              threadCount: threads.length,
              itemCount: threads.reduce((sum, thread) => sum + thread.items.length, 0),
              estimatedInputTokens,
              inputBudgetTokens,
              errorCode: error instanceof InteractionModelUnavailableError ? error.code : "interaction_generation_failed",
            });
            throw error;
          }
        },
      );
      let unexpectedBatchError: unknown;
      let hasUnexpectedBatchError = false;
      for (const outcome of batchResults) {
        if (outcome.status === "fulfilled") {
          responses.push(outcome.value);
          rawCandidates.push(...outcome.value.output.candidates);
          ignored.push(...outcome.value.output.ignoredEvidence);
          continue;
        }
        if (outcome.reason instanceof InteractionModelUnavailableError) {
          failedBatches += 1;
          lastBatchError = outcome.reason;
        } else if (!hasUnexpectedBatchError) {
          unexpectedBatchError = outcome.reason;
          hasUnexpectedBatchError = true;
        }
      }
      if (hasUnexpectedBatchError) throw unexpectedBatchError;
      if (batches.length > 0 && responses.length === 0) throw lastBatchError
        ?? new InteractionModelUnavailableError("model_unavailable");
      const grounded = validateGroundedInteractions({
        output: {
          schemaVersion: "interaction-candidate-v1",
          candidates: rawCandidates,
          ignoredEvidence: ignored,
        },
        userId: input.user.id,
        ddUserid: String(input.user.ddUserid ?? ""),
        jobId: input.jobId,
        workDate: input.workDate,
        evidences: input.evidences,
        now,
        maxCandidates: this.options.maxCandidates,
      });
      const candidates = mergeExactDuplicates(grounded.candidates).slice(0, this.options.maxCandidates);
      this.repository.replaceCandidates(
        runId, input.jobId, input.user.id, input.workDate, candidates, input.expiresAt, now,
      );
      const used = new Set(candidates.flatMap((candidate) => candidate.evidenceIds));
      const model = aggregateResponses(responses);
      const partial = input.completeness.some((source) => !source.complete)
        || failedBatches > 0
        || grounded.rejectedCandidates > 0
        || grounded.issues.length > 0;
      const ignoredEvidenceCount = Math.max(0, input.evidences.length - used.size);
      this.repository.finishRun(runId, {
        status: partial ? "partial" : "complete",
        ...model,
        inputEvidenceCount: input.evidences.length,
        signalEvidenceCount: built.signalEvidenceIds.length,
        candidateCount: candidates.length,
        ignoredEvidenceCount,
      }, now);
      logStructured({
        evt: "assistant_interaction_discovery",
        userId: input.user.id,
        jobId: input.jobId,
        scannedReferences: input.evidences.length,
        signalEvidence: built.signalEvidenceIds.length,
        interactionCandidates: candidates.length,
        rejectedCandidateCount: grounded.rejectedCandidates,
        failedBatchCount: failedBatches,
        status: partial ? "partial" : "complete",
      });
      return {
        candidates,
        analysisMode: "real_model",
        runId,
        scannedReferences: input.evidences.length,
        signalEvidence: built.signalEvidenceIds.length,
        interactionCandidates: candidates.length,
        ignoredEvidence: ignoredEvidenceCount,
        validationIssues: grounded.issues,
      };
    } catch (error) {
      const code = error instanceof InteractionModelUnavailableError ? error.code : "interaction_generation_failed";
      const model = aggregateResponses(responses);
      this.repository.finishRun(runId, {
        status: "failed",
        ...model,
        inputEvidenceCount: input.evidences.length,
        signalEvidenceCount: built.signalEvidenceIds.length,
        candidateCount: 0,
        ignoredEvidenceCount: input.evidences.length,
        errorCode: code,
      }, now);
      logStructured({ evt: "assistant_interaction_discovery_failed", userId: input.user.id, jobId: input.jobId, errorCode: code });
      if (!(error instanceof InteractionModelUnavailableError)) throw error;
      return {
        candidates: [],
        analysisMode: "manual",
        runId,
        errorCode: error.code,
        scannedReferences: input.evidences.length,
        signalEvidence: built.signalEvidenceIds.length,
        interactionCandidates: 0,
        ignoredEvidence: input.evidences.length,
        validationIssues: [],
      };
    }
  }
}
