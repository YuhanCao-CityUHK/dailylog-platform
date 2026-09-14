import type { SessionUser } from "../auth/types";
import { CONFIG } from "../infra/config";
import { Semaphore } from "../infra/semaphore";
import { recentWorkdays } from "../infra/workcal";
import { inspectDwsConnection, parseDwsJson, runDwsForUser, type DwsConnectionStatus } from "../dws/client";
import {
  attendanceApprovalCollector,
  calendarCollector,
  chatCollector,
  dingtalkReportCollector,
  documentCollector,
  minutesCollector,
  todoCollector,
  workInteractionCollector,
  wikiCollector,
} from "../dws/collectors/index";
import type { CollectorResult, ContextCollector } from "./schema";
import { createPlatformLogCollector } from "./collectors/platform-log-collector";
import { ContextJobStore, type ContextJobView } from "./context-jobs";
import { EvidenceStore } from "./evidence-store";
import { shouldPersistAsReference } from "./evidence-eligibility";
import { logStructured } from "../infra/logger";
import { assistantWorkDiscoveryEnabledForUser } from "./features";
import { isInAssistantReportingWindow } from "./reporting-window";

const DWS_SOURCES = new Set([
  "chat",
  "document",
  "wiki",
  "calendar",
  "minutes",
  "todo",
  "dingtalk_report",
  "attendance_approval",
  "work_interactions",
]);

