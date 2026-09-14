import { logStructured } from "../../infra/logger";
import {
  EventModelUnavailableError,
  type EventModelProvider,
  type EventModelRequest,
  type ValidatedEventModelResponse,
} from "./event-model-provider";
import { parseAndValidateEventModelOutput } from "./event-output-validator";

export class EventModelClient {
  constructor(
    private readonly providers: EventModelProvider[],
    private readonly requireRealProvider = true,
  ) {}

  async analyze(request: EventModelRequest): Promise<ValidatedEventModelResponse> {
    const usable = this.providers.filter((provider) => !this.requireRealProvider || provider.kind === "real");
    if (!usable.length) throw new EventModelUnavailableError("model_unavailable");
    let lastProviderError: unknown;
    for (const provider of usable) {
      let first;
      try {
        first = await provider.analyze(request);
      } catch (error) {
        lastProviderError = error;
        logStructured({
          evt: "assistant_event_model_provider_failed",
          provider: provider.providerName,
          model: provider.model,
          promptVersion: request.promptVersion,
          phase: request.phase,
        });
        continue;
      }
      try {
        const output = parseAndValidateEventModelOutput(first.content);
        logStructured({
          evt: "assistant_event_model_call",
          provider: provider.providerName,
          model: provider.model,
          promptVersion: request.promptVersion,
          phase: request.phase,
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
          durationMs: first.durationMs,
          finishReason: first.finishReason,
          retryCount: 0,
        });
        return { output, provider: provider.providerName, model: provider.model, ...first, retryCount: 0 };
      } catch (schemaError) {
        let repaired;
        try {
          repaired = await provider.analyze({
            ...request,
            repair: {
              invalidOutput: first.content,
              error: schemaError instanceof Error ? schemaError.message.slice(0, 300) : "schema_error",
            },
          });
        } catch (error) {
          throw new EventModelUnavailableError("model_unavailable", { cause: error });
        }
        try {
          const output = parseAndValidateEventModelOutput(repaired.content);
          logStructured({
            evt: "assistant_event_model_call",
            provider: provider.providerName,
            model: provider.model,
            promptVersion: request.promptVersion,
            phase: request.phase,
            inputTokens: first.inputTokens + repaired.inputTokens,
            outputTokens: first.outputTokens + repaired.outputTokens,
            durationMs: first.durationMs + repaired.durationMs,
            finishReason: repaired.finishReason,
            retryCount: 1,
          });
          return {
            output,
            provider: provider.providerName,
            model: provider.model,
            inputTokens: first.inputTokens + repaired.inputTokens,
            outputTokens: first.outputTokens + repaired.outputTokens,
            durationMs: first.durationMs + repaired.durationMs,
            finishReason: repaired.finishReason,
            retryCount: 1,
          };
        } catch (error) {
          throw new EventModelUnavailableError("model_schema_failed", { cause: error });
        }
      }
    }
    throw new EventModelUnavailableError("model_unavailable", { cause: lastProviderError });
  }
}
