import { AssistantV2Error } from "./types";

export interface ProviderToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ProviderMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ProviderToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ProviderResponse {
  content: string;
  toolCalls: ProviderToolCall[];
  finishReason: string;
  usage: { prompt: number; completion: number; cached: number };
}

export interface ProviderCallInput {
  messages: ProviderMessage[];
  tools: readonly unknown[];
  toolChoice?: "required" | "auto";
  timeoutMs?: number;
}

export interface AssistantModelProvider {
  readonly model: string;
  call(input: ProviderCallInput): Promise<ProviderResponse>;
}

export interface OpenAiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export function assertSnapshotModel(model: string): void {
  const value = model.trim();
  if (!value || value.endsWith("-latest")) throw new AssistantV2Error("invalid_model_snapshot", "生产模型必须是具体快照，不能使用空值或 -latest");
  if (["qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.7-flash", "qwen-plus", "deepseek-chat"].includes(value)) {
    throw new AssistantV2Error("invalid_model_snapshot", `生产模型 ${value} 是浮动别名，必须配置具体日期快照`);
  }
}

export class OpenAiCompatibleAssistantProvider implements AssistantModelProvider {
  readonly model: string;

  constructor(private readonly config: OpenAiProviderConfig) {
    assertSnapshotModel(config.model);
    if (!config.apiKey.trim()) throw new AssistantV2Error("provider_not_configured", `模型 ${config.model} 缺少 API Key`);
    this.model = config.model;
  }

  async call(input: ProviderCallInput): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? this.config.timeoutMs ?? 60_000);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          tools: input.tools,
          tool_choice: input.toolChoice ?? "required",
          parallel_tool_calls: true,
          enable_thinking: false,
          temperature: 0,
          max_tokens: 1_200,
          stream: false,
        }),
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => ({}))) as {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string | null; tool_calls?: ProviderToolCall[]; reasoning_content?: string | null };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        error?: { message?: string; code?: string };
      };
      if (!response.ok) {
        throw new AssistantV2Error(
          "provider_http_error",
          `${this.model} HTTP ${response.status}: ${data.error?.message ?? data.error?.code ?? "unknown error"}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      const choice = data.choices?.[0];
      if (!choice?.message) throw new AssistantV2Error("provider_empty_response", `${this.model} 返回为空`, true);
      const usage = data.usage;
      return {
        content: String(choice.message.content ?? ""),
        toolCalls: Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [],
        finishReason: String(choice.finish_reason ?? ""),
        usage: {
          prompt: Number(usage?.prompt_tokens ?? 0),
          completion: Number(usage?.completion_tokens ?? 0),
          cached: Number(usage?.prompt_tokens_details?.cached_tokens ?? 0),
        },
      };
    } catch (error) {
      if (error instanceof AssistantV2Error) throw error;
      if ((error as { name?: string }).name === "AbortError") {
        throw new AssistantV2Error("provider_timeout", `${this.model} 调用超时`, true);
      }
      throw new AssistantV2Error("provider_error", `${this.model} 调用失败：${String(error)}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function toolResultMessage(toolCallId: string, value: unknown): ProviderMessage {
  return { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(value) };
}
