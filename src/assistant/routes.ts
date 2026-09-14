import { canUseDwsAssistant, canUsePersonalLogs, type SessionUser } from "../auth/types";
import { readJson, sendJson, type Ctx, type Router } from "../infra/http";
import { todayYmd } from "../infra/workcal";
import { getAssistantRuntime } from "./runtime";
import { modeFromCompleteness } from "./conversation-schema";
import { AssistantValidationError } from "./structured-validation";
import { ProjectServiceError } from "../projects/service";
import { isExplicitSubmissionIntent } from "./submit-service";
import { audit } from "../infra/db";
import { invalidateAggCache } from "../platform/aggregate";
import { CONFIG } from "../infra/config";
import { assistantFeatureEnabled } from "./features";
import { AssistantV2Error } from "../assistant-v2/types";
import type { DailyAssistantV2Harness } from "../assistant-v2/harness";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireAssistantUser(ctx: Ctx): SessionUser | null {
  if (!ctx.user) {
    sendJson(ctx.res, 401, { ok: false, error: "未登录" });
    return null;
  }
  if (!canUsePersonalLogs(ctx.user) || !canUseDwsAssistant(ctx.user)) {
    sendJson(ctx.res, 403, { ok: false, error: "日报助手当前未向该账号开放" });
    return null;
  }
  return ctx.user;
}

function requestedToday(value: unknown): string | null {
  const date = String(value ?? todayYmd()).trim() || todayYmd();
  return YMD_RE.test(date) && date === todayYmd() ? date : null;
}

function runtimeOrError(ctx: Ctx) {
  try {
    return getAssistantRuntime();
  } catch (error) {
    sendJson(ctx.res, 503, {
      ok: false,
      error: "日报助手临时上下文存储尚未正确配置，可继续使用手工日志填写",
      code: "context_store_unavailable",
    });
    return null;
  }
}

function assistantContextFunnel(
  runtime: ReturnType<typeof getAssistantRuntime>,
  user: SessionUser,
  date: string,
) {
  const job = runtime.orchestrator.get(user.id, date);
  if (!job) return undefined;
  const references = runtime.orchestrator.references(job.id, user.id);
  const eventRun = runtime.eventRepository?.latestRunForJob(job.id, user.id, date);
  const interactionRun = runtime.interactionRepository?.latestRunForJob(job.id, user.id, date);
  const events = eventRun && (eventRun.status === "complete" || eventRun.status === "partial")
    ? runtime.eventRepository?.listForJob(job.id, user.id, date) ?? []
    : [];
  return {
    scannedCount: references.length,
    taskSignalCount: interactionRun?.signalEvidence,
    interactionCandidateCount: interactionRun && (interactionRun.status === "complete" || interactionRun.status === "partial")
      ? runtime.conversationEngine.activeTaskSignalCount(user.id, date)
      : undefined,
    interactionStatus: interactionRun?.status,
    interactionErrorCode: interactionRun?.errorCode,
    analysisInputCount: eventRun?.inputEvidenceCount,
    analysisCoveredCount: eventRun?.coveredEvidenceCount,
    eventStatus: eventRun?.status,
    eventErrorCode: eventRun?.errorCode,
    workEventCount: events.length,
    finalReferencedCount: new Set(events.flatMap((event) => event.evidenceIds)).size,
  };
}

async function ensureSession(runtime: ReturnType<typeof getAssistantRuntime>, user: SessionUser, date: string) {
  const job = runtime.orchestrator.get(user.id, date);
  const ready = job && job.status !== "queued" && job.status !== "running";
  const build = ready
    ? await runtime.candidateService.build(user, job.id, date)
    : { candidates: [], analysisMode: "manual" as const };
  return runtime.conversationEngine.ensureSession(
    user.id,
    date,
    modeFromCompleteness(ready ? job.completeness : "manual"),
    job?.id,
    build.candidates,
    build.analysisMode,
  );
}

async function ensureConversation(runtime: ReturnType<typeof getAssistantRuntime>, user: SessionUser, date: string) {
  const session = await ensureSession(runtime, user, date);
  return runtime.conversationEngine.state(session.id, user.id);
}

/** V2 内核按 userid 灰度；名单外的用户继续走旧内核，保证同一会话只有一个内核写入。 */
function agentV2For(runtime: ReturnType<typeof getAssistantRuntime>, user: SessionUser): DailyAssistantV2Harness | null {
  if (!runtime.agentV2Harness) return null;
  return CONFIG.assistant.agentV2Userids.includes(String(user.ddUserid ?? "")) ? runtime.agentV2Harness : null;
}

