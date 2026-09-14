import type { EventModelProvider, EventModelRequest, EventModelResponse } from "./event-model-provider";

type FetchLike = typeof fetch;

export interface OpenAiCompatibleEventProviderOptions {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export class OpenAiCompatibleEventProvider implements EventModelProvider {
  readonly kind = "real" as const;
  readonly providerName: string;
  readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenAiCompatibleEventProviderOptions) {
    this.providerName = options.providerName;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyze(input: EventModelRequest): Promise<EventModelResponse> {
    if (!this.options.apiKey) throw new Error("event_provider_api_key_missing");
    const messages = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: JSON.stringify(input.payload) },
      ...(input.repair ? [
        { role: "assistant", content: input.repair.invalidOutput },
        {
          role: "user",
          content: `上一个输出未通过服务端 Schema 校验：${input.repair.error}。请修复并只输出完整、严格的 JSON 对象。`,
        },
      ] : []),
    ];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: input.maxOutputTokens,
          stream: false,
          enable_thinking: false,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { code?: string; message?: string };
      };
      if (!response.ok) throw new Error(`event_provider_http_${response.status}:${payload.error?.code ?? "unknown"}`);
      const content = String(payload.choices?.[0]?.message?.content ?? "").trim();
      if (!content) throw new Error("event_provider_empty_response");
      return {
        content,
        inputTokens: Math.max(0, Number(payload.usage?.prompt_tokens ?? 0)),
        outputTokens: Math.max(0, Number(payload.usage?.completion_tokens ?? 0)),
        finishReason: String(payload.choices?.[0]?.finish_reason ?? ""),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
