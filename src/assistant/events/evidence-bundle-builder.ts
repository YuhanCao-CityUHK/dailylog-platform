import { createHash } from "node:crypto";
import type { EvidenceWithReference } from "../evidence-store";
import { sanitizeChatEvidenceText } from "../evidence-filter";
import { buildChatContextBundles, evidenceBundleItem } from "./chat-context-builder";
import type { EvidenceBundle, EvidenceBundleBuildResult, EvidenceBundleItem, IgnoredEvidence } from "./event-types";

const SHORT_NOISE = /^(收到|好的|好|已阅|知悉|谢谢|感谢|ok|okay|嗯|哦|赞|辛苦了|明白)[！!。.]*$/iu;
const MAX_BUNDLE_CHARS = 12_000;

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
}

function bigrams(value: string): Set<string> {
  const text = normalize(value);
  const result = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

function related(left: EvidenceBundle, right: EvidenceBundle): boolean {
  const leftItems = left.items;
  const rightItems = right.items;
  const leftRefs = new Set(leftItems.flatMap((item) => [...item.resourceRefs, ...item.linkedObjectIds]).map(normalize).filter(Boolean));
  if (rightItems.some((item) => [...item.resourceRefs, ...item.linkedObjectIds].some((ref) => leftRefs.has(normalize(ref))))) return true;
  const leftSignals = new Set(leftItems.flatMap((item) => item.projectSignals).map(normalize).filter((value) => value.length >= 2));
  if (rightItems.some((item) => item.projectSignals.some((signal) => leftSignals.has(normalize(signal))))) return true;
  const leftText = leftItems.map((item) => `${item.title} ${item.summary} ${item.projectSignals.join(" ")}`).join(" ");
  const rightText = rightItems.map((item) => `${item.title} ${item.summary} ${item.projectSignals.join(" ")}`).join(" ");
  const leftTokens = bigrams(leftText);
  const rightTokens = bigrams(rightText);
  let overlap = 0;
  for (const token of rightTokens) if (leftTokens.has(token)) overlap += 1;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  if (overlap < 3 || smaller === 0 || overlap / smaller < 0.35) return false;
  const leftTimes = leftItems.map((item) => Date.parse(item.occurredAt)).filter(Number.isFinite);
  const rightTimes = rightItems.map((item) => Date.parse(item.occurredAt)).filter(Number.isFinite);
  if (!leftTimes.length || !rightTimes.length) return true;
  return Math.abs(Math.min(...leftTimes) - Math.min(...rightTimes)) <= 8 * 60 * 60 * 1000;
}

function singleEvidenceBundle(item: EvidenceWithReference): EvidenceBundle {
  const modelItem = evidenceBundleItem(item);
  return {
    bundleId: `single_${item.referenceId}`,
    bundleType: "cross_source",
    evidenceIds: [item.referenceId],
    sourceTypes: [item.evidence.sourceType],
    completeness: modelItem.sourceCompleteness,
    items: [modelItem],
  };
}

function mergeBundles(units: EvidenceBundle[]): EvidenceBundle[] {
  const parent = units.map((_, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]));
  const join = (left: number, right: number) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < units.length; left += 1) {
    for (let right = left + 1; right < units.length; right += 1) {
      if (related(units[left], units[right])) join(left, right);
    }
  }
  const groups = new Map<number, EvidenceBundleItem[]>();
  units.forEach((unit, index) => {
    const group = groups.get(root(index)) ?? [];
    group.push(...unit.items);
    groups.set(root(index), group);
  });
  return [...groups.values()].map((rawItems) => {
    const seen = new Set<string>();
    const items = rawItems.filter((item) => !seen.has(item.evidenceId) && Boolean(seen.add(item.evidenceId)))
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.evidenceId.localeCompare(right.evidenceId));
    const ids = items.map((item) => item.evidenceId);
    return {
      bundleId: `bundle_${createHash("sha256").update(ids.slice().sort().join(":"), "utf8").digest("hex").slice(0, 16)}`,
      bundleType: items.some((item) => item.sourceType === "chat_group" || item.sourceType === "chat_private")
        ? "chat_context" as const
        : "cross_source" as const,
      evidenceIds: ids,
      sourceTypes: [...new Set(items.map((item) => item.sourceType))],
      completeness: items.every((item) => item.sourceCompleteness === "complete") ? "complete" as const : "partial" as const,
      items,
    };
  });
}

