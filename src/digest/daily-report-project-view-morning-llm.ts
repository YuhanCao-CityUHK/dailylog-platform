import { logStructured } from "../infra/logger";
import type { OrgDigest } from "./daily-report-build";
import { filterReportContentsWithBody } from "./daily-report-content-filter";
import { countReportAttachments } from "./daily-report-attachments";
import {
  callLlmWithParseRetry,
  normalizePlainTextOverview,
  parseProjectViewMorningSummaryJson,
  stripMarkdownCodeFence,
} from "./daily-report-llm-parse";
import {
  loadDailyReportMorningLlmConfig,
  type DailyReportMorningLlmConfig,
  type DailyReportMorningSummary,
  type PersonBrief,
} from "./daily-report-morning-llm";

export { loadDailyReportMorningLlmConfig, normalizePlainTextOverview };

export interface ProjectViewMorningLlmPayload {
  viewLabel: string;
  rosterCount: number;
  submittedCount: number;
  people: Array<{
    name: string;
    attachmentCount?: number;
    reports: Array<{ template?: string; fields: Array<{ k: string; v: string }> }>;
  }>;
}

const SKIP_FALLBACK_FIELD_KEYS = /工作模块|成本归属|模块标签|项目名称|模板名称/;
const PREFER_FALLBACK_FIELD_KEYS = /事项|结果|进展|完成|问题|风险|计划|今日|明日/;