function deduplicateEvidences(result: CollectorResult): CollectorResult {
  const seen = new Set<string>();
  return {
    ...result,
    evidences: result.evidences.filter((evidence) => {
      const key = JSON.stringify([
        evidence.sourceType,
        evidence.externalId,
        evidence.title,
        evidence.summary,
        evidence.occurredAt,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

export interface ContextOrchestratorOptions {
  jobStore: ContextJobStore;
  evidenceStore: EvidenceStore;
  collectors?: ContextCollector[];
  ttlHours?: number;
  jobConcurrency?: number;
  connectionInspector?: (user: SessionUser) => Promise<DwsConnectionStatus>;
  dwsJsonRunner?: (platformUserId: number, args: string[], options?: { timeoutMs?: number; maxBufferBytes?: number; signal?: AbortSignal }) => Promise<Record<string, unknown>>;
  recordWorkStatus?: (userId: number, workDate: string, evidences: import("./schema").CollectedEvidence[]) => void;
  workDiscoveryEnabledForUser?: (user: SessionUser) => boolean;
}

export class ContextOrchestrator {
  private readonly collectors: ContextCollector[];
  private readonly ttlHours: number;
  private readonly queue: Semaphore;
  private readonly scheduled = new Map<string, Promise<void>>();
  private readonly inspectConnection: (user: SessionUser) => Promise<DwsConnectionStatus>;
  private readonly runJson: NonNullable<ContextOrchestratorOptions["dwsJsonRunner"]>;

  constructor(private readonly options: ContextOrchestratorOptions) {
    this.collectors = options.collectors ?? [
      chatCollector,
      documentCollector,
      wikiCollector,
      calendarCollector,
      minutesCollector,
      todoCollector,
      dingtalkReportCollector,
      attendanceApprovalCollector,
      workInteractionCollector,
      createPlatformLogCollector(),
    ];
    this.ttlHours = options.ttlHours ?? CONFIG.assistant.referenceTtlHours;
    this.queue = new Semaphore(options.jobConcurrency ?? CONFIG.assistant.globalConcurrency);
    this.inspectConnection = options.connectionInspector ?? ((user) =>
      inspectDwsConnection({
        platformUserId: user.id,
        corpId: CONFIG.dingtalk.corpId,
        ddUserid: String(user.ddUserid ?? ""),
      }));
    this.runJson = options.dwsJsonRunner ?? ((platformUserId, args, runOptions) =>
      runDwsForUser(platformUserId, args, runOptions).then(parseDwsJson));
  }

  start(user: SessionUser, workDate: string, refresh = false, now = new Date()): ContextJobView {
    let result = this.options.jobStore.createOrReuse(user.id, workDate, this.ttlHours, refresh, now);
    // 进程重启后数据库可能仍为 running；没有本进程任务时重新采集，避免永久卡住。
    if (result.job.status === "running" && !this.scheduled.has(result.job.id)) {
      this.options.jobStore.finish(result.job.id, "failed", "manual", "interrupted");
      result = this.options.jobStore.createOrReuse(user.id, workDate, this.ttlHours, true, now);
    }
    if (result.shouldRun && !this.scheduled.has(result.job.id)) {
      const task = this.queue
        .run(async () => await this.runJob(result.job.id, user, workDate))
        .finally(() => this.scheduled.delete(result.job.id));
      this.scheduled.set(result.job.id, task);
    }
    return result.job;
  }

  get(userId: number, workDate: string, now = new Date()): ContextJobView | null {
    return this.options.jobStore.getActive(userId, workDate, now);
  }

  references(jobId: string, userId: number, now = new Date()) {
    return this.options.evidenceStore.listForJob(jobId, userId, now);
  }

  reference(referenceId: string, userId: number, now = new Date()) {
    return this.options.evidenceStore.get(referenceId, userId, now);
  }

  async waitForIdle(jobId: string): Promise<void> {
    await this.scheduled.get(jobId);
  }

  private async runJob(jobId: string, user: SessionUser, workDate: string): Promise<void> {
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + this.ttlHours * 3600 * 1000).toISOString();
    const workDiscoveryEnabled = this.options.workDiscoveryEnabledForUser?.(user)
      ?? assistantWorkDiscoveryEnabledForUser(
        user.ddUserid,
        CONFIG.assistant.workDiscoveryEnabled,
        CONFIG.assistant.workDiscoveryPilotUserids,
      );
    const activeCollectors = this.collectors.filter((collector) => (
      collector.source !== "work_interactions" || workDiscoveryEnabled
    ));
    this.options.jobStore.markRunning(jobId, startedAt);
    try {
      const connection = await this.inspectConnection(user);
      if (connection.state === "identity_mismatch") {
        for (const collector of activeCollectors) {
          this.options.jobStore.markSourceRunning(jobId, user.id, workDate, collector.source, expiresAt);
          this.options.jobStore.markSourceResult(jobId, {
            source: collector.source,
            status: "error",
            evidences: [],
            errorCode: "identity_mismatch",
            failureStage: "connection_identity",
            durationMs: 0,
          });
        }
        this.options.jobStore.finish(jobId, "manual", "manual", "identity_mismatch");
        return;
      }

      const results = await Promise.all(
        activeCollectors.map(async (collector): Promise<CollectorResult> => {
          this.options.jobStore.markSourceRunning(jobId, user.id, workDate, collector.source, expiresAt);
          const sourceStartedAt = Date.now();
          let result: CollectorResult;
          if (DWS_SOURCES.has(collector.source) && (!connection.connected || !connection.profile)) {
            result = {
              source: collector.source,
              status: "error",
              evidences: [],
              errorCode: connection.state === "unauthenticated" ? "unauthenticated" : "dws_unavailable",
              failureStage: "connection",
            };
          } else {
            try {
              result = await collector.collect({
                platformUserId: user.id,
                ddUserid: String(user.ddUserid ?? ""),
                selfUserIds: connection.identity?.userIds,
                displayName: user.name,
                profile: connection.profile ?? "",
                workDate,
                historyWorkDates: recentWorkdays(5, workDate),
                now: new Date(),
                run: (args, runOptions) => this.runJson(user.id, args, runOptions),
              });
            } catch {
              result = {
                source: collector.source,
                status: "error",
                evidences: [],
                errorCode: "collector_failed",
                failureStage: "collector",
              };
            }
          }
          result = deduplicateEvidences(result);
          result = {
            ...result,
            evidences: result.evidences.filter((evidence) => shouldPersistAsReference(evidence, user)
              && (evidence.temporalRole !== "today" || isInAssistantReportingWindow(evidence.occurredAt, workDate))),
          };
          try {
            for (const evidence of result.evidences) {
              this.options.evidenceStore.put(jobId, user.id, workDate, evidence, expiresAt);
            }
          } catch {
            result = {
              source: collector.source,
              status: "error",
              evidences: [],
              errorCode: "evidence_store_failed",
              failureStage: "evidence_store",
            };
          }
          result.durationMs = Math.max(0, Date.now() - sourceStartedAt);
          this.options.jobStore.markSourceResult(jobId, result);
          const details = result.completeness?.details ?? [];
          logStructured({
            evt: "assistant_context_source",
            userId: user.id,
            jobId,
            source: result.source,
            status: result.status,
            itemCount: result.completeness?.itemCount ?? result.evidences.length,
            pagesFetched: result.completeness?.pagesFetched ?? 0,
            complete: result.completeness?.complete ?? (result.status === "complete" || result.status === "empty"),
            hasMore: result.completeness?.hasMore ?? false,
            failures: result.completeness?.failures ?? (result.status === "error" ? 1 : 0),
            durationMs: result.durationMs,
            ...(result.source === "chat" ? {
              conversationCount: details.length,
              activeConversationCount: details.filter((detail) => detail.messagesFetched > 0).length,
              completeConversationCount: details.filter((detail) => detail.complete).length,
            } : {}),
          });
          return result;
        }),
      );

      const evidenceCount = results.reduce((sum, result) => sum + result.evidences.length, 0);
      const attendance = results.find((result) => result.source === "attendance_approval");
      if (attendance && attendance.status !== "error") {
        this.options.recordWorkStatus?.(user.id, workDate, attendance.evidences);
      }
      const degraded = results.some((result) => result.status === "error" || result.status === "partial");
      if (evidenceCount === 0) {
        this.options.jobStore.finish(jobId, "manual", "manual", degraded ? "no_usable_context" : undefined);
      } else if (degraded) {
        this.options.jobStore.finish(jobId, "partial", "partial");
      } else {
        this.options.jobStore.finish(jobId, "complete", "complete");
      }
    } catch {
      this.options.jobStore.finish(jobId, "failed", "manual", "job_failed");
    }
  }
}
