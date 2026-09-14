import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { deterministicEvidenceFilter } from "./evidence-filter";
import { applyEvidenceEligibility } from "./evidence-eligibility";
import type { EvidenceStore } from "./evidence-store";
import type { EvidenceWithReference } from "./evidence-store";
import type { ContextJobStore, ContextJobView } from "./context-jobs";
import { matchProject, type ProjectMatchCandidate } from "./project-matcher";
import { applyTemporalGate, type WorkItemOrigin } from "./temporal-gate";
import {
  DeterministicWorkItemAnalysisService,
  type WorkItemAnalysisMode,
  type WorkItemAnalysisService,
} from "./work-item-analysis-service";
import type { WorkItemCluster } from "./work-item-clusterer";
import type { EventGenerationService } from "./events/event-generation-service";
import type { WorkEvent, WorkEventStatus } from "./events/event-types";
import type { InteractionGenerationService } from "./interactions/interaction-generation-service";
import type { InteractionCandidate, InteractionDiscoveryCoverage } from "./interactions/interaction-types";
import { logStructured } from "../infra/logger";

export interface DailyAssistantCandidate {
  candidateId: string;
  title: string;
  workSummary: string;
  resultHint: string;
  referenceIds: string[];
  sourceTypes: string[];
  needsConfirmation: string[];
  scopeType: "project" | "department_daily" | "unconfirmed";
  selectedProjectId?: number;
  selectedProjectName?: string;
  projectCandidates: ProjectMatchCandidate[];
  groupKey: string;
  groupLabel: string;
  origin: WorkItemOrigin;
  confidence: number;
  sourceCompleteness: "complete" | "partial";
  missingFacts: string[];
  workStatus?: Exclude<WorkEventStatus, "uncertain">;
  blockerText?: string;
  nextAction?: string;
  candidateKind?: "work_event" | "task_signal";
  direction?: InteractionCandidate["direction"];
  priority?: InteractionCandidate["priority"];
  latestAt?: string;
}

export interface CandidateBuildResult {
  candidates: DailyAssistantCandidate[];
  analysisMode: WorkItemAnalysisMode;
  discoveryCoverage?: InteractionDiscoveryCoverage;
}

export type CandidatePreparation =
  | { ready: false; analysisRunning: true }
  | { ready: true; analysisRunning: false; result: CandidateBuildResult };

export interface CandidateEventPipeline {
  generationService: EventGenerationService;
  jobStore: ContextJobStore;
}

export interface CandidateRolloutPipeline extends CandidateEventPipeline {
  enabledForUser: (user: SessionUser) => boolean;
  interactionGenerationService?: InteractionGenerationService;
  workDiscoveryEnabledForUser?: (user: SessionUser) => boolean;
  maxDiscoveryCandidates?: number;
}

interface CandidateBuildEntry {
  state: "pending" | "ready" | "failed";
  promise: Promise<CandidateBuildResult>;
  result?: CandidateBuildResult;
  error?: unknown;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
}

function withBackgroundProjectSignals(
  cluster: WorkItemCluster,
  background: ReturnType<typeof applyTemporalGate>["backgroundEvidence"],
): WorkItemCluster {
  const text = normalize(`${cluster.title} ${cluster.resultHint}`);
  const signals = [...cluster.projectSignals];
  for (const item of background) {
    for (const signal of item.evidence.projectSignals) {
      const normalizedSignal = normalize(signal);
      if (normalizedSignal.length >= 2 && text.includes(normalizedSignal)) signals.push(signal);
    }
  }
  return { ...cluster, projectSignals: [...new Set(signals)] };
}

function collectorSource(sourceType: string): string {
  return sourceType === "chat_private" || sourceType === "chat_group" ? "chat" : sourceType;
}

function eventCompleteness(event: WorkEvent, evidence: EvidenceWithReference[], job: ContextJobView): "complete" | "partial" {
  const selected = new Set(event.evidenceIds);
  if (evidence.some((item) => selected.has(item.referenceId) && item.evidence.sourceCompleteness === "partial")) return "partial";
  const usedSources = new Set(event.sourceTypes.map(collectorSource));
  return job.sources.some((source) => usedSources.has(source.source) && !source.complete) ? "partial" : "complete";
}

function interactionCompleteness(
  interaction: InteractionCandidate,
  evidence: EvidenceWithReference[],
  job: ContextJobView,
): "complete" | "partial" {
  const selected = new Set(interaction.evidenceIds);
  if (evidence.some((item) => selected.has(item.referenceId) && item.evidence.sourceCompleteness === "partial")) return "partial";
  const usedSources = new Set(interaction.sourceTypes.map(collectorSource));
  return job.sources.some((source) => usedSources.has(source.source) && !source.complete) ? "partial" : "complete";
}

