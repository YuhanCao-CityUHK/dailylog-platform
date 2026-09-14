import { createHash } from "node:crypto";
import type { EvidenceWithReference } from "../evidence-store";
import type { EvidenceBundle, EvidenceBundleItem, IgnoredEvidence } from "./event-types";

const ADJACENT_WINDOW_MS = 30 * 60 * 1000;
const MAX_ADJACENT_MESSAGES = 2;

function stamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bundleId(ids: string[]): string {
  return `chat_${createHash("sha256").update(ids.slice().sort().join(":"), "utf8").digest("hex").slice(0, 16)}`;
}

function modelItem(item: EvidenceWithReference): EvidenceBundleItem {
  const evidence = item.evidence;
  const analysisTitle = String(evidence.analysisTitle ?? "").trim();
  const analysisSummary = String(evidence.analysisSummary ?? "").trim();
  return {
    evidenceId: item.referenceId,
    sourceType: evidence.sourceType,
    title: (analysisTitle || evidence.title).slice(0, 200),
    summary: (analysisSummary || evidence.summary).slice(0, 6_000),
    occurredAt: evidence.occurredAt,
    actorNames: evidence.actorNames,
    participantNames: evidence.participantNames,
    relationToSelf: evidence.relationToSelf ?? "bot_or_unknown",
    temporalRole: evidence.temporalRole ?? "history",
    workUse: evidence.workUse ?? "background_only",
    sourceCompleteness: evidence.sourceCompleteness ?? "partial",
    projectSignals: evidence.projectSignals,
    conversationId: evidence.conversationId,
    threadId: evidence.threadId,
    replyToMessageId: evidence.replyToMessageId,
    quotedMessageId: evidence.quotedMessageId,
    resourceRefs: evidence.resourceRefs ?? [],
    linkedObjectIds: evidence.linkedObjectIds ?? [],
  };
}

function mergeOverlapping(groups: Array<Set<number>>): Array<Set<number>> {
  const merged: Array<Set<number>> = [];
  for (const group of groups) {
    const overlaps = merged.filter((candidate) => [...group].some((index) => candidate.has(index)));
    if (!overlaps.length) {
      merged.push(new Set(group));
      continue;
    }
    const target = overlaps[0];
    for (const index of group) target.add(index);
    for (const extra of overlaps.slice(1)) {
      for (const index of extra) target.add(index);
      merged.splice(merged.indexOf(extra), 1);
    }
  }
  return merged;
}

function isAnchor(item: EvidenceWithReference): boolean {
  const evidence = item.evidence;
  return evidence.relationToSelf === "self"
    || evidence.relationToSelf === "addressed"
    || Boolean(evidence.resourceRefs?.length)
    || Boolean(evidence.linkedObjectIds?.length);
}

export function buildChatContextBundles(items: EvidenceWithReference[]): {
  bundles: EvidenceBundle[];
  ignoredEvidence: IgnoredEvidence[];
} {
  const conversations = new Map<string, EvidenceWithReference[]>();
  const ignoredEvidence: IgnoredEvidence[] = [];
  for (const item of items) {
    if (item.evidence.relationToSelf === "bot_or_unknown") {
      ignoredEvidence.push({ evidenceId: item.referenceId, reason: "bot_or_unknown" });
      continue;
    }
    const conversationId = item.evidence.conversationId ?? `single:${item.referenceId}`;
    const group = conversations.get(conversationId) ?? [];
    group.push(item);
    conversations.set(conversationId, group);
  }

  const bundles: EvidenceBundle[] = [];
  for (const messages of conversations.values()) {
    messages.sort((left, right) => stamp(left.evidence.occurredAt) - stamp(right.evidence.occurredAt)
      || left.referenceId.localeCompare(right.referenceId));
    const byExternalId = new Map(messages.map((message, index) => [message.evidence.externalId, index]));
    const groups: Array<Set<number>> = [];
    messages.forEach((message, anchorIndex) => {
      if (!isAnchor(message)) return;
      const selected = new Set<number>([anchorIndex]);
      const anchor = message.evidence;
      if (anchor.threadId) {
        messages.forEach((candidate, index) => {
          if (candidate.evidence.threadId === anchor.threadId) selected.add(index);
        });
      }
      for (const relationId of [anchor.replyToMessageId, anchor.quotedMessageId]) {
        const related = relationId ? byExternalId.get(relationId) : undefined;
        if (related !== undefined) selected.add(related);
      }
      messages.forEach((candidate, index) => {
        if (candidate.evidence.replyToMessageId === anchor.externalId || candidate.evidence.quotedMessageId === anchor.externalId) {
          selected.add(index);
        }
      });
      for (let offset = 1; offset <= MAX_ADJACENT_MESSAGES; offset += 1) {
        for (const index of [anchorIndex - offset, anchorIndex + offset]) {
          if (index < 0 || index >= messages.length) continue;
          if (Math.abs(stamp(messages[index].evidence.occurredAt) - stamp(anchor.occurredAt)) <= ADJACENT_WINDOW_MS) {
            selected.add(index);
          }
        }
      }
      groups.push(selected);
    });

    const merged = mergeOverlapping(groups);
    const includedIndexes = new Set<number>();
    for (const group of merged) {
      const selected = [...group].sort((left, right) => left - right).map((index) => messages[index]);
      selected.forEach((message) => includedIndexes.add(messages.indexOf(message)));
      const evidenceIds = selected.map((message) => message.referenceId);
      const modelItems = selected.map(modelItem);
      bundles.push({
        bundleId: bundleId(evidenceIds),
        bundleType: "chat_context",
        evidenceIds,
        sourceTypes: [...new Set(modelItems.map((item) => item.sourceType))],
        completeness: modelItems.every((item) => item.sourceCompleteness === "complete") ? "complete" : "partial",
        items: modelItems,
      });
    }
    messages.forEach((message, index) => {
      if (!includedIndexes.has(index)) {
        ignoredEvidence.push({ evidenceId: message.referenceId, reason: "insufficient_context" });
      }
    });
  }
  return { bundles, ignoredEvidence };
}

export function evidenceBundleItem(item: EvidenceWithReference): EvidenceBundleItem {
  return modelItem(item);
}
