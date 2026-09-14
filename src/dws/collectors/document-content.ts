import type { JsonObject } from "../../assistant/schema";
import { object, pickText, shorten } from "./shared";

export interface DocumentContent {
  nodeId: string;
  title: string;
  markdown: string;
  url?: string;
}

/** Normalize a Doc +fetch response without exposing transport metadata to work-item analysis. */
export function projectDocumentContent(payload: JsonObject): DocumentContent {
  const content = object(payload.content)
    ?? object(object(payload.result)?.content)
    ?? object(object(payload.data)?.content)
    ?? {};
  return {
    nodeId: pickText(content, ["nodeId", "id"]),
    title: pickText(content, ["title", "name"]),
    markdown: pickText(content, ["markdown", "text", "content"]),
    url: pickText(content, ["docUrl", "url"]) || undefined,
  };
}

function cleanMarkdown(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/!\[([^\]]*)]\((?:https?:\/\/|dingtalk:\/\/)[^)]+\)/gi, "$1")
    .replace(/\[([^\]]+)]\((?:https?:\/\/|dingtalk:\/\/)[^)]+\)/gi, "$1")
    .replace(/(?:https?:\/\/|dingtalk:\/\/)[^\s)]+/gi, " ")
    .replace(/```(?:[a-z0-9_-]+)?|`/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Keep a bounded, readable excerpt for fusion. It describes current content and
 * must never be presented as a byte-level diff or as entirely created today.
 */
export function documentAnalysisExcerpt(markdown: string, max = 4_000): string {
  const cleaned = cleanMarkdown(markdown);
  if (!cleaned) return "";
  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = line.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return shorten(unique.join("\n"), max);
}

export function documentAnalysisSummary(action: string, title: string, markdown: string): string {
  const excerpt = documentAnalysisExcerpt(markdown);
  return shorten([
    `${action}《${title || "未命名文档"}》。`,
    excerpt ? `以下为当前正文内容摘录，仅用于识别工作主题，不代表全部内容均为今日新增：\n${excerpt}` : "",
  ].filter(Boolean).join("\n"), 4_500);
}