function candidateGroup(
  origin: WorkItemOrigin,
  project: ReturnType<typeof matchProject>,
): Pick<DailyAssistantCandidate, "groupKey" | "groupLabel"> {
  const recommended = project.candidates[0];
  if (origin === "continuation") return { groupKey: "continuation", groupLabel: "昨日延续待确认" };
  if (project.scopeType === "project") {
    return { groupKey: `project:${project.selectedProjectId}`, groupLabel: project.selectedProjectName ?? "项目" };
  }
  if (project.scopeType === "department_daily") {
    return { groupKey: "department_daily", groupLabel: "部门日常（系统暂未匹配，可修改）" };
  }
  return {
    groupKey: "unconfirmed",
    groupLabel: recommended ? `待确认项目：${recommended.projectName}` : "待确认项目",
  };
}

function interactionAlreadyRepresented(
  interaction: InteractionCandidate,
  events: DailyAssistantCandidate[],
): boolean {
  const interactionTitle = normalize(interaction.title);
  if (!interactionTitle) return false;
  return events.some((event) => {
    const eventTitle = normalize(event.title);
    const sameTask = eventTitle === interactionTitle
      || (eventTitle.length >= 6 && interactionTitle.includes(eventTitle))
      || (interactionTitle.length >= 6 && eventTitle.includes(interactionTitle));
    if (!sameTask) return false;
    const eventEvidence = new Set(event.referenceIds);
    return interaction.evidenceIds.every((id) => eventEvidence.has(id));
  });
}

export class RolloutCandidateService {
  private readonly cache = new Map<string, CandidateBuildEntry>();

  constructor(
    private readonly evidenceStore: EvidenceStore,
    private readonly db: DatabaseSync,
    private readonly analysisService: WorkItemAnalysisService = new DeterministicWorkItemAnalysisService(),
    private readonly eventPipeline?: CandidateRolloutPipeline,
  ) {}

  usesRolloutAnalysis(user: SessionUser): boolean {
    return Boolean(this.eventPipeline && (
      this.eventPipeline.enabledForUser(user)
      || this.eventPipeline.workDiscoveryEnabledForUser?.(user)
    ));
  }

