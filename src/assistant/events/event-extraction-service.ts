import type { EvidenceBundle, SourceCompletenessSummary, WorkEvent } from "./event-types";
import type { ValidatedEventModelResponse } from "./event-model-provider";
import { EventModelClient } from "./event-model-client";
import { EVENT_EXTRACTOR_SYSTEM_PROMPT } from "./prompts/event-fusion-v1";

export interface EventAnalysisContext {
  workDate: string;
  employee: { userId: number; displayName: string };
  completeness: SourceCompletenessSummary[];
  promptVersion: string;
  maxOutputTokens: number;
}

export class EventExtractionService {
  constructor(private readonly client: EventModelClient) {}

  async extract(context: EventAnalysisContext, bundles: EvidenceBundle[]): Promise<ValidatedEventModelResponse> {
    return await this.client.analyze({
      phase: "extract",
      systemPrompt: EVENT_EXTRACTOR_SYSTEM_PROMPT,
      promptVersion: context.promptVersion,
      maxOutputTokens: context.maxOutputTokens,
      payload: {
        workDate: context.workDate,
        employee: context.employee,
        completeness: context.completeness,
        bundles,
      },
    });
  }
}

export interface ExtractedEventBatch {
  events: WorkEvent[];
  response: ValidatedEventModelResponse;
}
