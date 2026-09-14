/** OpenAI 兼容 LLM 客户端：主路（通义 DashScope）+ 备路（DeepSeek）自动降级；支持 JSON 输出解析重试。 */
import { CONFIG } from "../infra/config";
import { logStructured } from "../infra/logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CallOpts {
  tier?: "fast" | "strong";
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  json?: boolean;
}

interface Provider {
  baseUrl: string;
  apiKey: string;
  fastModel: string;
  strongModel: string;
}

async function callProvider(
  provider: Provider,
  messages: ChatMessage[],
  opts: CallOpts,
): Promise<string> {
  const model = opts.tier === "strong" ? provider.strongModel : provider.fastModel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? CONFIG.llm.timeoutMs);
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 2000,
        temperature: opts.temperature ?? 0.2,
        stream: false,
        enable_thinking: false,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(`LLM ${model} HTTP ${res.status}: ${data.error?.message ?? ""}`);
    }
    const content = String(data.choices?.[0]?.message?.content ?? "").trim();
    if (!content) throw new Error(`LLM ${model} 返回为空`);
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

export function llmAvailable(): boolean {
  return CONFIG.llm.enabled && Boolean(CONFIG.llm.primary.apiKey || CONFIG.llm.fallback.apiKey);
}

/** 文本补全：主路失败自动切备路；两路都失败抛错（调用方走确定性兜底）。 */
export async function chat(messages: ChatMessage[], opts: CallOpts = {}): Promise<string> {
  if (!CONFIG.llm.enabled) throw new Error("LLM disabled");
  const providers: Provider[] = [];
  if (CONFIG.llm.primary.apiKey) providers.push(CONFIG.llm.primary);
  if (CONFIG.llm.fallback.apiKey) providers.push(CONFIG.llm.fallback);
  if (providers.length === 0) throw new Error("LLM 未配置");
  let lastErr: unknown;
  for (const p of providers) {
    try {
      return await callProvider(p, messages, opts);
    } catch (err) {
      lastErr = err;
      logStructured({ evt: "llm_provider_failed", baseUrl: p.baseUrl, error: String(err) });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function stripCodeFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

export function extractJsonObject(text: string): string {
  const cleaned = stripCodeFence(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1);
  return cleaned;
}

/** JSON 输出：解析失败自动带错误重试一次。 */
export async function chatJson<T>(
  messages: ChatMessage[],
  validate: (obj: unknown) => T,
  opts: CallOpts = {},
): Promise<T> {
  const jsonOpts = { ...opts, json: true };
  const first = await chat(messages, jsonOpts);
  try {
    return validate(JSON.parse(extractJsonObject(first)));
  } catch (err) {
    const retry = await chat(
      [
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content: `上面的输出无法解析为要求的 JSON（${err instanceof Error ? err.message : String(err)}）。请只输出合法 JSON 对象，不要包含任何其他文字或代码块围栏。`,
        },
      ],
      jsonOpts,
    );
    return validate(JSON.parse(extractJsonObject(retry)));
  }
}
