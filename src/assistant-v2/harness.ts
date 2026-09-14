import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { nowIso } from "../infra/db";
import { AssistantSubmitService } from "../assistant/submit-service";
import { AssistantSessionService } from "../assistant/session-service";
import {
  isUnconfirmedTaskSignal,
  listUnconfirmedTaskSignalSecrets,
  redactTaskSignalValue,
  taskSignalSecretFromDraft,
  type TaskSignalSecret,
} from "../assistant/task-signal-privacy";
import { projectDraftGaps } from "./gap-projection";
import { AssistantV2DraftTransaction } from "./draft-transaction";
import { DAILY_AGENT_SYSTEM_PROMPT, DAILY_AGENT_TOOLS } from "./prompt";
import {
  type AssistantModelProvider,
  type ProviderMessage,
  type ProviderToolCall,
  toolResultMessage,
} from "./provider-adapter";
import { buildOpening, type SourceStatusSummary } from "./opening";
import { renderAgentProjection } from "./projection";
import { parseJsonArguments, parsePatchRequest, parseReplyArguments } from "./schema";
import { AssistantV2StateRepository } from "./state-repository";
import {
  AssistantV2Error,
  type AgentDraftState,
  type AssistantConversationMessage,
  type AssistantConversationView,
  type AssistantTurnResponse,
  type ChangeReceipt,
  type ReplyFocus,
  type ReplyPayload,
  type ToolTraceEntry,
} from "./types";

interface HarnessProviders {
  primary: AssistantModelProvider;
  backup: AssistantModelProvider;
}

interface HarnessOptions {
  maxRounds?: number;
  timeoutMs?: number;
  findEvidence?: (input: { user: SessionUser; workDate: string; query: string }) => Promise<unknown[]>;
  /** 数据源读取状态（部分模式时告诉模型哪些来源没读到，开发文档 §18.2）。 */
  sourceStatus?: (user: SessionUser, workDate: string) => SourceStatusSummary | null;
}

function totalHours(state: AgentDraftState): number {
  return Math.round(state.items.reduce((sum, item) => sum + (item.hours ?? 0), 0) * 100) / 100;
}

function sourceLine(sources: SourceStatusSummary | null): string {
  if (!sources) return "";
  const parts: string[] = [];
  if (sources.read.length) parts.push(`已读取：${sources.read.join("、")}`);
  if (sources.unavailable.length) parts.push(`未读到：${sources.unavailable.join("、")}（涉及的工作只能靠员工补充，不要反复要求重试）`);
  if (sources.reading.length) parts.push(`读取中：${sources.reading.join("、")}`);
  return parts.length ? `数据源：${parts.join("；")}\n\n` : "";
}

interface StoredResponse {
  sourceMessageId: number;
  response: AssistantTurnResponse;
}

function exactKeys(input: Record<string, unknown>, allowed: string[], tool: string): void {
  const allow = new Set(allowed);
  const extras = Object.keys(input).filter((key) => !allow.has(key));
  if (extras.length) throw new AssistantV2Error("invalid_tool_arguments", `${tool} 包含未知字段：${extras.join("、")}`, true);
}

function toolSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function successfulToolTraceSummary(tool: string, result: Record<string, unknown>): string {
  if (tool === "find_work_evidence") {
    return JSON.stringify({ evidenceCount: Array.isArray(result.evidences) ? result.evidences.length : 0 });
  }
  if (tool === "get_report_state") return JSON.stringify({ revision: result.revision });
  return JSON.stringify(result).slice(0, 500);
}

