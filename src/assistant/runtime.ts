import { CONFIG } from "../infra/config";
import { logStructured } from "../infra/logger";
import { configuredContextKey } from "./crypto";
import { getContextDb } from "./context-db";
import { ContextJobStore } from "./context-jobs";
import { ContextOrchestrator } from "./context-orchestrator";
import { EvidenceStore } from "./evidence-store";
import { RolloutCandidateService } from "./candidate-service";
import { getDb } from "../infra/db";
import { ConversationEngine } from "./conversation-engine";
import { AssistantSubmitService } from "./submit-service";
import { WorkStatusService } from "./work-status-service";
import { HybridWorkItemAnalysisService } from "./work-item-analysis-service";
import { LlmConversationPlannerService } from "./conversation-planner-service";
import { DailyAssistantV2Harness } from "../assistant-v2/harness";
import { OpenAiCompatibleAssistantProvider } from "../assistant-v2/provider-adapter";
import { assistantEventFusionEnabledForUser, assistantWorkDiscoveryEnabledForUser } from "./features";
import { OpenAiCompatibleEventProvider } from "./events/openai-compatible-event-provider";
import { EventModelClient } from "./events/event-model-client";
import { EventExtractionService } from "./events/event-extraction-service";
import { EventFusionService } from "./events/event-fusion-service";
import { EventRepository } from "./events/event-repository";
import { EventGenerationService } from "./events/event-generation-service";
import type { SessionUser } from "../auth/types";
import { InteractionModelClient } from "./interactions/interaction-model-client";
import { InteractionRepository } from "./interactions/interaction-repository";
import { InteractionGenerationService } from "./interactions/interaction-generation-service";
import { TASK_DISCOVERY_PROMPT_VERSION } from "./interactions/prompts/task-discovery-v1";


const SOURCE_LABELS: Record<string, string> = {
  chat: "聊天", document: "文档", wiki: "知识库", calendar: "日历", minutes: "AI 听记", todo: "待办",
  dingtalk_report: "历史钉钉日志", attendance_approval: "考勤审批", work_interactions: "OA 与 DING", platform_log: "我的日志",
};

/** 把上下文任务的逐源状态压成模型和开场可用的三组标签。 */
function summarizeSources(job: ReturnType<ContextOrchestrator["get"]>): { read: string[]; unavailable: string[]; reading: string[] } | null {
  if (!job || !job.sources.length) return null;
  const read: string[] = [];
  const unavailable: string[] = [];
  const reading: string[] = [];
  for (const source of job.sources) {
    const sourceName = SOURCE_LABELS[source.source] ?? source.source;
    const label = `${sourceName} ${source.itemCount} 条`;
    if (source.status === "running") reading.push(label);
    else if (source.status === "error") unavailable.push(label);
    else if (source.status === "partial") read.push(`${label}（部分）`);
    else read.push(label);
  }
  return { read, unavailable, reading };
}

let runtime:
  | {
      jobStore: ContextJobStore;
      evidenceStore: EvidenceStore;
      orchestrator: ContextOrchestrator;
      candidateService: RolloutCandidateService;
      conversationEngine: ConversationEngine;
      submitService: AssistantSubmitService;
      workStatusService: WorkStatusService;
      eventRepository?: EventRepository;
      interactionRepository?: InteractionRepository;
      agentV2Harness?: DailyAssistantV2Harness;
    }
  | undefined;

