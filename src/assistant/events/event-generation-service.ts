import type { SessionUser } from "../../auth/types";
import type { EvidenceWithReference } from "../evidence-store";
import { buildEvidenceBundles } from "./evidence-bundle-builder";
import { EventExtractionService, type EventAnalysisContext } from "./event-extraction-service";
import { EventFusionService } from "./event-fusion-service";
import { validateGroundedEvents, type GroundingValidationIssue } from "./event-grounding-validator";
import { EventModelUnavailableError, type ValidatedEventModelResponse } from "./event-model-provider";
import { EventRepository } from "./event-repository";
import type { SourceCompletenessSummary, WorkEvent } from "./event-types";
import { logStructured } from "../../infra/logger";

export interface EventGenerationInput {
  jobId: string;
  user: SessionUser;
  workDate: string;
  evidences: EvidenceWithReference[];
  completeness: SourceCompletenessSummary[];
  expiresAt: string;
  now?: Date;
}

export interface EventGenerationResult {
  events: WorkEvent[];
  analysisMode: "real_model" | "manual";
  runId: string;
  errorCode?: "model_unavailable" | "model_schema_failed";
  inputEvidenceCount: number;
  coveredEvidenceCount: number;
  ignoredEvidenceCount: number;
  validationIssues: GroundingValidationIssue[];
}

export interface EventGenerationOptions {
  promptVersion: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

function estimatedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2);
}

function aggregateResponses(responses: ValidatedEventModelResponse[]) {
  const last = responses.at(-1);
  return {
    provider: last?.provider,
    model: last?.model,
    inputTokens: responses.reduce((sum, response) => sum + response.inputTokens, 0),
    outputTokens: responses.reduce((sum, response) => sum + response.outputTokens, 0),
    durationMs: responses.reduce((sum, response) => sum + response.durationMs, 0),
    retryCount: responses.reduce((sum, response) => sum + response.retryCount, 0),
  };
}

export class EventGenerationService {
  constructor(
    private readonly extraction: EventExtractionService,
    private readonly fusion: EventFusionService,
    private readonly repository: EventRepository,
    private readonly options: EventGenerationOptions,
  ) {}

  async generate(input: EventGenerationInput): Promise<EventGenerationResult> {
    const now = input.now ?? new Date();
    const runId = this.repository.createRun(
      input.jobId,
      input.user.id,
      input.workDate,
      this.options.promptVersion,
      input.expiresAt,
      now,
    );
    const built = buildEvidenceBundles(input.evidences);
    logStructured({
      evt: "assistant_event_bundle_build",
      userId: input.user.id,
      jobId: input.jobId,
      inputEvidenceCount: input.evidences.length,
      includedEvidenceCount: built.includedEvidenceIds.length,
      ignoredEvidenceCount: built.ignoredEvidence.length,
      bundleCount: built.bundles.length,
      partialSourceCount: input.completeness.filter((source) => !source.complete).length,
    });
    const context: EventAnalysisContext = {
      workDate: input.workDate,
      employee: { userId: input.user.id, displayName: input.user.name },
      completeness: input.completeness,
      promptVersion: this.options.promptVersion,
      maxOutputTokens: this.options.maxOutputTokens,
    };
    const responses: ValidatedEventModelResponse[] = [];
    try {
      let finalResponse: ValidatedEventModelResponse;
      if (estimatedTokens(built.bundles) <= this.options.maxInputTokens) {
        finalResponse = await this.fusion.fuse(context, built.bundles);
        responses.push(finalResponse);
      } else {
        const priorEvents: WorkEvent[] = [];
        for (const bundle of built.bundles) {
          const extracted = await this.extraction.extract(context, [bundle]);
          responses.push(extracted);
          priorEvents.push(...extracted.output.events);
        }
        finalResponse = await this.fusion.fuse(context, [], priorEvents);
        responses.push(finalResponse);
      }
      const validation = validateGroundedEvents({
        output: finalResponse.output,
        userId: input.user.id,
        ddUserid: String(input.user.ddUserid ?? ""),
        jobId: input.jobId,
        workDate: input.workDate,
        evidences: input.evidences,
        now,
      });
      this.repository.replaceEvents(
        runId,
        input.jobId,
        input.user.id,
        input.workDate,
        validation.events,
        input.expiresAt,
        now,
      );
      const model = aggregateResponses(responses);
      const partial = input.completeness.some((source) => !source.complete)
        || validation.rejectedEvents > 0
        || validation.issues.length > 0;
      this.repository.finishRun(runId, {
        status: partial ? "partial" : "complete",
        ...model,
        inputEvidenceCount: input.evidences.length,
        coveredEvidenceCount: built.includedEvidenceIds.length,
      }, now);
      logStructured({
        evt: "assistant_event_validation",
        userId: input.user.id,
        jobId: input.jobId,
        eventCount: validation.events.length,
        rejectedEventCount: validation.rejectedEvents,
        validationIssueCount: validation.issues.length,
        averageEvidenceCount: validation.events.length
          ? Math.round(validation.events.reduce((sum, event) => sum + event.evidenceIds.length, 0) * 100 / validation.events.length) / 100
          : 0,
        crossSourceEventCount: validation.events.filter((event) => event.sourceTypes.length > 1).length,
        status: partial ? "partial" : "complete",
      });
      return {
        events: validation.events,
        analysisMode: "real_model",
        runId,
        inputEvidenceCount: input.evidences.length,
        coveredEvidenceCount: built.includedEvidenceIds.length,
        ignoredEvidenceCount: built.ignoredEvidence.length,
        validationIssues: validation.issues,
      };
    } catch (error) {
      const code = error instanceof EventModelUnavailableError ? error.code : "event_generation_failed";
      const model = aggregateResponses(responses);
      this.repository.finishRun(runId, {
        status: "failed",
        ...model,
        inputEvidenceCount: input.evidences.length,
        coveredEvidenceCount: built.includedEvidenceIds.length,
        errorCode: code,
      }, now);
      logStructured({
        evt: "assistant_event_generation_failed",
        userId: input.user.id,
        jobId: input.jobId,
        errorCode: code,
      });
      if (!(error instanceof EventModelUnavailableError)) throw error;
      return {
        events: [],
        analysisMode: "manual",
        runId,
        errorCode: error.code,
        inputEvidenceCount: input.evidences.length,
        coveredEvidenceCount: built.includedEvidenceIds.length,
        ignoredEvidenceCount: built.ignoredEvidence.length,
        validationIssues: [],
      };
    }
  }
}
