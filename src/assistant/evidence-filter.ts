import type { EvidenceWithReference } from "./evidence-store";

const SHORT_NOISE = /^(收到|好的|好|已阅|知悉|谢谢|感谢|ok|okay|嗯|哦|赞|辛苦了|明白)[！!。.🌀-🫿]*$/iu;
const SYSTEM_NOISE = /(加入了群聊|退出了群聊|撤回了一条消息|系统通知|机器人播报|reaction|点赞了消息)/i;
const ATTACHMENT_ONLY = /^(?:图片|文件|视频|语音|表情|附件)(?:消息)?$/i;

export function sanitizeChatEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/```(?:[a-z0-9_-]+)?|`/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/[ \t]+>+\s*#{2,}\s*/g, "\n")
    .replace(/(?:^|[ \t>])#{2,}\s*/gm, " ")
    .replace(/\[(?:图片|文件|视频|语音|表情|附件)(?:消息)?\]\([^)]*(?:media[_-]?id|download[_-]?code|space[_-]?id)[^)]*\)/gi, " ")
    .replace(/\[([^\]]+)]\((?:https?:\/\/|dingtalk:\/\/)[^)]+\)/gi, "$1")
    .replace(/\((?:https?:\/\/|dingtalk:\/\/)[^)]+\)/gi, " ")
    .replace(/(?:https?:\/\/|dingtalk:\/\/)[^\s)]+/gi, " ")
    .replace(/\b(?:media[_-]?id|download[_-]?code|space[_-]?id)\s*[=:]\s*[a-z0-9_+/=-]{8,}/gi, " ")
    .replace(/unsupported\s+file\s+type/gi, "不支持该文件类型")
    .replace(/(^|[ \t])@[\p{L}\p{N}_-]{1,40}[ \t]*/gmu, "$1")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

export function deterministicEvidenceFilter(items: EvidenceWithReference[]): EvidenceWithReference[] {
  const seen = new Set<string>();
  return items.map((item) => {
    const evidence = item.evidence;
    if (evidence.sourceType !== "chat_group" && evidence.sourceType !== "chat_private") return item;
    return { ...item, evidence: { ...evidence, summary: sanitizeChatEvidenceText(evidence.summary) } };
  }).filter((item) => {
    const evidence = item.evidence;
    const summary = normalized(evidence.summary);
    const title = normalized(evidence.title);
    if (!summary && !title) return false;
    if ((evidence.sourceType === "chat_group" || evidence.sourceType === "chat_private") && !summary) return false;
    if ((evidence.sourceType === "chat_group" || evidence.sourceType === "chat_private") && SHORT_NOISE.test(summary)) {
      return false;
    }
    if ((evidence.sourceType === "chat_group" || evidence.sourceType === "chat_private") && ATTACHMENT_ONLY.test(summary)) {
      return false;
    }
    if (SYSTEM_NOISE.test(summary) || SYSTEM_NOISE.test(title)) return false;
    if (evidence.sourceType === "attendance") return false;
    if (evidence.sourceType === "approval"
      && evidence.workUse !== "task_signal"
      && evidence.workUse !== "direct_work") return false;
    const structuredTask = evidence.sourceType === "todo"
      || evidence.sourceType === "approval"
      || evidence.sourceType === "ding";
    const key = structuredTask
      ? `${evidence.sourceType}:${evidence.externalId}`
      : `${evidence.sourceType}:${title}:${summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
