export interface HistoricalReportField {
  key: string;
  value: string;
}

const CONTINUATION_KEY = /(明日|明天|下一步|后续|后续计划|进行中|未完成|待推进|阻塞|卡点|待办)/;
const INLINE_CONTINUATION = /(?:明日计划|明天计划|下一步(?:计划)?|后续计划|进行中(?:事项)?|未完成(?:事项)?|待推进(?:事项)?|阻塞(?:问题)?|卡点|待办(?:事项)?)[①②③④⑤⑥⑦⑧\d\s、.．:：-]*([^\n]{2,240})/g;

const SOURCE_CONTAINER = /^(?:[^\s]{1,40}的)?(?:总经办日志|工作日报|历史日志|工作日志|钉钉日报|日报|聊天记录|工作会话|群聊记录|单聊记录|会议纪要|知识库(?:更新|动态|文档)?|文档(?:更新|编辑|阅读)?|日历(?:安排|事项)?|会议(?:安排|记录)?|AI\s*听记|待办(?:事项|处理)?)$/i;

function compact(value: string): string {
  return value.normalize("NFKC").replace(/<br\s*\/?\s*>/gi, "\n").replace(/\r/g, "").trim();
}

function cleanHint(value: string): string {
  return compact(value)
    .replace(/^(?:明日计划|明天计划|下一步(?:计划)?|后续计划|进行中(?:事项)?|未完成(?:事项)?|待推进(?:事项)?|阻塞(?:问题)?|卡点|待办(?:事项)?)[①②③④⑤⑥⑦⑧\d\s、.．:：-]*/i, "")
    .replace(/^[①②③④⑤⑥⑦⑧\d\s、.．:：;；-]+/, "")
    .replace(/[；;。\s]+$/, "")
    .trim()
    .slice(0, 180);
}

function splitHints(value: string): string[] {
  const normalized = compact(value)
    .replace(/(?:^|\n)\s*[①②③④⑤⑥⑦⑧\d]+[、.．]\s*/g, "\n")
    .replace(/\s*[；;]\s*(?=[①②③④⑤⑥⑦⑧\d]+[、.．]?)/g, "\n");
  return normalized
    .split(/\n+/)
    .map(cleanHint)
    .filter((item) => item.length >= 2);
}

export function isSourceContainerTitle(value: string): boolean {
  return SOURCE_CONTAINER.test(compact(value));
}

/** 仅提取前一工作日的计划、进行中、阻塞和下一步；已完成正文不会进入候选。 */
export function extractContinuationHints(fields: HistoricalReportField[]): string[] {
  const hints: string[] = [];
  for (const field of fields) {
    const key = compact(field.key);
    const value = compact(field.value);
    if (!value) continue;
    if (CONTINUATION_KEY.test(key)) hints.push(...splitHints(value));
    for (const match of value.matchAll(INLINE_CONTINUATION)) {
      const hint = cleanHint(match[1]);
      if (hint.length >= 2) hints.push(hint);
    }
  }
  return [...new Set(hints)].slice(0, 8);
}

export function reportReferenceSummary(fields: HistoricalReportField[], fallback = ""): string {
  const text = fields
    .map((field) => {
      const key = compact(field.key);
      const value = compact(field.value);
      return value ? `${key ? `${key}：` : ""}${value}` : "";
    })
    .filter(Boolean)
    .join("\n") || compact(fallback);
  return text.slice(0, 800);
}
