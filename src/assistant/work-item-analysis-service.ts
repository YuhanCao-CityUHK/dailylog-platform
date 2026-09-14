import { createHash } from "node:crypto";
import { chatJson, llmAvailable } from "../llm/client";
import { logStructured } from "../infra/logger";
import { isSourceContainerTitle } from "./historical-report-parser";
import { clusterWorkItems, type WorkItemCluster } from "./work-item-clusterer";
import type { GatedWorkEvidence } from "./temporal-gate";
import { WORK_ITEM_ANALYSIS_SYSTEM_PROMPT } from "./prompts/work-item-analysis-prompt";

export type WorkItemAnalysisMode = "model" | "deterministic" | "real_model" | "model_unavailable";

export interface WorkItemAnalysisInput {
  workDate: string;
  evidences: GatedWorkEvidence[];
  limit?: number;
}

export interface WorkItemAnalysisResult {
  items: WorkItemCluster[];
  mode: WorkItemAnalysisMode;
}

export interface WorkItemAnalysisService {
  analyze(input: WorkItemAnalysisInput): Promise<WorkItemAnalysisResult>;
}

interface ModelWorkItem {
  workSummary: string;
  resultHint: string;
  origin: "today" | "continuation";
  referenceIds: string[];
  projectSignals: string[];
  needsConfirmation: string[];
  confidence: number;
}

interface ModelWorkItemOutput {
  items: ModelWorkItem[];
}

export interface WorkItemModel {
  analyze(input: WorkItemAnalysisInput): Promise<unknown>;
}

function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const normalized = value.normalize("NFKC").trim();
  if (!allowEmpty && !normalized) throw new Error(`${field} 不能为空`);
  if (normalized.length > max) throw new Error(`${field} 过长`);
  return normalized;
}

function stringList(value: unknown, field: string, maxItems: number, maxText = 120): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  if (value.length > maxItems) throw new Error(`${field} 数量过多`);
  return [...new Set(value.map((item) => text(item, field, maxText)).filter(Boolean))];
}

export function validateModelWorkItemOutput(value: unknown): ModelWorkItemOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型输出必须是对象");
  const rawItems = (value as Record<string, unknown>).items;
  if (!Array.isArray(rawItems) || rawItems.length > 8) throw new Error("items 必须是最多 8 项的数组");
  return {
    items: rawItems.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`items[${index}] 必须是对象`);
      const item = raw as Record<string, unknown>;
      const origin = item.origin === "today" || item.origin === "continuation" ? item.origin : null;
      if (!origin) throw new Error(`items[${index}].origin 无效`);
      const confidence = Number(item.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`items[${index}].confidence 无效`);
      const needsConfirmation = stringList(item.needsConfirmation, `items[${index}].needsConfirmation`, 4, 30);
      if (needsConfirmation.some((need) => !["result", "hours", "project"].includes(need))) {
        throw new Error(`items[${index}].needsConfirmation 无效`);
      }
      return {
        workSummary: text(item.workSummary, `items[${index}].workSummary`, 160),
        resultHint: text(item.resultHint, `items[${index}].resultHint`, 260, true),
        origin,
        referenceIds: stringList(item.referenceIds, `items[${index}].referenceIds`, 120, 100).slice(0, 20),
        projectSignals: stringList(item.projectSignals, `items[${index}].projectSignals`, 20, 80),
        needsConfirmation,
        confidence,
      };
    }),
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
}

function hasGrounding(summary: string, references: GatedWorkEvidence[]): boolean {
  const wanted = normalize(summary);
  const source = normalize(references.flatMap((item) => [item.workSummary, ...item.projectSignals]).join(" "));
  if (wanted.length < 2 || source.length < 2) return false;
  for (let index = 0; index + 1 < wanted.length; index += 1) {
    if (source.includes(wanted.slice(index, index + 2))) return true;
  }
  return false;
}

function derivedResultHint(references: GatedWorkEvidence[]): string {
  return [...new Set(references.filter((item) => item.origin === "today").map((item) => item.resultHint).filter(Boolean))]
    .slice(0, 2)
    .join("；")
    .slice(0, 260);
}

