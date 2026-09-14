import type { DailyReportMorningSummary, PersonBrief } from "./daily-report-morning-llm";

function clipLine(raw: string, max: number): string {
  const t = String(raw ?? "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** 剥离 markdown 代码围栏（```json ... ```）。 */
export function stripMarkdownCodeFence(raw: string): string {
  const t = String(raw ?? "").trim();
  const fenced = t.match(/^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/);
  if (fenced) return fenced[1].trim();
  return t.replace(/^```(?:json|JSON)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

/** CTO plain text overview：去围栏、去 JSON 包裹、空则 null。 */
export function normalizePlainTextOverview(raw: string): string | null {
  let t = stripMarkdownCodeFence(raw).trim();
  if (!t) return null;

  if (t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t) as { overview?: unknown };
      const nested = String(parsed.overview ?? "").trim();
      if (nested) t = nested;
    } catch {
      // keep raw text
    }
  }

  t = t.replace(/^overview\s*[:：]\s*/i, "").trim();
  if (!t) return null;
  return t;
}

export function extractJsonObjectText(raw: string): string | null {
  const stripped = stripMarkdownCodeFence(raw);
  const match = stripped.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

export function parseProjectViewMorningSummaryJson(raw: string): DailyReportMorningSummary | null {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const overview = String(parsed.overview ?? "").trim();
    if (!overview) return null;
    const personBriefs = Array.isArray(parsed.personBriefs)
      ? parsed.personBriefs
          .map((p) => {
            const o = (p ?? {}) as { name?: string; brief?: string };
            return {
              name: String(o.name ?? "").trim(),
              brief: clipLine(String(o.brief ?? ""), 50),
            };
          })
          .filter((p): p is PersonBrief => Boolean(p.name && p.brief))
          .slice(0, 12)
      : [];
    const closing = clipLine(String(parsed.closing ?? "").trim() || "详见工作台日报汇总。", 120);
    return { overview: clipLine(overview, 200), personBriefs, closing };
  } catch {
    return null;
  }
}

export async function callLlmWithParseRetry<T>(params: {
  callOnce: () => Promise<string>;
  parse: (raw: string) => T | null;
  maxAttempts?: number;
  onAttemptFailed?: (reason: string, attempt: number) => void;
}): Promise<{ value: T | null; attempts: number }> {
  const maxAttempts = Math.max(1, params.maxAttempts ?? 2);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await params.callOnce();
    const parsed = params.parse(raw);
    if (parsed) return { value: parsed, attempts: attempt };
    params.onAttemptFailed?.("parse_error", attempt);
  }
  return { value: null, attempts: maxAttempts };
}