function sendAgentV2Error(ctx: Ctx, error: unknown): boolean {
  if (!(error instanceof AssistantV2Error)) return false;
  const code = error.code;
  if (code === "session_forbidden" || code === "source_message_forbidden" || code === "work_date_forbidden") {
    sendJson(ctx.res, 403, { ok: false, error: error.message, code });
    return true;
  }
  if (code === "revision_conflict" || code === "stale_source_message" || code === "duplicate_in_progress") {
    sendJson(ctx.res, 409, { ok: false, error: error.message, code });
    return true;
  }
  if (code.startsWith("provider_") || code === "max_rounds_exceeded" || code === "reply_contract_violation") {
    sendJson(ctx.res, 503, {
      ok: false,
      code,
      error: "智能理解服务暂时不可用，本次没有修改草稿。你可以稍后重试，或直接在草稿面板里修改。",
    });
    return true;
  }
  sendJson(ctx.res, 400, { ok: false, error: error.message, code });
  return true;
}

function sendConversationError(ctx: Ctx, error: unknown): void {
  if (error instanceof AssistantValidationError) {
    sendJson(ctx.res, 400, { ok: false, error: error.message, code: "invalid_assistant_action" });
    return;
  }
  if (error instanceof ProjectServiceError) {
    sendJson(ctx.res, error.statusCode, { ok: false, error: error.message, code: error.code });
    return;
  }
  throw error;
}

function requireFeature(ctx: Ctx, enabled: boolean, name: string): boolean {
  if (enabled) return true;
  sendJson(ctx.res, 404, { ok: false, error: `${name}功能尚未开启`, code: "feature_disabled" });
  return false;
}

