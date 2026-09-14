import * as crypto from "crypto";

import type { DailyReportWebhookConfig } from "./daily-report-config";

/**
 * 钉钉自定义群机器人 Webhook 发送（加签方式）。
 *
 * 加签: sign = urlEncode(Base64(HMAC-SHA256(timestamp + "\n" + secret)))，UTF-8。
 * 请求: POST https://oapi.dingtalk.com/robot/send?access_token=X&timestamp=T&sign=S
 *       body { msgtype: "markdown", markdown: { title, text } }
 * 限频: 每机器人每分钟最多 20 条。
 */

export interface GroupRobotSendResult {
  ok: boolean;
  errcode?: number;
  errmsg?: string;
}

/** 计算加签 sign（导出供测试）。 */
export function computeWebhookSign(secret: string, timestamp: number): string {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac("sha256", secret).update(stringToSign, "utf8").digest("base64");
  return encodeURIComponent(hmac);
}

/** 构造最终 webhook 请求 URL（导出供测试）。 */
export function buildWebhookUrl(
  webhook: DailyReportWebhookConfig,
  timestamp: number,
): string {
  const base = `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(
    webhook.accessToken,
  )}`;
  if (!webhook.secret) return base;
  const sign = computeWebhookSign(webhook.secret, timestamp);
  return `${base}&timestamp=${timestamp}&sign=${sign}`;
}

export async function sendGroupRobotMarkdown(
  webhook: DailyReportWebhookConfig,
  message: { title: string; text: string },
  opts?: { fetchImpl?: typeof fetch; now?: Date },
): Promise<GroupRobotSendResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timestamp = (opts?.now ?? new Date()).getTime();
  if (!webhook.accessToken) {
    return { ok: false, errmsg: "webhook.accessToken missing" };
  }
  const url = buildWebhookUrl(webhook, timestamp);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { title: message.title, text: message.text },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
  const ok = res.ok && (data.errcode === undefined || data.errcode === 0);
  return { ok, errcode: data.errcode, errmsg: data.errmsg };
}
