import { logStructured } from "../../infra/logger";
import type { EventModelProvider, EventModelRequest, EventModelResponse } from "../events/event-model-provider";
import { parseAndValidateInteractionModelOutput } from "./interaction-output-validator";
import type { InteractionModelOutput } from "./interaction-types";

export class InteractionModelUnavailableError extends Error {
  constructor(readonly code: "model_unavailable" | "model_schema_failed", options?: ErrorOptions) {
    super(code, options);
    this.name = "InteractionModelUnavailableError";
  }
}

export interface ValidatedInteractionModelResponse extends EventModelResponse {
  output: InteractionModelOutput;
  provider: string;
  model: string;
  retryCount: number;
}

export class InteractionModelClient {
  constructor(
    private readonly providers: EventModelProvider[],
    private readonly requireRealProvider = true,
  ) {}

  async analyze(request: EventModelRequest): Promise<ValidatedInteractionModelResponse> {
    const usable = this.providers.filter((provider) => !this.requireRealProvider || provider.kind === "real");
    if (!usable.length) throw new InteractionModelUnavailableError("model_unavailable");
    let lastProviderError: unknown;
    let sawSchemaFailure = false;
    for (const provider of usable) {
      let first: EventModelResponse;
      try {
        first = await provider.analyze(request);
      } catch (error) {
        lastProviderError = error;
        logStructured({
          evt: "assistant_interaction_model_provider_failed",
          provider: provider.providerName,
          model: provider.model,
          promptVersion: request.promptVersion,
        });
        continue;
      }
      try {
        const output = parseAndValidateInteractionModelOutput(first.content);
        logStructured({
          evt: "assistant_interaction_model_call",
          provider: provider.providerName,
          model: provider.model,
          promptVersion: request.promptVersion,
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
          durationMs: first.durationMs,
          retryCount: 0,
        });
        return { ...first, output, provider: provider.providerName, model: provider.model, retryCount: 0 };
      } catch (schemaError) {
        let repaired: EventModelResponse;
        try {
          repaired = await provider.analyze({
            ...request,
            repair: {
              invalidOutput: first.content,
              error: schemaError instanceof Error ? schemaError.message.slice(0, 300) : "schema_error",
            },
          });
        } catch (error) {
          lastProviderError = error;
          continue;
        }
        try {
          const output = parseAndValidateInteractionModelOutput(repaired.content);
          return {
            ...repaired,
            output,
            provider: provider.providerName,
            model: provider.model,
            inputTokens: first.inputTokens + repaired.inputTokens,
            outputTokens: first.outputTokens + repaired.outputTokens,
            durationMs: first.durationMs + repaired.durationMs,
            retryCount: 1,
          };
        } catch (error) {
          sawSchemaFailure = true;
          lastProviderError = error;
          logStructured({
            evt: "assistant_interaction_model_schema_failed",
            provider: provider.providerName,
            model: provider.model,
            promptVersion: request.promptVersion,
          });
          continue;
        }
      }
    }
    throw new InteractionModelUnavailableError(sawSchemaFailure ? "model_schema_failed" : "model_unavailable", {
      cause: lastProviderError,
    });
  }
}
