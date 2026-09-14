import type { EvidenceBundle, WorkEvent } from "./event-types";
import type { ValidatedEventModelResponse } from "./event-model-provider";
import { EventModelClient } from "./event-model-client";
import type { EventAnalysisContext } from "./event-extraction-service";
import { EVENT_FUSION_SYSTEM_PROMPT } from "./prompts/event-fusion-v1";

export class EventFusionService {
  constructor(private readonly client: EventModelClient) {}

  async fuse(
    context: EventAnalysisContext,
    bundles: EvidenceBundle[],
    priorEvents: WorkEvent[] = [],
  ): Promise<ValidatedEventModelResponse> {
    return await this.client.analyze({
      phase: "fuse",
      systemPrompt: EVENT_FUSION_SYSTEM_PROMPT,
      promptVersion: context.promptVersion,
      maxOutputTokens: context.maxOutputTokens,
      payload: {
        workDate: context.workDate,
        employee: context.employee,
        completeness: context.completeness,
        bundles,
        ...(priorEvents.length ? { priorEvents } : {}),
      },
    });
  }
}