  private getOrStart(user: SessionUser, jobId: string, workDate: string, now: Date): CandidateBuildEntry {
    const key = `${user.id}:${jobId}:${workDate}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const retainFailedPreparation = this.usesRolloutAnalysis(user);

    // Defer execution by one microtask so the cache entry exists before any
    // asynchronous work can re-enter this service for the same job.
    const promise = Promise.resolve().then(async () => await this.buildUncached(user, jobId, workDate, now));
    const entry: CandidateBuildEntry = { state: "pending", promise };
    this.cache.set(key, entry);
    // Track both outcomes immediately. The rejection handler prevents a
    // fire-and-poll caller from creating an unhandled rejection; build() still
    // observes the original rejected promise when explicitly awaited.
    void promise.then(
      (result) => {
        entry.state = "ready";
        entry.result = result;
      },
      (error: unknown) => {
        entry.state = "failed";
        entry.error = error;
        if (!retainFailedPreparation && this.cache.get(key) === entry) this.cache.delete(key);
      },
    );
    return entry;
  }

  prepare(user: SessionUser, jobId: string, workDate: string, now = new Date()): CandidatePreparation {
    const entry = this.getOrStart(user, jobId, workDate, now);
    if (entry.state === "ready") {
      return { ready: true, analysisRunning: false, result: entry.result! };
    }
    if (entry.state === "failed") throw entry.error;
    return { ready: false, analysisRunning: true };
  }

  async build(user: SessionUser, jobId: string, workDate: string, now = new Date()): Promise<CandidateBuildResult> {
    return await this.getOrStart(user, jobId, workDate, now).promise;
  }

  private async buildUncached(user: SessionUser, jobId: string, workDate: string, now: Date): Promise<CandidateBuildResult> {
    if (this.usesRolloutAnalysis(user)) {
      return await this.buildFromEvents(user, jobId, workDate, now);
    }
    const evidence = deterministicEvidenceFilter(this.evidenceStore.listEvidenceForJob(jobId, user.id, now));
    const eligible = applyEvidenceEligibility(evidence, user);
    const gated = applyTemporalGate(eligible.candidateEvidence, workDate);
    gated.backgroundEvidence.push(...eligible.backgroundEvidence);
    const analysis = await this.analysisService.analyze({ workDate, evidences: gated.candidateEvidence, limit: 8 });
    const candidates = analysis.items.map((rawCluster): DailyAssistantCandidate => {
      const cluster = withBackgroundProjectSignals(rawCluster, gated.backgroundEvidence);
      const project = matchProject(user, cluster, workDate, this.db);
      const needsConfirmation = [...cluster.needsConfirmation];
      if (project.scopeType !== "project") needsConfirmation.push("project");
      const group = candidateGroup(cluster.origin, project);
      return {
        candidateId: cluster.clusterId,
        title: cluster.title,
        workSummary: cluster.title,
        resultHint: cluster.resultHint,
        referenceIds: [...new Set(cluster.references.map((item) => item.referenceId))],
        sourceTypes: cluster.sourceTypes,
        needsConfirmation,
        scopeType: project.scopeType,
        selectedProjectId: project.selectedProjectId,
        selectedProjectName: project.selectedProjectName,
        projectCandidates: project.candidates,
        ...group,
        origin: cluster.origin,
        confidence: cluster.confidence,
        sourceCompleteness: cluster.references.some((item) => item.evidence.sourceCompleteness === "partial") ? "partial" : "complete",
        missingFacts: [...new Set(needsConfirmation)],
      };
    });
    return { candidates, analysisMode: analysis.mode };
  }

  private async buildFromEvents(user: SessionUser, jobId: string, workDate: string, now: Date): Promise<CandidateBuildResult> {
    const pipeline = this.eventPipeline!;
    const job = pipeline.jobStore.get(jobId, user.id);
    if (!job || job.workDate !== workDate || job.expiresAt <= now.toISOString()) throw new Error("assistant_context_job_not_found");
    const filtered = deterministicEvidenceFilter(this.evidenceStore.listEvidenceForJob(jobId, user.id, now));
    const eligible = applyEvidenceEligibility(filtered, user);
    const evidence = [...eligible.candidateEvidence, ...eligible.backgroundEvidence];
    const completeness = job.sources.map((source) => ({
      source: source.source,
      complete: source.complete,
      hasMore: source.hasMore,
      stopReason: source.stopReason,
      failures: source.failures,
      pagesFetched: source.pagesFetched,
      itemCount: source.itemCount,
    }));
    const baseInput = {
      jobId,
      user,
      workDate,
      evidences: evidence,
      completeness,
      expiresAt: job.expiresAt,
      now,
    };
    const eventEnabled = pipeline.enabledForUser(user);
    const discoveryEnabled = Boolean(
      pipeline.interactionGenerationService
      && pipeline.workDiscoveryEnabledForUser?.(user),
    );
    const [generated, discovered] = await Promise.all([
      eventEnabled
        ? pipeline.generationService.generate(baseInput).catch((error: unknown) => {
            logStructured({
              evt: "assistant_event_generation_isolated_failure",
              userId: user.id,
              jobId,
              errorCode: error instanceof Error ? error.name : "unknown",
            });
            return { events: [], analysisMode: "manual" as const };
          })
        : Promise.resolve({ events: [], analysisMode: "manual" as const }),
      discoveryEnabled
        ? pipeline.interactionGenerationService!.generate(baseInput).catch((error: unknown) => {
            logStructured({
              evt: "assistant_interaction_discovery_isolated_failure",
              userId: user.id,
              jobId,
              errorCode: error instanceof Error ? error.name : "unknown",
            });
            return {
              candidates: [],
              analysisMode: "manual" as const,
              scannedReferences: evidence.length,
              signalEvidence: 0,
              interactionCandidates: 0,
              ignoredEvidence: evidence.length,
            };
          })
        : Promise.resolve({
            candidates: [],
            analysisMode: "manual" as const,
            scannedReferences: evidence.length,
            signalEvidence: 0,
            interactionCandidates: 0,
            ignoredEvidence: evidence.length,
          }),
    ]);
    const eventCandidates = generated.events.slice(0, 8).map((event): DailyAssistantCandidate => {
      const project = matchProject(user, {
        title: `${event.title} ${event.object}`.trim(),
        resultHint: event.result,
        projectSignals: event.projectSignals,
        participantNames: event.participantNames,
        sourceTypes: event.sourceTypes,
      }, workDate, this.db);
      const completeness = eventCompleteness(event, evidence, job);
      const needsConfirmation = [...new Set([
        ...event.missingFacts,
        "hours",
        ...(completeness === "partial" ? ["source_completeness"] : []),
        ...(project.scopeType !== "project" ? ["project"] : []),
      ])];
      return {
        candidateId: event.eventKey,
        title: event.title,
        workSummary: event.title,
        resultHint: event.origin === "continuation" ? "" : event.result,
        referenceIds: event.evidenceIds,
        sourceTypes: event.sourceTypes,
        needsConfirmation,
        scopeType: project.scopeType,
        selectedProjectId: project.selectedProjectId,
        selectedProjectName: project.selectedProjectName,
        projectCandidates: project.candidates,
        ...candidateGroup(event.origin, project),
        origin: event.origin,
        confidence: event.confidence,
        sourceCompleteness: completeness,
        missingFacts: [...new Set(event.missingFacts)],
        workStatus: event.status === "uncertain" ? "in_progress" : event.status,
        blockerText: event.blockers.join("；"),
        nextAction: event.nextActions.join("；"),
        candidateKind: "work_event",
      };
    });
    const maxDiscoveryCandidates = Math.max(8, Math.min(100, pipeline.maxDiscoveryCandidates ?? 50));
    const taskCandidates = discovered.candidates
      .filter((interaction) => !interactionAlreadyRepresented(interaction, eventCandidates))
      .slice(0, maxDiscoveryCandidates)
      .map((interaction): DailyAssistantCandidate => {
        const project = matchProject(user, {
          title: interaction.title,
          resultHint: "",
          projectSignals: interaction.projectSignals,
          participantNames: interaction.participantNames,
          sourceTypes: interaction.sourceTypes,
        }, workDate, this.db);
        const completenessValue = interactionCompleteness(interaction, evidence, job);
        const needsConfirmation = [...new Set([
          "task_signal",
          ...interaction.missingFacts,
          "today",
          "result",
          "status",
          "hours",
          ...(completenessValue === "partial" ? ["source_completeness"] : []),
          ...(project.scopeType !== "project" ? ["project"] : []),
        ])];
        return {
          candidateId: interaction.candidateKey,
          title: interaction.title,
          // Do not copy a chat-derived summary/progress into the long-lived platform DB.
          // Only the minimal grounded task title is projected; encrypted detail remains in Context DB.
          workSummary: interaction.title,
          resultHint: "",
          referenceIds: interaction.evidenceIds,
          sourceTypes: interaction.sourceTypes,
          needsConfirmation,
          scopeType: project.scopeType,
          selectedProjectId: project.selectedProjectId,
          selectedProjectName: project.selectedProjectName,
          projectCandidates: project.candidates,
          ...candidateGroup("today", project),
          origin: "today",
          confidence: interaction.confidence,
          sourceCompleteness: completenessValue,
          missingFacts: needsConfirmation,
          workStatus: "in_progress",
          nextAction: "",
          candidateKind: "task_signal",
          direction: interaction.direction,
          priority: interaction.priority,
          latestAt: interaction.latestAt,
        };
      });
    const degraded = (eventEnabled && generated.analysisMode !== "real_model")
      || (discoveryEnabled && discovered.analysisMode !== "real_model");
    const analysisMode = degraded
      ? "model_unavailable" as const
      : "real_model" as const;
    return {
      candidates: [...eventCandidates, ...taskCandidates],
      analysisMode,
      discoveryCoverage: discoveryEnabled ? {
        scannedReferences: discovered.scannedReferences,
        signalEvidence: discovered.signalEvidence,
        interactionCandidates: taskCandidates.length,
        ignoredEvidence: discovered.ignoredEvidence,
      } : undefined,
    };
  }
}

/** 功能开关关闭时保留的旧候选服务；不得用于 WorkEvent 灰度用户。 */
export class LegacyCandidateService {
  private readonly delegate: RolloutCandidateService;

  constructor(
    evidenceStore: EvidenceStore,
    db: DatabaseSync,
    analysisService: WorkItemAnalysisService = new DeterministicWorkItemAnalysisService(),
  ) {
    this.delegate = new RolloutCandidateService(evidenceStore, db, analysisService);
  }

  build(user: SessionUser, jobId: string, workDate: string, now = new Date()): Promise<CandidateBuildResult> {
    return this.delegate.build(user, jobId, workDate, now);
  }
}

/** 新候选服务只消费 EventGenerationService 返回的已校验 WorkEvent。 */
export class CandidateService {
  private readonly delegate: RolloutCandidateService;

  constructor(evidenceStore: EvidenceStore, db: DatabaseSync, pipeline: CandidateEventPipeline) {
    this.delegate = new RolloutCandidateService(evidenceStore, db, new DeterministicWorkItemAnalysisService(), {
      ...pipeline,
      enabledForUser: () => true,
    });
  }

  build(user: SessionUser, jobId: string, workDate: string, now = new Date()): Promise<CandidateBuildResult> {
    return this.delegate.build(user, jobId, workDate, now);
  }
}