function splitOversized(bundle: EvidenceBundle): EvidenceBundle[] {
  const chunks: EvidenceBundleItem[][] = [];
  let current: EvidenceBundleItem[] = [];
  let size = 0;
  for (const item of bundle.items) {
    const itemSize = JSON.stringify(item).length;
    if (current.length && size + itemSize > MAX_BUNDLE_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length) chunks.push(current);
  return chunks.map((items, index) => ({
    ...bundle,
    bundleId: chunks.length === 1 ? bundle.bundleId : `${bundle.bundleId}_${index + 1}`,
    evidenceIds: items.map((item) => item.evidenceId),
    sourceTypes: [...new Set(items.map((item) => item.sourceType))],
    completeness: items.every((item) => item.sourceCompleteness === "complete") ? "complete" : "partial",
    items,
  }));
}

export function buildEvidenceBundles(input: EvidenceWithReference[]): EvidenceBundleBuildResult {
  const ignoredEvidence: IgnoredEvidence[] = [];
  const seen = new Set<string>();
  const retained: EvidenceWithReference[] = [];
  for (const item of input) {
    if (seen.has(item.referenceId)) {
      ignoredEvidence.push({ evidenceId: item.referenceId, reason: "duplicate" });
      continue;
    }
    seen.add(item.referenceId);
    const evidence = item.evidence;
    const chat = evidence.sourceType === "chat_group" || evidence.sourceType === "chat_private";
    const summary = chat ? sanitizeChatEvidenceText(evidence.summary) : evidence.summary.trim();
    if (!summary && !evidence.title.trim()) {
      ignoredEvidence.push({ evidenceId: item.referenceId, reason: "empty" });
      continue;
    }
    if (evidence.relationToSelf === "bot_or_unknown") {
      ignoredEvidence.push({ evidenceId: item.referenceId, reason: "bot_or_unknown" });
      continue;
    }
    if (chat && (SHORT_NOISE.test(summary) || !summary)) {
      ignoredEvidence.push({ evidenceId: item.referenceId, reason: "noise" });
      continue;
    }
    if (evidence.sourceType === "attendance" || evidence.sourceType === "approval" || evidence.sourceType === "ding") {
      ignoredEvidence.push({ evidenceId: item.referenceId, reason: "background_only" });
      continue;
    }
    retained.push({ ...item, evidence: { ...evidence, summary } });
  }

  const chatItems = retained.filter((item) => item.evidence.sourceType === "chat_group" || item.evidence.sourceType === "chat_private");
  const otherItems = retained.filter((item) => item.evidence.sourceType !== "chat_group" && item.evidence.sourceType !== "chat_private");
  const chat = buildChatContextBundles(chatItems);
  ignoredEvidence.push(...chat.ignoredEvidence);
  const anchorItems = otherItems.filter((item) => item.evidence.workUse !== "background_only");
  const backgroundItems = otherItems.filter((item) => item.evidence.workUse === "background_only");
  const units = [...chat.bundles, ...anchorItems.map(singleEvidenceBundle)];
  for (const item of backgroundItems) {
    const unit = singleEvidenceBundle(item);
    if (units.some((anchor) => related(anchor, unit))) units.push(unit);
    else ignoredEvidence.push({ evidenceId: item.referenceId, reason: "background_only" });
  }
  const bundles = mergeBundles(units).flatMap(splitOversized);
  const includedEvidenceIds = [...new Set(bundles.flatMap((bundle) => bundle.evidenceIds))];
  const accounted = new Set([...includedEvidenceIds, ...ignoredEvidence.map((item) => item.evidenceId)]);
  for (const item of input) {
    if (!accounted.has(item.referenceId)) {
      ignoredEvidence.push({ evidenceId: item.referenceId, reason: "insufficient_context" });
    }
  }
  return { bundles, includedEvidenceIds, ignoredEvidence };
}
