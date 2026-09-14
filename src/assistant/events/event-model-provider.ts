import type { EventModelOutput } from "./event-types";

export type EventModelPhase = "extract" | "fuse";

export interface EventModelRequest {
  phase: EventModelPhase;
  systemPrompt: string;
  payload: Record<string, unknown>;
  promptVersion: string;
  maxOutputTokens: number;
  repair?: { invalidOutput: string; error: string };
}

export interface EventModelResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  durationMs: number;
}

export interface EventModelProvider {
  readonly kind: "real" | "fake";
  readonly providerName: string;
  readonly model: string;
  analyze(input: EventModelRequest): Promise<EventModelResponse>;
}

export interface ValidatedEventModelResponse {
  output: EventModelOutput;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  durationMs: number;
  retryCount: number;
}

export class EventModelUnavailableError extends Error {
  constructor(readonly code: "model_unavailable" | "model_schema_failed", options?: ErrorOptions) {
    super(code, options);
    this.name = "EventModelUnavailableError";
  }
}

export function isFixedModelSnapshot(model: string): boolean {
  return /-\d{4}-\d{2}-\d{2}$/.test(model.trim()) && !model.endsWith("-latest");
}