export class DailyAssistantV2Harness {
  private readonly maxRounds: number;
  private readonly timeoutMs: number;
  private readonly locks = new Map<number, Promise<void>>();
  private primaryUnavailableUntil = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly providers: HarnessProviders,
    private readonly options: HarnessOptions = {},
  ) {
    this.maxRounds = options.maxRounds ?? 4;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async handleTurn(
    user: SessionUser,
    sessionId: number,
    rawMessage: unknown,
    rawClientMessageId: unknown,
  ): Promise<AssistantTurnResponse> {
    return this.withSessionLock(sessionId, async () => {
      const message = String(rawMessage ?? "").normalize("NFKC").trim();
      if (!message || message.length > 2_000) throw new AssistantV2Error("invalid_message", "消息不能为空且不能超过 2000 字");
      const clientMessageId = String(rawClientMessageId ?? "").trim().slice(0, 120);
      if (!clientMessageId) throw new AssistantV2Error("missing_message_id", "clientMessageId 不能为空");
      const sessions = new AssistantSessionService(this.db);
      const inserted = sessions.addMessage(sessionId, "user", "agent_v2_user", message, { agentVersion: 2 }, clientMessageId);
      if (inserted.duplicate) {
        const stored = this.readStoredResponse(inserted.id);
        if (stored) return stored;
        throw new AssistantV2Error("duplicate_in_progress", "该消息正在处理或上次处理未完成，请使用新的消息 ID 重试", true);
      }
      const provider = this.selectProvider();
      try {
        return await this.runTurn(user, inserted.id, message, provider);
      } catch (error) {
        if (provider === this.providers.primary && error instanceof AssistantV2Error && error.retryable && error.code.startsWith("provider_")) {
          this.primaryUnavailableUntil = Date.now() + 60_000;
        }
        this.persistFailure(sessionId, inserted.id, error);
        throw error;
      }
    });
  }

  private async runTurn(
    user: SessionUser,
    sourceMessageId: number,
    userMessage: string,
    provider: AssistantModelProvider,
  ): Promise<AssistantTurnResponse> {
    const transaction = new AssistantV2DraftTransaction(this.db, user, sourceMessageId, userMessage);
    const messages: ProviderMessage[] = [
      { role: "system", content: DAILY_AGENT_SYSTEM_PROMPT },
      ...transaction.state.history.map((entry) => ({ role: entry.role, content: entry.content }) as ProviderMessage),
      {
        role: "user",
        content: `当前用户消息 id: ${sourceMessageId}\n员工本轮原话：${userMessage}\n\n${sourceLine(this.options.sourceStatus?.(user, transaction.state.workDate) ?? null)}当前权威投影：\n${renderAgentProjection(transaction.state)}`,
      },
    ];
    const trace: ToolTraceEntry[] = [];
    let schemaRepairUsed = false;
    let finalReply: ReplyPayload | null = null;

    for (let round = 1; round <= this.maxRounds; round += 1) {
      const response = await provider.call({ messages, tools: DAILY_AGENT_TOOLS, toolChoice: "required", timeoutMs: this.timeoutMs });
      messages.push({ role: "assistant", content: response.content || null, tool_calls: response.toolCalls.length ? response.toolCalls : undefined });
      if (!response.toolCalls.length) throw new AssistantV2Error("reply_contract_violation", "模型没有调用 reply，草稿未修改", true);
      const replyCalls = response.toolCalls.filter((call) => call.function.name === "reply");
      if (replyCalls.length > 1) throw new AssistantV2Error("reply_contract_violation", "同一轮出现多个 reply，草稿未修改", true);
      const otherCalls = response.toolCalls.filter((call) => call.function.name !== "reply");
      let toolFailed = false;
      for (const toolCall of otherCalls) {
        const started = Date.now();
        try {
          const result = await this.executeTool(transaction, user, toolCall);
          messages.push(toolResultMessage(toolCall.id, { ok: true, ...result }));
          trace.push({
            round,
            tool: toolCall.function.name,
            status: "ok",
            durationMs: Date.now() - started,
            summary: successfulToolTraceSummary(toolCall.function.name, result),
          });
        } catch (error) {
          toolFailed = true;
          const repairable = error instanceof AssistantV2Error && error.retryable;
          if (repairable && !schemaRepairUsed) {
            schemaRepairUsed = true;
            messages.push(toolResultMessage(toolCall.id, { ok: false, error: toolSummary(error), code: error.code }));
            trace.push({ round, tool: toolCall.function.name, status: "rejected", durationMs: Date.now() - started, summary: toolSummary(error) });
            continue;
          }
          trace.push({ round, tool: toolCall.function.name, status: "error", durationMs: Date.now() - started, summary: toolSummary(error) });
          throw error;
        }
      }
      const replyCall = replyCalls[0];
      if (!replyCall) continue;
      if (toolFailed) {
        messages.push(toolResultMessage(replyCall.id, { ok: false, error: "同批工具失败，本条 reply 已丢弃；请按错误修正" }));
        trace.push({ round, tool: "reply", status: "rejected", durationMs: 0, summary: "同批工具失败" });
        continue;
      }
      const started = Date.now();
      try {
        const reply = parseReplyArguments(replyCall.function.arguments);
        if (reply.focus?.itemId && !transaction.state.items.some((item) => item.itemId === reply.focus?.itemId)) {
          throw new AssistantV2Error("invalid_tool_arguments", `reply.focus.itemId ${reply.focus.itemId} 不在当前投影中`, true);
        }
        if ((reply.message.includes("?") || reply.message.includes("？")) && reply.focus === null) {
          throw new AssistantV2Error("invalid_tool_arguments", "reply.message 是问题时 focus 不能为 null", true);
        }
        finalReply = reply;
        messages.push(toolResultMessage(replyCall.id, { ok: true }));
        trace.push({
          round,
          tool: "reply",
          status: "ok",
          durationMs: Date.now() - started,
          summary: reply.normalizedStringFocus ? "Provider Adapter 解码字符串化 focus 后通过 Schema" : "reply Schema 通过",
        });
        break;
      } catch (error) {
        if (error instanceof AssistantV2Error && error.retryable && !schemaRepairUsed) {
          schemaRepairUsed = true;
          messages.push(toolResultMessage(replyCall.id, { ok: false, error: error.message, code: error.code }));
          trace.push({ round, tool: "reply", status: "rejected", durationMs: Date.now() - started, summary: error.message });
          continue;
        }
        throw error;
      }
    }
    if (!finalReply) throw new AssistantV2Error("max_rounds_exceeded", `超过 ${this.maxRounds} 次工具往返仍未得到合法 reply，草稿未修改`, true);

    transaction.commit();
    let submitted = false;
    if (transaction.isSubmitRequested()) {
      const prepared = transaction.state.prepared;
      if (!prepared) throw new AssistantV2Error("prepared_hash_missing", "提交前的 prepared 状态丢失");
      try {
        new AssistantSubmitService(this.db).submitAuthorized(user, transaction.state.sessionId, `agent-v2:${sourceMessageId}:${prepared.hash}`);
      } catch (error) {
        // 草稿本身已经落库，不能再说“没有修改”；把真实原因告诉员工并保留 submit 焦点，员工修正后可以再确认。
        throw new AssistantV2Error("submit_failed", `草稿已保存，但正式提交失败：${toolSummary(error)}`);
      }
      submitted = true;
    }
    const latest = new AssistantV2StateRepository(this.db).read(user, transaction.state.sessionId);
    const response: AssistantTurnResponse = {
      assistantMessage: { messageId: 0, text: finalReply.message },
      receipts: transaction.receipts,
      draftProjection: { items: latest.items, gaps: projectDraftGaps(latest) },
      revision: latest.revision,
      focus: finalReply.focus,
      options: finalReply.options,
      submitted,
      model: provider.model,
    };
    const storageSecrets = [
      ...transaction.redactionSecrets(),
      ...latest.items.filter(isUnconfirmedTaskSignal).map(taskSignalSecretFromDraft),
    ];
    const messageId = this.persistReply(latest.sessionId, sourceMessageId, response, trace, storageSecrets);
    response.assistantMessage.messageId = messageId;
    this.db.prepare("UPDATE assistant_messages SET structured_json = ? WHERE id = ?").run(
      JSON.stringify(redactTaskSignalValue({ sourceMessageId, response }, storageSecrets)),
      messageId,
    );
    return response;
  }

  private async executeTool(
    transaction: AssistantV2DraftTransaction,
    user: SessionUser,
    toolCall: ProviderToolCall,
  ): Promise<Record<string, unknown>> {
    const name = toolCall.function.name;
    if (name === "get_report_state") {
      const args = parseJsonArguments(toolCall.function.arguments, name);
      exactKeys(args, [], name);
      return { revision: transaction.state.revision, projection: renderAgentProjection(transaction.state) };
    }
    if (name === "find_projects") {
      const args = parseJsonArguments(toolCall.function.arguments, name);
      exactKeys(args, ["query"], name);
      if (typeof args.query !== "string" || !args.query.trim()) throw new AssistantV2Error("invalid_tool_arguments", "find_projects.query 不能为空", true);
      const query = args.query.normalize("NFKC").toLowerCase();
      const projects = transaction.state.visibleProjects.filter((project) => project.name.normalize("NFKC").toLowerCase().includes(query) || query.includes(project.name.normalize("NFKC").toLowerCase()));
      return { projects, note: projects.length ? "" : "没有匹配的可见项目，不能创建项目" };
    }
    if (name === "find_work_evidence") {
      const args = parseJsonArguments(toolCall.function.arguments, name);
      exactKeys(args, ["query"], name);
      if (typeof args.query !== "string" || !args.query.trim()) throw new AssistantV2Error("invalid_tool_arguments", "find_work_evidence.query 不能为空", true);
      const evidences = this.options.findEvidence
        ? await this.options.findEvidence({ user, workDate: transaction.state.workDate, query: args.query.trim() })
        : [];
      return { evidences };
    }
    if (name === "apply_draft_patch") {
      const result = transaction.applyPatch(parsePatchRequest(toolCall.function.arguments));
      return { revision: transaction.state.revision, changeId: result.changeId, receipts: result.receipts, projection: renderAgentProjection(transaction.state) };
    }
    if (name === "undo_draft_change") {
      const args = parseJsonArguments(toolCall.function.arguments, name);
      exactKeys(args, ["changeId"], name);
      if (args.changeId !== undefined && typeof args.changeId !== "string") throw new AssistantV2Error("invalid_tool_arguments", "changeId 必须是字符串", true);
      const result = transaction.undo(args.changeId);
      return { revision: transaction.state.revision, ...result, projection: renderAgentProjection(transaction.state) };
    }
    if (name === "prepare_submission") {
      const args = parseJsonArguments(toolCall.function.arguments, name);
      exactKeys(args, [], name);
      return { ...transaction.prepareSubmission(), draft: renderAgentProjection(transaction.state) };
    }
    if (name === "submit_report") {
      const args = parseJsonArguments(toolCall.function.arguments, name);
      exactKeys(args, ["preparedHash", "authorizationMessageId"], name);
      if (typeof args.preparedHash !== "string" || !args.preparedHash) throw new AssistantV2Error("invalid_tool_arguments", "preparedHash 必须是字符串", true);
      if (!Number.isSafeInteger(args.authorizationMessageId)) throw new AssistantV2Error("invalid_tool_arguments", "authorizationMessageId 必须是整数", true);
      transaction.requestSubmit(args.preparedHash, Number(args.authorizationMessageId));
      return { accepted: true, submittedAt: nowIso() };
    }
    throw new AssistantV2Error("unknown_tool", `不支持的工具：${name}`, true);
  }

  /** 首轮开场：没有任何 V2 消息时，按投影生成确定性的候选列表和第一问，不调用模型。 */
  ensureOpening(user: SessionUser, sessionId: number): void {
    const existing = this.db
      .prepare("SELECT id FROM assistant_messages WHERE session_id = ? AND kind LIKE 'agent_v2_%' LIMIT 1")
      .get(sessionId) as { id: number } | undefined;
    if (existing) return;
    const state = new AssistantV2StateRepository(this.db).read(user, sessionId);
    const opening = buildOpening(state, this.options.sourceStatus?.(user, state.workDate) ?? null);
    this.db.prepare(
      `INSERT INTO assistant_messages
        (session_id, role, kind, content, structured_json, focus_json, tool_trace_json, created_at)
       VALUES (?, 'assistant', 'agent_v2_opening', ?, ?, ?, '[]', ?)`,
    ).run(
      sessionId,
      opening.text,
      JSON.stringify({ response: { receipts: [], options: opening.options } }),
      JSON.stringify(opening.focus),
      nowIso(),
    );
  }

  /** 前端读取会话：单一消息流 + 权威草稿投影。只返回 V2 内核自己的消息。 */
  readConversation(user: SessionUser, sessionId: number): AssistantConversationView {
    this.ensureOpening(user, sessionId);
    const state = new AssistantV2StateRepository(this.db).read(user, sessionId);
    const rows = this.db
      .prepare(
        `SELECT id, role, kind, content, structured_json, focus_json, created_at FROM assistant_messages
          WHERE session_id = ? AND kind LIKE 'agent_v2_%' ORDER BY id`,
      )
      .all(sessionId) as unknown as Array<{ id: number; role: "user" | "assistant"; kind: string; content: string; structured_json: string; focus_json: string; created_at: string }>;
    const dynamicOpening = rows.some((row) => row.kind === "agent_v2_user")
      ? null
      : buildOpening(state, this.options.sourceStatus?.(user, state.workDate) ?? null, true);
    const messages: AssistantConversationMessage[] = rows.map((row) => {
      let receipts: ChangeReceipt[] = [];
      let options: string[] = [];
      try {
        const parsed = JSON.parse(row.structured_json) as { response?: { receipts?: ChangeReceipt[]; options?: string[] } };
        receipts = Array.isArray(parsed.response?.receipts) ? parsed.response!.receipts! : [];
        options = Array.isArray(parsed.response?.options) ? parsed.response!.options!.map(String) : [];
      } catch {
        /* 旧消息没有结构化载荷 */
      }
      let focus: ReplyFocus | null = null;
      try {
        const parsed = JSON.parse(row.focus_json) as ReplyFocus | null;
        focus = parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        focus = null;
      }
      return {
        messageId: row.id,
        role: row.role,
        kind: row.kind,
        text: row.kind === "agent_v2_opening" && dynamicOpening ? dynamicOpening.text : row.content,
        receipts,
        focus,
        options,
        createdAt: row.created_at,
      };
    });
    const gaps = projectDraftGaps(state);
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    return {
      engine: "v2",
      sessionId: state.sessionId,
      workDate: state.workDate,
      mode: state.mode,
      status: state.status,
      revision: state.revision,
      submitted: state.status === "submitted",
      messages,
      draft: {
        items: state.items,
        gaps,
        totalHours: totalHours(state),
        canSubmit: gaps.length === 0 && state.items.length > 0,
        visibleProjects: state.visibleProjects,
        financeCodes: state.financeCodes,
      },
      focus: lastAssistant?.focus ?? null,
      options: lastAssistant?.options ?? [],
      sources: this.options.sourceStatus?.(user, state.workDate) ?? null,
    };
  }

  /** 草稿面板上的“撤销”按钮：不经过模型，直接反向应用变更账本。 */
  async undoDirect(user: SessionUser, sessionId: number, rawChangeId: unknown): Promise<AssistantTurnResponse> {
    return this.withSessionLock(sessionId, async () => {
      const latestUser = this.db
        .prepare("SELECT id FROM assistant_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
        .get(sessionId) as { id: number } | undefined;
      if (!latestUser) throw new AssistantV2Error("change_not_undoable", "没有可撤销的变更", true);
      const changeId = rawChangeId === undefined || rawChangeId === null || rawChangeId === "" ? undefined : String(rawChangeId).slice(0, 80);
      const transaction = new AssistantV2DraftTransaction(this.db, user, latestUser.id, "");
      const result = transaction.undo(changeId);
      transaction.commit();
      return this.persistSystemTurn(user, sessionId, latestUser.id, `${result.receipt}。你可以继续修改。`, transaction.receipts, "undo");
    });
  }

  /** 草稿面板上的“确认提交”按钮：员工看着完整草稿点了明确的提交按钮，属于确定性授权，不经过模型。 */
  async submitDirect(user: SessionUser, sessionId: number, rawExpectedRevision: unknown): Promise<AssistantTurnResponse> {
    return this.withSessionLock(sessionId, async () => {
      const state = new AssistantV2StateRepository(this.db).read(user, sessionId);
      const expectedRevision = Number(rawExpectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) {
        throw new AssistantV2Error("revision_conflict", "草稿已经变化，请重新查看后再提交", true);
      }
      const gaps = projectDraftGaps(state);
      if (gaps.length) throw new AssistantV2Error("draft_incomplete", `草稿还有未补齐的信息：${gaps.map((gap) => gap.text).join("；")}`, true);
      if (!state.items.length) throw new AssistantV2Error("draft_incomplete", "至少需要一条工作事项", true);
      const latestUser = this.db
        .prepare("SELECT id FROM assistant_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
        .get(sessionId) as { id: number } | undefined;
      const result = new AssistantSubmitService(this.db).submitAuthorized(user, sessionId, `agent-v2-ui:${sessionId}:${state.revision}`);
      const text = result.idempotent ? `这一版已经提交过（版本 ${result.version}），没有重复提交。` : `已提交今天的日报（版本 ${result.version}）。之后如果还要改，直接继续说，改完再确认一次即可。`;
      return this.persistSystemTurn(user, sessionId, latestUser?.id ?? 0, text, [], "submit", true);
    });
  }

  private persistSystemTurn(
    user: SessionUser,
    sessionId: number,
    sourceMessageId: number,
    text: string,
    receipts: ChangeReceipt[],
    origin: "undo" | "submit" | "finance_code",
    submitted = false,
  ): AssistantTurnResponse {
    const latest = new AssistantV2StateRepository(this.db).read(user, sessionId);
    const previousFocus = this.db
      .prepare("SELECT focus_json FROM assistant_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { focus_json: string } | undefined;
    let focus: ReplyFocus | null = null;
    try {
      focus = origin === "undo" ? (JSON.parse(previousFocus?.focus_json ?? "null") as ReplyFocus | null) : null;
    } catch {
      focus = null;
    }
    const response: AssistantTurnResponse = {
      assistantMessage: { messageId: 0, text },
      receipts,
      draftProjection: { items: latest.items, gaps: projectDraftGaps(latest) },
      revision: latest.revision,
      focus,
      options: [],
      submitted,
      model: "system",
    };
    const storageSecrets = latest.items.filter(isUnconfirmedTaskSignal).map(taskSignalSecretFromDraft);
    const messageId = this.persistReply(
      sessionId,
      sourceMessageId,
      response,
      [{ round: 0, tool: origin, status: "ok", durationMs: 0, summary: text }],
      storageSecrets,
    );
    response.assistantMessage.messageId = messageId;
    this.db.prepare("UPDATE assistant_messages SET structured_json = ? WHERE id = ?").run(
      JSON.stringify(redactTaskSignalValue({ sourceMessageId, response }, storageSecrets)),
      messageId,
    );
    return response;
  }

  /** 草稿面板直接选择财务编码：复用同一事务与变更账本，不绕过 revision/权限校验。 */
  async setFinanceCodeDirect(
    user: SessionUser,
    sessionId: number,
    rawExpectedRevision: unknown,
    itemId: unknown,
    rawFinanceCodeId: unknown,
  ): Promise<AssistantTurnResponse> {
    return this.withSessionLock(sessionId, async () => {
      const state = new AssistantV2StateRepository(this.db).read(user, sessionId);
      const expectedRevision = Number(rawExpectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) {
        throw new AssistantV2Error("revision_conflict", "草稿已经变化，请重新查看后再选择财务编码", true);
      }
      const itemKey = String(itemId ?? "").trim();
      const financeCodeId = Number(rawFinanceCodeId);
      if (!itemKey || !Number.isSafeInteger(financeCodeId) || financeCodeId <= 0) {
        throw new AssistantV2Error("invalid_operation", "财务项目编码选择无效", true);
      }
      const latestUser = this.db
        .prepare("SELECT id FROM assistant_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
        .get(sessionId) as { id: number } | undefined;
      if (!latestUser) throw new AssistantV2Error("invalid_operation", "请先补充一条日报事项，再选择财务项目编码", true);
      const transaction = new AssistantV2DraftTransaction(this.db, user, latestUser.id, "");
      const result = transaction.applyPatch({
        expectedRevision,
        operations: [{ op: "set_finance_code", itemId: itemKey, financeCodeId }],
      });
      transaction.commit();
      return this.persistSystemTurn(user, sessionId, latestUser.id, result.receipts.join("；") || "财务项目编码已更新。", transaction.receipts, "finance_code");
    });
  }

  private persistReply(
    sessionId: number,
    sourceMessageId: number,
    response: AssistantTurnResponse,
    trace: ToolTraceEntry[],
    secrets: TaskSignalSecret[],
  ): number {
    const storedResponse = redactTaskSignalValue(response, secrets);
    const result = this.db.prepare(
      `INSERT INTO assistant_messages
        (session_id, role, kind, content, structured_json, focus_json, tool_trace_json, created_at)
       VALUES (?, 'assistant', 'agent_v2_reply', ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      storedResponse.assistantMessage.text,
      JSON.stringify({ sourceMessageId, response: storedResponse }),
      JSON.stringify(storedResponse.focus),
      JSON.stringify(redactTaskSignalValue(trace, secrets)),
      nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  private persistFailure(sessionId: number, sourceMessageId: number, error: unknown): void {
    const secrets = listUnconfirmedTaskSignalSecrets(this.db, sessionId);
    const message = redactTaskSignalValue(error instanceof AssistantV2Error && error.code === "submit_failed"
      ? error.message
      : "这次处理没有修改草稿，请重试或使用草稿面板。", secrets);
    // 失败不清空上一轮的焦点：Agent 刚问过“要提交吗”，模型超时一次，员工再说“好的”仍然应该对得上。
    const previous = this.db
      .prepare(
        `SELECT focus_json FROM assistant_messages
          WHERE session_id = ? AND role = 'assistant' AND id < ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, sourceMessageId) as { focus_json: string } | undefined;
    this.db.prepare(
      `INSERT INTO assistant_messages
        (session_id, role, kind, content, structured_json, focus_json, tool_trace_json, created_at)
       VALUES (?, 'assistant', 'agent_v2_error', ?, ?, ?, '[]', ?)`,
    ).run(
      sessionId,
      message,
      JSON.stringify(redactTaskSignalValue({ sourceMessageId, error: toolSummary(error) }, secrets)),
      previous?.focus_json ?? "null",
      nowIso(),
    );
  }

  private readStoredResponse(sourceMessageId: number): AssistantTurnResponse | null {
    const row = this.db.prepare(
      `SELECT structured_json FROM assistant_messages
        WHERE role = 'assistant' AND json_extract(structured_json, '$.sourceMessageId') = ?
          AND kind = 'agent_v2_reply'
        ORDER BY id LIMIT 1`,
    ).get(sourceMessageId) as { structured_json: string } | undefined;
    if (!row) return null;
    try {
      return (JSON.parse(row.structured_json) as StoredResponse).response;
    } catch {
      return null;
    }
  }

  private selectProvider(): AssistantModelProvider {
    return Date.now() < this.primaryUnavailableUntil ? this.providers.backup : this.providers.primary;
  }

  private async withSessionLock<T>(sessionId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(sessionId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(sessionId) === queued) this.locks.delete(sessionId);
    }
  }
}