function modelClusters(output: ModelWorkItemOutput, input: WorkItemAnalysisInput): WorkItemCluster[] {
  const allowed = new Map(input.evidences.map((item) => [item.referenceId, item]));
  const clusters: WorkItemCluster[] = [];
  for (const modelItem of output.items) {
    const references = [...new Set(modelItem.referenceIds)]
      .map((id) => allowed.get(id))
      .filter((item): item is GatedWorkEvidence => Boolean(item));
    if (references.length === 0 || isSourceContainerTitle(modelItem.workSummary) || !hasGrounding(modelItem.workSummary, references)) continue;
    const referenceIds = references.map((item) => item.referenceId).sort();
    const origin = references.some((item) => item.origin === "today") ? "today" as const : "continuation" as const;
    const resultHint = origin === "today" ? derivedResultHint(references) : "";
    const sourceTypes = [...new Set(references.map((item) => item.evidence.sourceType))];
    const evidenceSignals = [...new Set(references.flatMap((item) => item.projectSignals))];
    const requestedSignals = new Set(modelItem.projectSignals.map(normalize));
    const projectSignals = evidenceSignals.filter((signal) => requestedSignals.has(normalize(signal)) || modelItem.projectSignals.length === 0);
    const needsConfirmation = [...new Set([
      ...modelItem.needsConfirmation,
      ...(!resultHint ? ["result"] : []),
      "hours",
    ])];
    clusters.push({
      clusterId: createHash("sha256").update(referenceIds.join(":"), "utf8").digest("hex").slice(0, 20),
      title: modelItem.workSummary,
      resultHint,
      references,
      sourceTypes,
      participantNames: [...new Set(references.flatMap((item) => [...item.evidence.actorNames, ...item.evidence.participantNames]))],
      projectSignals,
      needsConfirmation,
      rank: Math.round(modelItem.confidence * 100) + sourceTypes.length * 5 + (origin === "today" ? 10 : 0),
      origin,
      confidence: Math.round(modelItem.confidence * 100) / 100,
    });
  }
  return clusters.sort((a, b) => b.rank - a.rank || a.clusterId.localeCompare(b.clusterId)).slice(0, input.limit ?? 8);
}

export class DeterministicWorkItemAnalysisService implements WorkItemAnalysisService {
  async analyze(input: WorkItemAnalysisInput): Promise<WorkItemAnalysisResult> {
    const items = clusterWorkItems(input.evidences, input.workDate, input.limit ?? 8).filter((item) => (
      !isSourceContainerTitle(item.title) && !/(?:media[_-]?id\s*=|download[_-]?code\s*=|https?:\/\/|^\s*#{1,6}\s|unsupported\s+file\s+type)/i.test(
        `${item.title}\n${item.resultHint}`,
      )
    ));
    return { items, mode: "deterministic" };
  }
}

export class LlmWorkItemModel implements WorkItemModel {
  async analyze(input: WorkItemAnalysisInput): Promise<ModelWorkItemOutput> {
    const payload = input.evidences.map((item) => ({
      id: item.referenceId,
      origin: item.origin,
      sourceType: item.evidence.sourceType,
      workSummary: item.workSummary,
      resultHint: item.origin === "today" ? item.resultHint : "",
      projectSignals: item.projectSignals,
      confidence: item.confidence,
    }));
    return await chatJson(
      [
        { role: "system", content: WORK_ITEM_ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ workDate: input.workDate, evidences: payload }) },
      ],
      validateModelWorkItemOutput,
      { tier: "strong", temperature: 0.1, maxTokens: 3200 },
    );
  }
}

export class HybridWorkItemAnalysisService implements WorkItemAnalysisService {
  private readonly fallback = new DeterministicWorkItemAnalysisService();

  constructor(private readonly model: WorkItemModel | null = llmAvailable() ? new LlmWorkItemModel() : null) {}

  async analyze(input: WorkItemAnalysisInput): Promise<WorkItemAnalysisResult> {
    if (input.evidences.length === 0) return await this.fallback.analyze(input);
    if (!this.model) return await this.fallback.analyze(input);
    try {
      const output = validateModelWorkItemOutput(await this.model.analyze(input));
      const items = modelClusters(output, input);
      if (items.length > 0) return { items, mode: "model" };
      logStructured({ evt: "assistant_work_item_analysis_fallback", reason: "no_valid_items" });
    } catch (error) {
      logStructured({ evt: "assistant_work_item_analysis_fallback", reason: "model_or_schema_error", error: String(error) });
    }
    return await this.fallback.analyze(input);
  }
}