export function registerAssistantRoutes(router: Router): void {
  router.post("/api/daily-assistant/context/start", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    const body = await readJson<{ date?: string }>(ctx.req);
    const date = requestedToday(body.date);
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "上下文任务仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const job = runtime.orchestrator.start(user, date);
    sendJson(ctx.res, 202, { ok: true, job });
  });

  router.get("/api/daily-assistant/context/status", (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    const date = requestedToday(ctx.url.searchParams.get("date"));
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "上下文任务仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const job = runtime.orchestrator.get(user.id, date);
    const eventRun = job ? runtime.eventRepository?.latestRunForJob(job.id, user.id, date) : null;
    const interactionRun = job ? runtime.interactionRepository?.latestRunForJob(job.id, user.id, date) : null;
    const references = job ? runtime.orchestrator.references(job.id, user.id) : [];
    sendJson(ctx.res, 200, {
      ok: true,
      job,
      references,
      eventRun: eventRun ? {
        ...eventRun,
        analysisMode: eventRun.status === "failed" ? "manual" : "real_model",
      } : undefined,
      interactionRun: interactionRun ? {
        ...interactionRun,
        analysisMode: interactionRun.status === "failed" ? "manual" : "real_model",
      } : undefined,
      contextFunnel: assistantContextFunnel(runtime, user, date),
    });
  });

  router.post("/api/daily-assistant/context/refresh", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    const body = await readJson<{ date?: string }>(ctx.req);
    const date = requestedToday(body.date);
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "上下文任务仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const job = runtime.orchestrator.start(user, date, true);
    sendJson(ctx.res, 202, { ok: true, job });
  });

  router.get("/api/daily-assistant/candidates", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    const date = requestedToday(ctx.url.searchParams.get("date"));
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "候选事项仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const job = runtime.orchestrator.get(user.id, date);
    if (!job) {
      sendJson(ctx.res, 404, { ok: false, error: "请先准备当天上下文" });
      return;
    }
    if (job.status === "queued" || job.status === "running") {
      sendJson(ctx.res, 202, { ok: true, ready: false, candidates: [] });
      return;
    }
    const build = await runtime.candidateService.build(user, job.id, date);
    sendJson(ctx.res, 200, { ok: true, ready: true, completeness: job.completeness, ...build });
  });

  router.get("/api/daily-assistant/conversation", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    if (!requireFeature(ctx, assistantFeatureEnabled("conversation", CONFIG.assistant), "对话生成")) return;
    const date = requestedToday(ctx.url.searchParams.get("date"));
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "对话助手仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const job = runtime.orchestrator.get(user.id, date);
    if (ctx.url.searchParams.get("analysis_poll") === "1"
      && job
      && job.status !== "queued"
      && job.status !== "running"
      && runtime.candidateService.usesRolloutAnalysis(user)) {
      const preparation = runtime.candidateService.prepare(user, job.id, date);
      if (!preparation.ready) {
        sendJson(ctx.res, 202, {
          ok: true,
          ready: false,
          analysisRunning: true,
        });
        return;
      }
    }
    const harness = agentV2For(runtime, user);
    if (harness) {
      try {
        const session = await ensureSession(runtime, user, date);
        sendJson(ctx.res, 200, {
          ok: true,
          ...harness.readConversation(user, session.id),
          contextFunnel: assistantContextFunnel(runtime, user, date),
        });
      } catch (error) {
        if (!sendAgentV2Error(ctx, error)) throw error;
      }
      return;
    }
    sendJson(ctx.res, 200, {
      ok: true,
      ...await ensureConversation(runtime, user, date),
      contextFunnel: assistantContextFunnel(runtime, user, date),
    });
  });

  router.post("/api/daily-assistant/conversation/message", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    if (!requireFeature(ctx, assistantFeatureEnabled("conversation", CONFIG.assistant), "对话生成")) return;
    const body = await readJson<{ date?: string; message?: string; clientMessageId?: string }>(ctx.req);
    const date = requestedToday(body.date);
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "对话助手仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const harness = agentV2For(runtime, user);
    if (harness) {
      try {
        const session = await ensureSession(runtime, user, date);
        harness.ensureOpening(user, session.id);
        const clientMessageId = body.clientMessageId ? String(body.clientMessageId).slice(0, 120) : `srv-${session.id}-${Date.now()}`;
        const turn = await harness.handleTurn(user, session.id, body.message, clientMessageId);
        sendJson(ctx.res, 200, {
          ok: true,
          turn,
          ...harness.readConversation(user, session.id),
          contextFunnel: assistantContextFunnel(runtime, user, date),
        });
      } catch (error) {
        if (!sendAgentV2Error(ctx, error)) throw error;
      }
      return;
    }
    try {
      const current = await ensureConversation(runtime, user, date);
      if (isExplicitSubmissionIntent(body.message)) {
        if (!requireFeature(ctx, assistantFeatureEnabled("submit", CONFIG.assistant), "正式提交")) return;
        const key = body.clientMessageId ? String(body.clientMessageId).slice(0, 120) : `${current.session.id}:${current.session.revision}:submit`;
        const result = runtime.submitService.submit(user, current.session.id, body.message, key);
        if (!result.idempotent) {
          invalidateAggCache();
          audit(user.id, result.version > 1 ? "assistant_log.update" : "assistant_log.submit", date);
        }
        sendJson(ctx.res, 200, {
          ok: true,
          submitted: true,
          ...result,
          contextFunnel: assistantContextFunnel(runtime, user, date),
        });
        return;
      }
      const state = await runtime.conversationEngine.handleMessage(
        user,
        current.session.id,
        body.message,
        body.clientMessageId ? String(body.clientMessageId).slice(0, 120) : undefined,
      );
      sendJson(ctx.res, 200, {
        ok: true,
        ...state,
        contextFunnel: assistantContextFunnel(runtime, user, date),
      });
    } catch (error) {
      sendConversationError(ctx, error);
    }
  });

  router.post("/api/daily-assistant/conversation/submit", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    if (!requireFeature(ctx, assistantFeatureEnabled("conversation", CONFIG.assistant), "对话生成")) return;
    if (!requireFeature(ctx, assistantFeatureEnabled("submit", CONFIG.assistant), "正式提交")) return;
    const body = await readJson<{ date?: string; confirmation?: string; idempotencyKey?: string; revision?: number }>(ctx.req);
    const date = requestedToday(body.date);
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "日报助手只提交当天日报" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const harness = agentV2For(runtime, user);
    if (harness) {
      try {
        const session = await ensureSession(runtime, user, date);
        const turn = await harness.submitDirect(user, session.id, body.revision);
        if (turn.submitted) {
          invalidateAggCache();
          audit(user.id, "assistant_log.submit", date);
        }
        sendJson(ctx.res, 200, {
          ok: true,
          turn,
          ...harness.readConversation(user, session.id),
          submitted: turn.submitted,
          contextFunnel: assistantContextFunnel(runtime, user, date),
        });
      } catch (error) {
        if (!sendAgentV2Error(ctx, error)) throw error;
      }
      return;
    }
    try {
      const current = await ensureConversation(runtime, user, date);
      const result = runtime.submitService.submit(user, current.session.id, body.confirmation, body.idempotencyKey);
      if (!result.idempotent) {
        invalidateAggCache();
        audit(user.id, result.version > 1 ? "assistant_log.update" : "assistant_log.submit", date);
      }
      sendJson(ctx.res, 200, {
        ok: true,
        submitted: true,
        ...result,
        contextFunnel: assistantContextFunnel(runtime, user, date),
      });
    } catch (error) {
      sendConversationError(ctx, error);
    }
  });

  router.post("/api/daily-assistant/conversation/finance-code", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    if (!requireFeature(ctx, assistantFeatureEnabled("conversation", CONFIG.assistant), "对话生成")) return;
    const body = await readJson<{ date?: string; itemId?: string; financeCodeId?: number; revision?: number }>(ctx.req);
    const date = requestedToday(body.date);
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "日报助手仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const harness = agentV2For(runtime, user);
    if (!harness) {
      sendJson(ctx.res, 400, { ok: false, error: "当前日报助手版本请在对话中说明财务项目编码，或使用手工填写页面" });
      return;
    }
    try {
      const session = await ensureSession(runtime, user, date);
      const turn = await harness.setFinanceCodeDirect(user, session.id, body.revision, body.itemId, body.financeCodeId);
      sendJson(ctx.res, 200, {
        ok: true,
        turn,
        ...harness.readConversation(user, session.id),
        contextFunnel: assistantContextFunnel(runtime, user, date),
      });
    } catch (error) {
      if (!sendAgentV2Error(ctx, error)) throw error;
    }
  });

  router.post("/api/daily-assistant/conversation/actions", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    if (!requireFeature(ctx, assistantFeatureEnabled("conversation", CONFIG.assistant), "对话生成")) return;
    const body = await readJson<{ date?: string; actions?: unknown[] }>(ctx.req);
    const date = requestedToday(body.date);
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "对话助手仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    try {
      if (!Array.isArray(body.actions) || body.actions.length === 0 || body.actions.length > 20) {
        throw new AssistantValidationError("请提供 1 至 20 条结构化修改");
      }
      const current = await ensureConversation(runtime, user, date);
      const state = runtime.conversationEngine.applyStructured(user, current.session.id, body.actions);
      sendJson(ctx.res, 200, {
        ok: true,
        ...state,
        contextFunnel: assistantContextFunnel(runtime, user, date),
      });
    } catch (error) {
      sendConversationError(ctx, error);
    }
  });

  router.post("/api/daily-assistant/conversation/undo", async (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    if (!requireFeature(ctx, assistantFeatureEnabled("conversation", CONFIG.assistant), "对话生成")) return;
    const body = await readJson<{ date?: string; changeId?: string }>(ctx.req);
    const date = requestedToday(body.date);
    if (!date) {
      sendJson(ctx.res, 400, { ok: false, error: "对话助手仅支持当天" });
      return;
    }
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const harness = agentV2For(runtime, user);
    if (!harness) {
      sendJson(ctx.res, 404, { ok: false, error: "撤销仅在新版日报助手中可用", code: "feature_disabled" });
      return;
    }
    try {
      const session = await ensureSession(runtime, user, date);
      const turn = await harness.undoDirect(user, session.id, body.changeId);
      sendJson(ctx.res, 200, {
        ok: true,
        turn,
        ...harness.readConversation(user, session.id),
        contextFunnel: assistantContextFunnel(runtime, user, date),
      });
    } catch (error) {
      if (!sendAgentV2Error(ctx, error)) throw error;
    }
  });

  router.get("/api/daily-assistant/references/:referenceId", (ctx) => {
    const user = requireAssistantUser(ctx);
    if (!user) return;
    const runtime = runtimeOrError(ctx);
    if (!runtime) return;
    const reference = runtime.orchestrator.reference(String(ctx.params.referenceId ?? ""), user.id);
    if (!reference) {
      sendJson(ctx.res, 404, { ok: false, error: "Reference 不存在、已过期或无权访问" });
      return;
    }
    sendJson(ctx.res, 200, { ok: true, reference });
  });
}