export function getAssistantRuntime() {
  if (runtime) return runtime;
  const db = getContextDb();
  const contextKey = configuredContextKey();
  const evidenceStore = new EvidenceStore(db, contextKey);
  const jobStore = new ContextJobStore(db);
  const platformDb = getDb();
  const workStatusService = new WorkStatusService(platformDb);
  const orchestrator = new ContextOrchestrator({
    jobStore,
    evidenceStore,
    recordWorkStatus: (userId, workDate, evidences) => workStatusService.recordEvidence(userId, workDate, evidences),
    workDiscoveryEnabledForUser: (user) => assistantWorkDiscoveryEnabledForUser(
      user.ddUserid,
      CONFIG.assistant.workDiscoveryEnabled,
      CONFIG.assistant.workDiscoveryPilotUserids,
    ),
  });
  const eventRepository = (CONFIG.assistant.eventFusionEnabled || CONFIG.assistant.workDiscoveryEnabled)
    ? new EventRepository(db, contextKey)
    : undefined;
  const interactionRepository = CONFIG.assistant.workDiscoveryEnabled
    ? new InteractionRepository(db, contextKey)
    : undefined;
  const eventPipeline = eventRepository
    ? (() => {
        const providers = [
          new OpenAiCompatibleEventProvider({
            providerName: "primary",
            baseUrl: CONFIG.llm.primary.baseUrl,
            apiKey: CONFIG.llm.primary.apiKey,
            model: CONFIG.assistant.eventPrimaryModel,
            timeoutMs: CONFIG.assistant.eventModelTimeoutMs,
          }),
          new OpenAiCompatibleEventProvider({
            providerName: "backup",
            baseUrl: CONFIG.llm.primary.baseUrl,
            apiKey: CONFIG.llm.primary.apiKey,
            model: CONFIG.assistant.eventBackupModel,
            timeoutMs: CONFIG.assistant.eventModelTimeoutMs,
          }),
        ];
        const client = new EventModelClient(providers);
        return {
          generationService: new EventGenerationService(
            new EventExtractionService(client),
            new EventFusionService(client),
            eventRepository,
            {
              promptVersion: CONFIG.assistant.eventPromptVersion,
              maxInputTokens: CONFIG.assistant.eventMaxInputTokens,
              maxOutputTokens: CONFIG.assistant.eventMaxOutputTokens,
            },
          ),
          jobStore,
          enabledForUser: (user: SessionUser) =>
            assistantEventFusionEnabledForUser(
              user.ddUserid,
              CONFIG.assistant.eventFusionEnabled,
              CONFIG.assistant.eventFusionPilotUserids,
            ),
          workDiscoveryEnabledForUser: (user: SessionUser) =>
            assistantWorkDiscoveryEnabledForUser(
              user.ddUserid,
              CONFIG.assistant.workDiscoveryEnabled,
              CONFIG.assistant.workDiscoveryPilotUserids,
            ),
          interactionGenerationService: interactionRepository
            ? new InteractionGenerationService(
                new InteractionModelClient(providers),
                interactionRepository,
                {
                  promptVersion: TASK_DISCOVERY_PROMPT_VERSION,
                  maxInputTokens: CONFIG.assistant.eventMaxInputTokens,
                  maxOutputTokens: CONFIG.assistant.eventMaxOutputTokens,
                  maxCandidates: CONFIG.assistant.workDiscoveryMaxCandidates,
                },
              )
            : undefined,
          maxDiscoveryCandidates: CONFIG.assistant.workDiscoveryMaxCandidates,
        };
      })()
    : undefined;
  const agentV2Harness = CONFIG.assistant.agentV2Enabled
    ? new DailyAssistantV2Harness(
        platformDb,
        {
          primary: new OpenAiCompatibleAssistantProvider({
            baseUrl: CONFIG.llm.primary.baseUrl,
            apiKey: CONFIG.llm.primary.apiKey,
            model: CONFIG.assistant.primaryModel,
            timeoutMs: CONFIG.assistant.modelTimeoutMs,
          }),
          backup: new OpenAiCompatibleAssistantProvider({
            baseUrl: CONFIG.llm.primary.baseUrl,
            apiKey: CONFIG.llm.primary.apiKey,
            model: CONFIG.assistant.backupModel,
            timeoutMs: CONFIG.assistant.modelTimeoutMs,
          }),
        },
        {
          timeoutMs: CONFIG.assistant.modelTimeoutMs,
          sourceStatus: (user, workDate) => summarizeSources(orchestrator.get(user.id, workDate)),
        },
      )
    : undefined;
  runtime = {
    jobStore,
    evidenceStore,
    orchestrator,
    candidateService: new RolloutCandidateService(evidenceStore, platformDb, new HybridWorkItemAnalysisService(), eventPipeline),
    conversationEngine: new ConversationEngine(
      platformDb,
      new LlmConversationPlannerService(),
      CONFIG.assistant.referenceTtlHours,
    ),
    submitService: new AssistantSubmitService(platformDb),
    workStatusService,
    eventRepository,
    interactionRepository,
    agentV2Harness,
  };
  return runtime;
}

export function startAssistantContextMaintenance(): void {
  if (!CONFIG.assistant.enabled) return;
  try {
    const { evidenceStore, conversationEngine } = getAssistantRuntime();
    const initial = evidenceStore.cleanupExpired();
    const initialTaskSignals = conversationEngine.cleanupExpiredTaskSignals();
    logStructured({ evt: "assistant_context_cleanup", ...initial, taskSignals: initialTaskSignals });
    const timer = setInterval(() => {
      try {
        const result = evidenceStore.cleanupExpired();
        const taskSignals = conversationEngine.cleanupExpiredTaskSignals();
        logStructured({ evt: "assistant_context_cleanup", ...result, taskSignals });
      } catch (error) {
        logStructured({ evt: "assistant_context_cleanup_failed", error: String(error) });
      }
    }, 15 * 60 * 1000);
    timer.unref();
  } catch (error) {
    logStructured({ evt: "assistant_context_disabled", error: String(error) });
  }
}
