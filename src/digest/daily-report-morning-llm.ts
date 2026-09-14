import { logStructured } from "../infra/logger";
import type { OrgDigest } from "./daily-report-build";
import { filterReportContentsWithBody } from "./daily-report-content-filter";
import { countReportAttachments } from "./daily-report-attachments";
import {
  callLlmWithParseRetry,
  extractJsonObjectText,
  stripMarkdownCodeFence,
} from "./daily-report-llm-parse";

export interface DailyReportMorningLlmConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  baseUrl: string;
  apiKey: string;
}

export interface PersonBrief {
  name: string;
  brief: string;
}

export interface DailyReportMorningSummary {
  overview: string;
  personBriefs: PersonBrief[];
  closing: string;
}

export interface MorningDigestLlmPayload {
  people: Array<{
    name: string;
    attachmentCount?: number;
    reports: Array<{ template?: string; fields: Array<{ k: string; v: string }> }>;
  }>;
  missing: string[];
  onLeave: string[];
  emptyAfterFilter: string[];
  attachmentOnly: string[];
}

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (raw === "") return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envInt(name: string, defaultValue: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

export function loadDailyReportMorningLlmConfig(): DailyReportMorningLlmConfig | undefined {
  const apiKey = env("DASHSCOPE_API_KEY") || env("QWEN_API_KEY");
  if (!apiKey) return undefined;
  return {
    enabled: envFlag("DAILY_REPORT_MORNING_LLM_ENABLED", true),
    model: env("DAILY_REPORT_MORNING_LLM_MODEL") || "qwen3.6-flash",
    timeoutMs: envInt("DAILY_REPORT_MORNING_LLM_TIMEOUT_MS", 12000),
    maxTokens: envInt("DAILY_REPORT_MORNING_LLM_MAX_TOKENS", 2000),
    baseUrl: env("QWEN_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey,
  };
}

/** 压缩 orgDigests 供 LLM 消费；区分真正未交 vs 已交但过滤后无正文。 */
export function slimOrgDigestsForLlm(orgDigests: OrgDigest[]): MorningDigestLlmPayload {
  const people: MorningDigestLlmPayload["people"] = [];
  const missing: string[] = [];
  const onLeave: string[] = [];
  const emptyAfterFilter: string[] = [];
  const attachmentOnly: string[] = [];

  for (const org of orgDigests) {
    for (const emp of org.submitted) {
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
      } else if (attCount > 0) {
        attachmentOnly.push(emp.name);
      } else {
        emptyAfterFilter.push(emp.name);
      }
    }
    for (const m of org.missing) missing.push(m.name);
    for (const m of org.onLeave ?? []) onLeave.push(m.name);
  }

  return { people, missing, onLeave, emptyAfterFilter, attachmentOnly };
}

const SYSTEM_PROMPT = `你是企业内部早报编辑。根据 JSON 中员工的昨日钉钉日报，只输出一个 JSON：
{"overview":"...","personBriefs":[{"name":"...","brief":"..."}],"closing":"..."}

规则：
- overview：2-3 句中文，概括整体进展，不超过 180 字
- personBriefs：仅针对 people[] 中有正文的员工，每人一条 brief 不超过 50 字；只写姓名，禁止组织/公司名
- closing：1-2 句收束
- closing 中「未交/尚未提交」**只能**引用 missing[] 中的姓名；missing[] 为空时禁止写任何人未提交
- onLeave[]：全天请假（≥8h 或 1 天）员工；closing 可写「请假：姓名…」，**禁止**写这些人未提交
- emptyAfterFilter[] / attachmentOnly[]：表示已交钉钉日报但项目过滤后无匹配模块或仅有附件；可写「部分日报无匹配项目模块或含附件，详见工作台日报汇总」，**禁止**写这些人未提交
- 禁止在任意字段出现「明思」「微光」等组织标签
- 只基于 JSON 事实，禁止编造
- 只输出 JSON，不要 markdown`;

function clipLine(raw: string, max: number): string {
  const t = String(raw ?? "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** 当 missing 为空时，剥离 LLM 误判的「未提交」表述。 */
export function sanitizeMorningClosing(
  closing: string,
  missingNames: string[],
  opts?: { emptyAfterFilterNames?: string[]; attachmentOnlyNames?: string[] },
): string {
  const trimmed = String(closing ?? "").trim() || "请继续保持日报节奏。";
  if (missingNames.length > 0) return clipLine(trimmed, 120);

  if (!/(尚未提交|未交|未提交)/.test(trimmed)) return clipLine(trimmed, 120);

  const emptyCount =
    (opts?.emptyAfterFilterNames?.length ?? 0) + (opts?.attachmentOnlyNames?.length ?? 0);
  if (emptyCount > 0) {
    return "部分日报无匹配项目模块或含附件，详见工作台日报汇总。";
  }
  return "整体推进正常，详见工作台日报汇总。";
}

function mapLegacySummary(parsed: Record<string, unknown>): DailyReportMorningSummary | null {
  const headline = String(parsed.headline ?? "").trim();
  if (!headline) return null;
  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights.map((h) => clipLine(String(h ?? ""), 50)).filter(Boolean)
    : [];
  const attention = String(parsed.attention ?? "").trim();
  const personBriefs: PersonBrief[] = highlights.map((h) => {
    const sep = h.indexOf("：");
    if (sep > 0) {
      return { name: h.slice(0, sep).replace(/^[^·]+·/, ""), brief: h.slice(sep + 1) };
    }
    return { name: "要点", brief: h };
  });
  return {
    overview: headline,
    personBriefs,
    closing: attention || "请继续保持日报节奏。",
  };
}

function parseMorningJson(
  raw: string,
  meta: MorningDigestLlmPayload,
): DailyReportMorningSummary | null {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const overview = String(parsed.overview ?? "").trim();
    if (overview) {
      const personBriefs = Array.isArray(parsed.personBriefs)
        ? parsed.personBriefs
            .map((p) => {
              const o = (p ?? {}) as { name?: string; brief?: string };
              return {
                name: String(o.name ?? "").trim(),
                brief: clipLine(String(o.brief ?? ""), 50),
              };
            })
            .filter((p) => p.name && p.brief)
            .slice(0, 12)
        : [];
      const closingRaw = String(parsed.closing ?? "").trim() || "请继续保持日报节奏。";
      const closing = sanitizeMorningClosing(closingRaw, meta.missing, {
        emptyAfterFilterNames: meta.emptyAfterFilter,
        attachmentOnlyNames: meta.attachmentOnly,
      });
      return { overview: clipLine(overview, 200), personBriefs, closing: clipLine(closing, 120) };
    }
    return mapLegacySummary(parsed);
  } catch {
    return null;
  }
}

export function fallbackMorningSummary(
  orgDigests: OrgDigest[],
  dateLabel: string,
): DailyReportMorningSummary {
  const meta = slimOrgDigestsForLlm(orgDigests);
  let submitted = 0;
  for (const org of orgDigests) submitted += org.submitted.length;

  const personBriefs: PersonBrief[] = meta.people.map((p) => {
    const first = p.reports.flatMap((r) => r.fields).find((f) => f.v.trim())?.v.trim();
    return { name: p.name, brief: clipLine(first ?? "已提交日报", 40) };
  });

  const overview = `${dateLabel} 共 ${submitted} 人已交日报${meta.missing.length ? `，${meta.missing.length} 人未交` : ""}${meta.onLeave.length ? `，${meta.onLeave.length} 人请假` : ""}。`;
  const closingParts: string[] = [];
  if (meta.missing.length) closingParts.push(`未提交：${meta.missing.join("、")}`);
  if (meta.onLeave.length) closingParts.push(`请假：${meta.onLeave.join("、")}`);
  let closing = closingParts.length ? `${closingParts.join("；")}。` : "整体推进正常，请继续保持。";
  if (meta.missing.length === 0 && (meta.emptyAfterFilter.length > 0 || meta.attachmentOnly.length > 0)) {
    closing = "部分日报无匹配项目模块或含附件，详见工作台日报汇总。";
  }

  return {
    overview,
    personBriefs: personBriefs.slice(0, 8),
    closing,
  };
}

export async function summarizeMorningReportsWithLlm(
  orgDigests: OrgDigest[],
  dateLabel: string,
  config: DailyReportMorningLlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DailyReportMorningSummary> {
  if (!config.enabled) return fallbackMorningSummary(orgDigests, dateLabel);

  const llmPayload = slimOrgDigestsForLlm(orgDigests);
  const userContent = `日期：${dateLabel}。请生成早报综述 JSON：\n${JSON.stringify(llmPayload)}`;
  const startedAt = Date.now();

  try {
    const { value: parsed, attempts } = await callLlmWithParseRetry({
      maxAttempts: 2,
      callOnce: async () => {
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
                { role: "system", content: SYSTEM_PROMPT },
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
      },
      parse: (content) => parseMorningJson(stripMarkdownCodeFence(content), llmPayload),
      onAttemptFailed: (reason, attempt) => {
        logStructured({
          event: "daily_report_morning_llm_parse_retry",
          reason,
          attempt,
        });
      },
    });

    if (!parsed) {
      logStructured({
        event: "daily_report_morning_llm_fallback",
        reason: "parse_error",
        attempts,
        durationMs: Date.now() - startedAt,
      });
      return fallbackMorningSummary(orgDigests, dateLabel);
    }

    logStructured({
      event: "daily_report_morning_llm_ok",
      model: config.model,
      personBriefCount: parsed.personBriefs.length,
      attempts,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  } catch (err) {
    if (String(err).includes("http_")) {
      const status = Number(String(err).replace("http_", ""));
      logStructured({
        event: "daily_report_morning_llm_fallback",
        reason: "http_error",
        status,
        durationMs: Date.now() - startedAt,
      });
      return fallbackMorningSummary(orgDigests, dateLabel);
    }
    logStructured({
      event: "daily_report_morning_llm_fallback",
      reason: err instanceof Error && err.name === "AbortError" ? "timeout" : "error",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    return fallbackMorningSummary(orgDigests, dateLabel);
  }
}
