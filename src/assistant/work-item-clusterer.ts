import { createHash } from "node:crypto";
import type { GatedWorkEvidence, WorkItemOrigin } from "./temporal-gate";
import type { EvidenceWithReference } from "./evidence-store";

const OUTPUT_PATTERN = /(完成|交付|形成|确定|确认|解决|修复|通过|发布|上线|更新|修改|编写|开发|验证|定位|推进|处理|评审结论|业务决策|行动项|责任人|下一步)/i;
const COMMUNICATION_TYPES = new Set(["chat_group", "chat_private", "calendar", "minutes"]);

export interface WorkItemCluster {
  clusterId: string;
  title: string;
  resultHint: string;
  references: GatedWorkEvidence[];
  sourceTypes: string[];
  participantNames: string[];
  projectSignals: string[];
  needsConfirmation: string[];
  rank: number;
  origin: WorkItemOrigin;
  confidence: number;
}

function asGated(item: GatedWorkEvidence | EvidenceWithReference, workDate: string): GatedWorkEvidence {
  if ("workSummary" in item && "origin" in item) return item;
  const strength = item.evidence.evidenceStrength === "strong" ? 0.9 : item.evidence.evidenceStrength === "medium" ? 0.72 : 0.5;
  return {
    ...item,
    origin: item.evidence.occurredAt.includes(workDate) ? "today" : "continuation",
    workSummary: item.evidence.title,
    resultHint: item.evidence.summary,
    projectSignals: item.evidence.projectSignals,
    confidence: strength,
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s，。、“”‘’：:；;！？!?（）()[\]【】_\-—]/g, "");
}

function features(value: string): Set<string> {
  const clean = normalize(value);
  const out = new Set<string>();
  for (const word of value.normalize("NFKC").toLocaleLowerCase("zh-CN").match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g) ?? []) {
    out.add(word);
  }
  for (let index = 0; index + 1 < clean.length; index += 1) out.add(clean.slice(index, index + 2));
  return out;
}

function featureSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

function evidenceText(item: GatedWorkEvidence): string {
  return [item.workSummary, item.resultHint].join(" ");
}

function hasExplicitOutput(item: GatedWorkEvidence): boolean {
  return item.origin === "today" && Boolean(item.resultHint) && OUTPUT_PATTERN.test(`${item.workSummary} ${item.resultHint}`);
}

function isCommunication(item: GatedWorkEvidence): boolean {
  return COMMUNICATION_TYPES.has(item.evidence.sourceType);
}

interface GroupState {
  items: GatedWorkEvidence[];
  text: string;
  textFeatures: Set<string>;
  projectSignals: Set<string>;
}

function createGroup(item: GatedWorkEvidence): GroupState {
  const text = evidenceText(item);
  return {
    items: [item],
    text,
    textFeatures: features(text),
    projectSignals: new Set(item.projectSignals.map(normalize)),
  };
}

function appendToGroup(group: GroupState, item: GatedWorkEvidence): void {
  group.items.push(item);
  group.text = `${group.text} ${evidenceText(item)}`;
  group.textFeatures = features(group.text);
  for (const signal of item.projectSignals) group.projectSignals.add(normalize(signal));
}

function bestGroup(groups: GroupState[], item: GatedWorkEvidence): { group: GroupState; score: number } | null {
  let best: { group: GroupState; score: number } | null = null;
  const itemFeatures = features(evidenceText(item));
  const itemSignals = item.projectSignals.map(normalize);
  for (const group of groups) {
    let score = featureSimilarity(group.textFeatures, itemFeatures);
    if (itemSignals.some((signal) => group.projectSignals.has(signal))) {
      // Project affinity is a boost only when the work text also overlaps. This
      // keeps separate deliverables in one project distinct.
      score = score >= 0.12 ? Math.min(1, score + 0.25) : Math.max(score, 0.18);
    }
    if (!best || score > best.score) best = { group, score };
  }
  return best;
}

function preferredTitle(group: GatedWorkEvidence[]): string {
  const preferred = [...group].sort((a, b) => {
    const aToday = a.origin === "today" ? 0 : 1;
    const bToday = b.origin === "today" ? 0 : 1;
    const aCommunication = isCommunication(a) ? 1 : 0;
    const bCommunication = isCommunication(b) ? 1 : 0;
    const strength = { strong: 3, medium: 2, weak: 1 } as const;
    return aToday - bToday || aCommunication - bCommunication || strength[b.evidence.evidenceStrength] - strength[a.evidence.evidenceStrength];
  })[0];
  return preferred?.workSummary || "待确认工作事项";
}

function resultHint(group: GatedWorkEvidence[]): string {
  const summaries = group
    .filter((item) => item.origin === "today" && hasExplicitOutput(item))
    .map((item) => item.resultHint.trim())
    .filter(Boolean);
  return [...new Set(summaries)].slice(0, 2).join("；").slice(0, 500);
}

function rank(group: GatedWorkEvidence[], _workDate: string): number {
  const strength = { strong: 4, medium: 2, weak: 1 } as const;
  const sources = new Set(group.map((item) => item.evidence.sourceType)).size;
  const today = group.filter((item) => item.origin === "today").length;
  return group.reduce((sum, item) => sum + strength[item.evidence.evidenceStrength], 0) + sources * 2 + today * 2;
}

/** 沟通默认附着到实际任务；只有有明确输出时才允许独立成项。 */
export function clusterWorkItems(rawItems: Array<GatedWorkEvidence | EvidenceWithReference>, workDate: string, limit = 8): WorkItemCluster[] {
  const items = rawItems.map((item) => asGated(item, workDate));
  const groups: GroupState[] = [];
  const deferredCommunication: GatedWorkEvidence[] = [];
  for (const item of items) {
    if (isCommunication(item) && !hasExplicitOutput(item)) {
      deferredCommunication.push(item);
      continue;
    }
    const best = bestGroup(groups, item);
    if (best && best.score >= 0.42) appendToGroup(best.group, item);
    else groups.push(createGroup(item));
  }
  for (const item of deferredCommunication) {
    const best = bestGroup(groups, item);
    if (best && best.score >= 0.22) appendToGroup(best.group, item);
  }

  return groups
    .map(({ items: group }): WorkItemCluster => {
      const referenceIds = [...new Set(group.map((item) => item.referenceId))].sort();
      const hint = resultHint(group);
      return {
        clusterId: createHash("sha256").update(referenceIds.join(":"), "utf8").digest("hex").slice(0, 20),
        title: preferredTitle(group),
        resultHint: hint,
        references: group,
        sourceTypes: [...new Set(group.map((item) => item.evidence.sourceType))],
        participantNames: [...new Set(group.flatMap((item) => [...item.evidence.actorNames, ...item.evidence.participantNames]))],
        projectSignals: [...new Set(group.flatMap((item) => item.projectSignals))],
        needsConfirmation: [...(!hint ? ["result"] : []), "hours"],
        rank: rank(group, workDate),
        origin: group.some((item) => item.origin === "today") ? "today" : "continuation",
        confidence: Math.round(Math.max(...group.map((item) => item.confidence)) * 100) / 100,
      };
    })
    .sort((a, b) => b.rank - a.rank || a.clusterId.localeCompare(b.clusterId))
    .slice(0, Math.max(0, Math.min(8, limit)));
}