function clipLine(raw: string, max: number): string {
  const t = String(raw ?? "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** 压缩 projectView digest 供 LLM 消费；不含 missing/onLeave。 */
export function slimProjectViewDigestForLlm(
  viewLabel: string,
  rosterCount: number,
  orgDigest: OrgDigest,
): ProjectViewMorningLlmPayload {
  const people: ProjectViewMorningLlmPayload["people"] = [];

  for (const emp of orgDigest.submitted) {
    const attCount = emp.reports.reduce((n, r) => n + countReportAttachments(r), 0);
    const reports = emp.reports
      .map((r) => ({
        template: r.templateName || undefined,
        fields: filterReportContentsWithBody(r.contents)
          .slice(0, 12)
          .map((f) => ({
            k: f.key.slice(0, 40),
            v: f.value.slice(0, 200),
          })),
      }))
      .filter((r) => r.fields.length > 0);

    if (reports.length > 0) {
      people.push({
        name: emp.name,
        ...(attCount > 0 ? { attachmentCount: attCount } : {}),
        reports,
      });
    }
  }

  return {
    viewLabel,
    rosterCount,
    submittedCount: people.length,
    people,
  };
}

function pickFallbackContentFromDigest(orgDigest: OrgDigest): string | null {
  const preferred: string[] = [];
  const fallback: string[] = [];

  for (const emp of orgDigest.submitted) {
    for (const report of emp.reports) {
      for (const field of filterReportContentsWithBody(report.contents)) {
        const value = field.value.trim();
        if (!value) continue;
        if (SKIP_FALLBACK_FIELD_KEYS.test(field.key)) continue;
        if (PREFER_FALLBACK_FIELD_KEYS.test(field.key)) {
          preferred.push(value);
        } else {
          fallback.push(value);
        }
      }
    }
  }

  return preferred[0] ?? fallback[0] ?? null;
}

const WORKBENCH_SYSTEM_PROMPT = `你是企业内部项目组早报编辑。根据 JSON 中昨日与指定项目相关的钉钉日报，只输出一个 JSON：
{"overview":"...","personBriefs":[{"name":"...","brief":"..."}],"closing":"..."}

规则：
- overview：2-3 句中文，概括与 viewLabel 相关的整体进展，不超过 180 字
- personBriefs：仅针对 people[] 中有正文的员工，每人一条 brief 不超过 50 字
- closing：1-2 句收束
- submittedCount 为 0 时：overview 与 closing 应自然说明「昨日暂无与该项目相关的日报记录」
- 禁止出现内部术语：命中、filter、roster、成对匹配、模块块
- 禁止在任意字段出现组织标签（如「明思」「微光」）
- 只基于 JSON 事实，禁止编造
- 只输出 JSON，不要 markdown`;

const CTO_ROLLUP_PLAIN_TEXT_PROMPT = `你是企业内部项目组早报编辑。根据 JSON 中「统计名单内员工」昨日与指定项目相关的钉钉日报，只输出一段中文 overview 正文。

规则：
- 2-3 句，概括与 viewLabel 相关的整体项目进展，不超过 180 字
- submittedCount 为 0 时：只输出「暂无相关记录」
- 禁止 JSON、markdown、代码块、列表、标题
- 禁止写日期、禁止写提交人数/统计名单人数
- 禁止出现内部术语：命中、filter、roster、成对匹配
- 禁止组织标签（明思、微光）
- 只基于 JSON 事实，禁止编造
- 只输出 overview 正文本身`;

async function callMorningLlm(
  config: DailyReportMorningLlmConfig,
  systemPrompt: string,
  userContent: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.3,
        max_tokens: config.maxTokens,
        enable_thinking: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return String(data.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

export function fallbackProjectViewMorningSummary(
  viewLabel: string,
  dateLabel: string,
  rosterCount: number,
  orgDigest: OrgDigest,
): DailyReportMorningSummary {
  const meta = slimProjectViewDigestForLlm(viewLabel, rosterCount, orgDigest);
  const personBriefs: PersonBrief[] = meta.people.map((p) => {
    const first = p.reports.flatMap((r) => r.fields).find((f) => f.v.trim())?.v.trim();
    return { name: p.name, brief: clipLine(first ?? "已提交相关日报", 40) };
  });

  if (meta.submittedCount === 0) {
    return {
      overview: `${dateLabel}，昨日暂无与「${viewLabel}」相关的日报记录。`,
      personBriefs: [],
      closing: "可打开工作台查看完整日报汇总。",
    };
  }

  return {
    overview: `${dateLabel}，昨日有 ${meta.submittedCount} 人提交了与「${viewLabel}」相关的日报。`,
    personBriefs: personBriefs.slice(0, 8),
    closing: "整体推进详见个人简述与工作台日报汇总。",
  };
}

/** CTO 合并卡片降级：优先取「事项/结果/进展」类字段，跳过工作模块等标签。 */
export function fallbackCtoRollupOverviewSummary(
  viewLabel: string,
  rosterCount: number,
  orgDigest: OrgDigest,
): DailyReportMorningSummary {
  const meta = slimProjectViewDigestForLlm(viewLabel, rosterCount, orgDigest);
  if (meta.submittedCount === 0) {
    return {
      overview: "暂无相关记录",
      personBriefs: [],
      closing: "",
    };
  }

  const picked = pickFallbackContentFromDigest(orgDigest);
  return {
    overview: clipLine(picked ?? "详见工作台日报汇总", 180),
    personBriefs: [],
    closing: "",
  };
}

export async function summarizeProjectViewMorningOverviewPlainText(
  viewLabel: string,
  dateLabel: string,
  rosterCount: number,
  orgDigest: OrgDigest,
  config: DailyReportMorningLlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const llmPayload = slimProjectViewDigestForLlm(viewLabel, rosterCount, orgDigest);
  if (llmPayload.submittedCount === 0) return "暂无相关记录";

  const userContent = `日期：${dateLabel}。请生成项目组整体进展 overview 正文：\n${JSON.stringify(llmPayload)}`;
  const startedAt = Date.now();

  try {
    const { value: raw, attempts } = await callLlmWithParseRetry({
      maxAttempts: 2,
      callOnce: () =>
        callMorningLlm(config, CTO_ROLLUP_PLAIN_TEXT_PROMPT, userContent, fetchImpl),
      parse: (content) => normalizePlainTextOverview(content),
      onAttemptFailed: (reason, attempt) => {
        logStructured({
          event: "daily_report_cto_rollup_llm_parse_retry",
          reason,
          attempt,
          viewLabel,
        });
      },
    });

    if (!raw) {
      logStructured({
        event: "daily_report_cto_rollup_llm_fallback",
        reason: "parse_error",
        viewLabel,
        attempts,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    logStructured({
      event: "daily_report_cto_rollup_llm_ok",
      model: config.model,
      viewLabel,
      attempts,
      durationMs: Date.now() - startedAt,
    });
    return raw;
  } catch (err) {
    logStructured({
      event: "daily_report_cto_rollup_llm_fallback",
      reason: err instanceof Error && err.name === "AbortError" ? "timeout" : "error",
      error: err instanceof Error ? err.message : String(err),
      viewLabel,
      durationMs: Date.now() - startedAt,
    });
    return null;
  }
}

/** CTO 合并早报：plain text overview，无 JSON parse。 */
export async function summarizeProjectViewMorningForCtoRollup(
  viewLabel: string,
  dateLabel: string,
  rosterCount: number,
  orgDigest: OrgDigest,
  config: DailyReportMorningLlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DailyReportMorningSummary> {
  if (!config.enabled) {
    return fallbackCtoRollupOverviewSummary(viewLabel, rosterCount, orgDigest);
  }

  const overview =
    (await summarizeProjectViewMorningOverviewPlainText(
      viewLabel,
      dateLabel,
      rosterCount,
      orgDigest,
      config,
      fetchImpl,
    )) ??
    fallbackCtoRollupOverviewSummary(viewLabel, rosterCount, orgDigest).overview;

  return { overview, personBriefs: [], closing: "" };
}

export async function summarizeProjectViewMorningWithLlm(
  viewLabel: string,
  dateLabel: string,
  rosterCount: number,
  orgDigest: OrgDigest,
  config: DailyReportMorningLlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DailyReportMorningSummary> {
  if (!config.enabled) {
    return fallbackProjectViewMorningSummary(viewLabel, dateLabel, rosterCount, orgDigest);
  }

  const llmPayload = slimProjectViewDigestForLlm(viewLabel, rosterCount, orgDigest);
  const userContent = `日期：${dateLabel}。请生成项目组早报综述 JSON：\n${JSON.stringify(llmPayload)}`;
  const startedAt = Date.now();

  try {
    const { value: parsed, attempts } = await callLlmWithParseRetry({
      maxAttempts: 2,
      callOnce: () =>
        callMorningLlm(config, WORKBENCH_SYSTEM_PROMPT, userContent, fetchImpl),
      parse: (content) => parseProjectViewMorningSummaryJson(content),
      onAttemptFailed: (reason, attempt) => {
        logStructured({
          event: "daily_report_project_view_digest_llm_parse_retry",
          reason,
          attempt,
          viewLabel,
        });
      },
    });

    if (!parsed) {
      logStructured({
        event: "daily_report_project_view_digest_llm_fallback",
        reason: "parse_error",
        viewLabel,
        attempts,
        durationMs: Date.now() - startedAt,
      });
      return fallbackProjectViewMorningSummary(viewLabel, dateLabel, rosterCount, orgDigest);
    }

    logStructured({
      event: "daily_report_project_view_digest_llm_ok",
      model: config.model,
      personBriefCount: parsed.personBriefs.length,
      attempts,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  } catch (err) {
    logStructured({
      event: "daily_report_project_view_digest_llm_fallback",
      reason: err instanceof Error && err.name === "AbortError" ? "timeout" : "error",
      error: err instanceof Error ? err.message : String(err),
      viewLabel,
      durationMs: Date.now() - startedAt,
    });
    return fallbackProjectViewMorningSummary(viewLabel, dateLabel, rosterCount, orgDigest);
  }
}

// Re-export for tests / debug scripts
export { stripMarkdownCodeFence };
