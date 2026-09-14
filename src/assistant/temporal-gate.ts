import { isSourceContainerTitle } from "./historical-report-parser";
import type { EvidenceWithReference } from "./evidence-store";
import { isInAssistantReportingWindow } from "./reporting-window";

export type WorkItemOrigin = "today" | "continuation";

export interface GatedWorkEvidence extends EvidenceWithReference {
  origin: WorkItemOrigin;
  workSummary: string;
  resultHint: string;
  projectSignals: string[];
  confidence: number;
}

export interface TemporalGateResult {
  candidateEvidence: GatedWorkEvidence[];
  backgroundEvidence: EvidenceWithReference[];
}

function clip(value: string, max: number): string {
  const text = String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function concreteTitle(item: EvidenceWithReference): string {
  const evidence = item.evidence;
  const preferred = clip(evidence.analysisTitle ?? "", 160);
  if (preferred && !isSourceContainerTitle(preferred)) return preferred;
  const title = clip(evidence.title, 160);
  if (title && !isSourceContainerTitle(title)) return title;
  const summary = String(evidence.analysisSummary ?? evidence.summary)
    .normalize("NFKC")
    .split(/[。；;\n]/)[0]
    .replace(/^(?:结果|进展|事项结果|工作内容|内容)[①②③④⑤⑥⑦⑧\d\s:：-]*/i, "")
    .trim();
  return summary && !isSourceContainerTitle(summary) ? clip(summary, 160) : "";
}

function confidence(item: EvidenceWithReference): number {
  return item.evidence.evidenceStrength === "strong" ? 0.9 : item.evidence.evidenceStrength === "medium" ? 0.72 : 0.5;
}

/**
 * 候选硬闸门：只有今天的直接证据、或显式标注的前一工作日延续线索可成项。
 * 历史日志旧载荷没有时态标注时一律仅作背景，避免升级后重新生成错误候选。
 */
export function applyTemporalGate(items: EvidenceWithReference[], workDate: string): TemporalGateResult {
  const candidateEvidence: GatedWorkEvidence[] = [];
  const backgroundEvidence: EvidenceWithReference[] = [];
  for (const item of items) {
    const evidence = item.evidence;
    const inWindow = isInAssistantReportingWindow(evidence.occurredAt, workDate);
    const isHistoricalContainer = evidence.sourceType === "dingtalk_report" || evidence.sourceType === "platform_log";
    const temporalRole = evidence.temporalRole ?? (inWindow && !isHistoricalContainer ? "today" : "history");
    const workUse = evidence.workUse ?? (temporalRole === "today" && !isHistoricalContainer ? "direct_work" : "background_only");
    const validToday = temporalRole === "today" && inWindow && workUse === "direct_work";
    const validContinuation = temporalRole === "previous_workday" && workUse === "continuation_hint";
    if (!validToday && !validContinuation) {
      backgroundEvidence.push(item);
      continue;
    }
    const workSummary = concreteTitle(item);
    if (!workSummary) {
      backgroundEvidence.push(item);
      continue;
    }
    candidateEvidence.push({
      ...item,
      origin: validToday ? "today" : "continuation",
      workSummary,
      resultHint: validToday && evidence.resultEligible !== false
        ? clip(evidence.analysisSummary ?? evidence.summary, 260)
        : "",
      projectSignals: [...new Set(evidence.projectSignals.map((signal) => clip(signal, 80)).filter(Boolean))],
      confidence: confidence(item),
    });
  }
  return { candidateEvidence, backgroundEvidence };
}
