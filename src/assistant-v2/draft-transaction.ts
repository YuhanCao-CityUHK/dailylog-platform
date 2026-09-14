import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import {
  isUnconfirmedTaskSignal,
  redactTaskSignalValue,
  scrubTaskSignalSecrets,
  taskSignalSecretFromDraft,
  type TaskSignalSecret,
} from "../assistant/task-signal-privacy";
import { nowIso } from "../infra/db";
import { getFinanceProjectCode } from "../platform/finance-project-codes";
import { projectDraftGaps } from "./gap-projection";
import { AssistantV2PolicyGuard } from "./policy-guard";
import { AssistantV2StateRepository } from "./state-repository";
import {
  AssistantV2Error,
  cloneAgentState,
  type AgentDraftItem,
  type AgentDraftState,
  type ChangeReceipt,
  type DraftOperation,
  type PatchRequest,
} from "./types";

interface DraftSnapshot {
  outsideWorkAsked: boolean;
  outsideWorkAnswered: boolean;
  items: AgentDraftItem[];
  /** Items omitted from this durable snapshot and preserved from current state during undo. */
  preservedItemIds?: string[];
}

interface HardDeletedTaskSignal extends TaskSignalSecret {
  recordId: number | null;
}

interface PendingChange {
  changeId: string;
  revision: number;
  op: string;
  before: DraftSnapshot;
  after: DraftSnapshot;
  receipts: string[];
  operations: DraftOperation[];
  undoneAt: string | null;
}

function text(value: unknown, field: string, allowEmpty = false): string {
  const result = String(value ?? "").normalize("NFKC").trim();
  if (!allowEmpty && !result) throw new AssistantV2Error("invalid_operation", `${field} 不能为空`, true);
  return result;
}

function snapshot(state: AgentDraftState): DraftSnapshot {
  return cloneAgentState({
    outsideWorkAsked: state.outsideWorkAsked,
    outsideWorkAnswered: state.outsideWorkAnswered,
    items: state.items,
  });
}

function ledgerSnapshot(value: DraftSnapshot, preservedItemIds: Iterable<string>): DraftSnapshot {
  const preserved = [...new Set(preservedItemIds)].sort();
  const ids = new Set(preserved);
  const result = cloneAgentState(value);
  result.items = result.items.filter((item) => !ids.has(item.itemId));
  result.items.forEach((item, index) => {
    item.order = index + 1;
    item.displayAlias = `第 ${index + 1} 项`;
  });
  return { ...result, ...(preserved.length ? { preservedItemIds: preserved } : {}) };
}

function restore(state: AgentDraftState, value: DraftSnapshot): void {
  const currentById = new Map(state.items.map((item) => [item.itemId, item]));
  const preserved = (value.preservedItemIds ?? [])
    .map((itemId) => currentById.get(itemId))
    .filter((item): item is AgentDraftItem => Boolean(item));
  state.outsideWorkAsked = value.outsideWorkAsked;
  state.outsideWorkAnswered = value.outsideWorkAnswered;
  state.items = [...cloneAgentState(value.items), ...cloneAgentState(preserved)].sort((left, right) => left.order - right.order);
  refreshAliases(state);
}

function refreshAliases(state: AgentDraftState): void {
  state.items.forEach((item, index) => {
    item.order = index + 1;
    item.displayAlias = `第 ${index + 1} 项`;
  });
}

/** 新事项用短 id：模型要原样回抄，36 位 UUID 既贵又容易抄错。会话内保证唯一。 */
function newItemId(state: AgentDraftState): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `wi_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    if (!state.items.some((item) => item.itemId === candidate)) return candidate;
  }
  return `wi_${randomUUID()}`;
}

function uniqueParts(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].join("；");
}

function operationTouchesAny(operation: DraftOperation, itemIds: Set<string>): boolean {
  if ("itemId" in operation) return itemIds.has(operation.itemId);
  if (!("itemIds" in operation)) return false;
  if (operation.itemIds === "all") return itemIds.size > 0;
  return operation.itemIds.some((itemId) => itemIds.has(itemId));
}

function hashState(state: AgentDraftState): string {
  return createHash("sha256")
    .update(JSON.stringify({ revision: state.revision, items: state.items.map(({ recordId: _recordId, displayAlias: _alias, ...item }) => item) }))
    .digest("hex")
    .slice(0, 24);
}

export class AssistantV2DraftTransaction {
  readonly state: AgentDraftState;
  readonly initialRevision: number;
  readonly receipts: ChangeReceipt[] = [];
  private readonly guard: AssistantV2PolicyGuard;
  private readonly pending: PendingChange[] = [];
  private readonly persistedUndoIds = new Set<string>();
  private readonly hardDeletedTaskSignals: HardDeletedTaskSignal[] = [];
  private submitRequested = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly user: SessionUser,
    readonly sourceMessageId: number,
    readonly userMessage: string,
  ) {
    const message = db.prepare("SELECT session_id FROM assistant_messages WHERE id = ?").get(sourceMessageId) as { session_id: number } | undefined;
    if (!message) throw new AssistantV2Error("source_message_not_found", "用户消息不存在");
    this.state = new AssistantV2StateRepository(db).read(user, message.session_id, sourceMessageId);
    this.initialRevision = this.state.revision;
    this.guard = new AssistantV2PolicyGuard(db);
    this.guard.assertTurn(user, this.state, sourceMessageId);
  }

  applyPatch(request: PatchRequest): { changeId: string; receipts: string[] } {
    this.guard.assertRevision(this.state, request.expectedRevision);
    const before = snapshot(this.state);
    const hardDeleteStart = this.hardDeletedTaskSignals.length;
    const working = cloneAgentState(this.state);
    const receiptTexts: string[] = [];
    try {
      for (const operation of request.operations) this.applyOperation(working, operation, receiptTexts);
    } catch (error) {
      this.hardDeletedTaskSignals.splice(hardDeleteStart);
      throw error instanceof AssistantV2Error ? error : new AssistantV2Error("invalid_operation", String(error), true);
    }
    working.revision += 1;
    working.prepared = null;
    refreshAliases(working);
    const changeId = `c_${randomUUID()}`;
    Object.assign(this.state, working);
    const after = snapshot(this.state);
    const afterItemIds = new Set(after.items.map((item) => item.itemId));
    const alreadyHardDeleted = new Set(this.hardDeletedTaskSignals.map((item) => item.itemKey));
    for (const item of before.items) {
      if (!isUnconfirmedTaskSignal(item) || afterItemIds.has(item.itemId) || alreadyHardDeleted.has(item.itemId)) continue;
      this.hardDeletedTaskSignals.push({ ...taskSignalSecretFromDraft(item), recordId: item.recordId });
      alreadyHardDeleted.add(item.itemId);
    }
    const newHardDeletes = this.hardDeletedTaskSignals.slice(hardDeleteStart);
    const transientBeforeIds = new Set(before.items.filter(isUnconfirmedTaskSignal).map((item) => item.itemId));
    const transientSecrets = [
      ...before.items.filter(isUnconfirmedTaskSignal).map(taskSignalSecretFromDraft),
      ...after.items.filter(isUnconfirmedTaskSignal).map(taskSignalSecretFromDraft),
      ...newHardDeletes,
    ];
    const preservedIds = transientSecrets.map((secret) => secret.itemKey);
    const irreversibleOperationIndexes = new Set(
      request.operations.flatMap((operation, index) => operationTouchesAny(operation, transientBeforeIds) ? [index] : []),
    );
    const operations = request.operations.filter((_operation, index) => !irreversibleOperationIndexes.has(index));
    const persistedReceipts = redactTaskSignalValue(receiptTexts, transientSecrets);
    const persistedOperations = redactTaskSignalValue(cloneAgentState(operations), transientSecrets);
    if (operations.length) {
      const op = operations.map((operation) => operation.op).join("+");
      this.pending.push({
        changeId,
        revision: this.state.revision,
        op,
        before: ledgerSnapshot(before, preservedIds),
        after: ledgerSnapshot(after, preservedIds),
        receipts: persistedReceipts,
        operations: persistedOperations,
        undoneAt: null,
      });
      this.state.recentChanges.unshift({ changeId, revision: this.state.revision, op, summary: persistedReceipts.join("；"), undone: false });
    }
    for (const [index, receipt] of receiptTexts.entries()) {
      this.receipts.push({ changeId, text: receipt, undoable: operations.length > 0 && !irreversibleOperationIndexes.has(index) });
    }
    return { changeId, receipts: receiptTexts };
  }

  undo(changeId?: string): { changeId: string; receipt: string } {
    const pendingCandidates = this.pending.filter((change) => !change.undoneAt);
    const pending = changeId
      ? pendingCandidates.find((change) => change.changeId === changeId)
      : pendingCandidates[pendingCandidates.length - 1];
    if (pending) {
      restore(this.state, pending.before);
      pending.undoneAt = nowIso();
      this.state.revision += 1;
      this.state.prepared = null;
      const receipt = `已撤销 ${pending.changeId}（${pending.op}）`;
      this.receipts.push({ changeId: pending.changeId, text: receipt, undoable: false });
      return { changeId: pending.changeId, receipt };
    }
    const row = changeId
      ? this.db.prepare("SELECT * FROM assistant_changes WHERE change_id = ? AND session_id = ? AND undone_at IS NULL").get(changeId, this.state.sessionId)
      : this.db.prepare("SELECT * FROM assistant_changes WHERE session_id = ? AND undone_at IS NULL ORDER BY revision DESC LIMIT 1").get(this.state.sessionId);
    const target = row as { change_id: string; op: string; before_json: string } | undefined;
    if (!target) throw new AssistantV2Error("change_not_undoable", changeId ? `变更 ${changeId} 不存在或已撤销` : "没有可撤销的变更", true);
    const currentTransientIds = this.state.items.filter(isUnconfirmedTaskSignal).map((item) => item.itemId);
    const before = ledgerSnapshot(snapshot(this.state), currentTransientIds);
    let restored: DraftSnapshot;
    try {
      restored = JSON.parse(target.before_json) as DraftSnapshot;
    } catch {
      throw new AssistantV2Error("change_corrupt", `变更 ${target.change_id} 的快照损坏`);
    }
    restore(this.state, restored);
    this.state.revision += 1;
    this.state.prepared = null;
    this.persistedUndoIds.add(target.change_id);
    const receipt = `已撤销 ${target.change_id}（${target.op}）`;
    const undoId = `c_${randomUUID()}`;
    this.pending.push({
      changeId: undoId,
      revision: this.state.revision,
      op: `undo:${target.change_id}`,
      before,
      after: ledgerSnapshot(snapshot(this.state), [
        ...currentTransientIds,
        ...this.state.items.filter(isUnconfirmedTaskSignal).map((item) => item.itemId),
      ]),
      receipts: [receipt],
      operations: [],
      undoneAt: null,
    });
    this.receipts.push({ changeId: target.change_id, text: receipt, undoable: false });
    return { changeId: target.change_id, receipt };
  }

  prepareSubmission(): { preparedHash: string; revision: number } {
    this.guard.assertSubmissionAuthorized(this.state);
    const gaps = projectDraftGaps(this.state);
    if (gaps.length) throw new AssistantV2Error("draft_incomplete", `缺口未闭环，不能提交：${gaps.map((gap) => gap.text).join("；")}`, true);
    const preparedHash = hashState(this.state);
    this.state.prepared = { hash: preparedHash, revision: this.state.revision, messageId: this.sourceMessageId };
    return { preparedHash, revision: this.state.revision };
  }

  requestSubmit(preparedHash: string, authorizationMessageId: number): void {
    this.guard.assertSubmissionAuthorized(this.state);
    if (this.pending.length || this.persistedUndoIds.size || this.hardDeletedTaskSignals.length) {
      throw new AssistantV2Error(
        "submission_with_writes",
        "同一轮不能既修改草稿又提交：员工既然要改，就还没有确认最终版本。先只做修改并 reply，之后再以 focus.field=submit 询问是否提交。",
        true,
      );
    }
    if (authorizationMessageId !== this.sourceMessageId) {
      throw new AssistantV2Error("submission_message_mismatch", "提交授权消息与当前用户消息不一致", true);
    }
    if (!this.state.prepared || this.state.prepared.hash !== preparedHash || this.state.prepared.revision !== this.state.revision) {
      throw new AssistantV2Error("prepared_hash_mismatch", "preparedHash 与当前草稿不一致，请重新准备提交", true);
    }
    if (projectDraftGaps(this.state).length) throw new AssistantV2Error("draft_incomplete", "缺口未闭环，不能提交", true);
    this.submitRequested = true;
  }

  isSubmitRequested(): boolean {
    return this.submitRequested;
  }

  redactionSecrets(): TaskSignalSecret[] {
    return this.hardDeletedTaskSignals.map(({ itemKey, title, referenceIds }) => ({ itemKey, title, referenceIds: [...referenceIds] }));
  }

  commit(): void {
    const stamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT revision, status FROM assistant_sessions WHERE id = ? AND user_id = ?").get(this.state.sessionId, this.user.id) as { revision: number; status: string } | undefined;
      if (!current || current.status === "abandoned") throw new AssistantV2Error("session_not_active", "会话已结束");
      if (current.revision !== this.initialRevision) throw new AssistantV2Error("revision_conflict", "草稿在本轮期间已被修改，请重试", true);
      this.persistItems(stamp);
      if (this.hardDeletedTaskSignals.length) {
        scrubTaskSignalSecrets(this.db, this.state.sessionId, this.hardDeletedTaskSignals);
        const deleteById = this.db.prepare(
          `DELETE FROM assistant_session_items
            WHERE id = ? AND session_id = ? AND source_kind = 'candidate'
              AND employee_confirmed = 0 AND needs_confirmation_json LIKE '%"task_signal"%'`,
        );
        const deleteByKey = this.db.prepare(
          `DELETE FROM assistant_session_items
            WHERE item_key = ? AND session_id = ? AND source_kind = 'candidate'
              AND employee_confirmed = 0 AND needs_confirmation_json LIKE '%"task_signal"%'`,
        );
        for (const item of this.hardDeletedTaskSignals) {
          const result = item.recordId !== null
            ? deleteById.run(item.recordId, this.state.sessionId)
            : deleteByKey.run(item.itemKey, this.state.sessionId);
          if (Number(result.changes) !== 1) {
            throw new AssistantV2Error("task_signal_delete_failed", "待确认任务线索未能安全清除，请重试");
          }
        }
      }
      this.db.prepare(
        `UPDATE assistant_sessions
            SET outside_work_asked = ?, outside_work_answered = ?, revision = ?,
                prepared_hash = ?, prepared_revision = ?, prepared_message_id = ?, prepared_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`,
      ).run(
        this.state.outsideWorkAsked ? 1 : 0,
        this.state.outsideWorkAnswered ? 1 : 0,
        this.state.revision,
        this.state.prepared?.hash ?? null,
        this.state.prepared?.revision ?? null,
        this.state.prepared?.messageId ?? null,
        this.state.prepared ? stamp : null,
        stamp,
        this.state.sessionId,
        this.user.id,
      );
      for (const changeId of this.persistedUndoIds) {
        this.db.prepare("UPDATE assistant_changes SET undone_at = ? WHERE change_id = ? AND session_id = ? AND undone_at IS NULL").run(stamp, changeId, this.state.sessionId);
      }
      for (const change of this.pending) {
        this.db.prepare(
          `INSERT INTO assistant_changes
            (change_id, session_id, revision, op, before_json, after_json, receipts_json, operations_json, source_message_id, created_at, undone_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          change.changeId,
          this.state.sessionId,
          change.revision,
          change.op,
          JSON.stringify(change.before),
          JSON.stringify(change.after),
          JSON.stringify(change.receipts),
          JSON.stringify(change.operations),
          this.sourceMessageId,
          stamp,
          change.undoneAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private requireItem(state: AgentDraftState, itemId: string): AgentDraftItem {
    const item = state.items.find((candidate) => candidate.itemId === itemId);
    if (!item) {
      throw new AssistantV2Error(
        "item_not_found",
        `事项 ${itemId} 不存在。当前有效事项：${state.items.map((candidate) => `${candidate.displayAlias}=${candidate.itemId}`).join("，") || "无"}`,
        true,
      );
    }
    return item;
  }

  private confirm(item: AgentDraftItem): void {
    item.confirmed = true;
    item.needsConfirmation = [];
    item.missingFacts = [];
  }

  private applyOperation(state: AgentDraftState, operation: DraftOperation, receipts: string[]): void {
    switch (operation.op) {
      case "add_item": {
        const projectId = operation.projectId ?? null;
        this.guard.assertProjectVisible(state, projectId);
        const item: AgentDraftItem = {
          recordId: null,
          itemId: newItemId(state),
          displayAlias: "",
          order: state.items.length + 1,
          scopeType: projectId === null ? "department_daily" : "project",
          projectId,
          projectName: projectId === null ? null : state.visibleProjects.find((project) => project.id === projectId)?.name ?? null,
          financeCodeId: null,
          financeCode: null,
          recommendedProjectId: null,
          status: operation.status ?? "in_progress",
          summary: operation.summary,
          result: operation.result ?? "",
          hours: operation.hours ?? null,
          blocker: operation.blocker ?? "",
          nextAction: operation.nextAction ?? "",
          supportNeeded: "",
          supportPeople: [],
          tomorrowPlan: operation.tomorrowPlan ?? "",
          confirmed: true,
          origin: "employee",
          sourceKind: "employee",
          referenceIds: [],
          needsConfirmation: [],
          sourceCompleteness: "complete",
          confidence: 1,
          missingFacts: [],
        };
        state.items.push(item);
        refreshAliases(state);
        if (state.lastFocus?.field === "outside_work") state.outsideWorkAnswered = true;
        receipts.push(`新增 ${item.displayAlias}「${item.summary}」`);
        return;
      }
      case "delete_item": {
        const item = this.requireItem(state, operation.itemId);
        if (isUnconfirmedTaskSignal(item)) {
          const receiptText = `已删除 ${item.displayAlias} 的待确认任务线索`;
          this.hardDeletedTaskSignals.push({
            ...taskSignalSecretFromDraft(item),
            recordId: item.recordId,
          });
          state.items = state.items.filter((candidate) => candidate.itemId !== item.itemId);
          refreshAliases(state);
          receipts.push(receiptText);
          return;
        }
        state.items = state.items.filter((candidate) => candidate.itemId !== item.itemId);
        refreshAliases(state);
        receipts.push(`已删除 ${item.displayAlias}「${item.summary}」${operation.reason ? `（${operation.reason}）` : ""}`);
        return;
      }
      case "update_summary": {
        const item = this.requireItem(state, operation.itemId);
        item.summary = text(operation.summary, "summary");
        this.confirm(item);
        receipts.push(`${item.displayAlias} 事项改为「${item.summary}」`);
        return;
      }
      case "set_result": {
        const item = this.requireItem(state, operation.itemId);
        item.result = text(operation.result, "result");
        this.confirm(item);
        receipts.push(`${item.displayAlias} 结果记为「${item.result}」`);
        return;
      }
      case "set_hours": {
        const item = this.requireItem(state, operation.itemId);
        item.hours = operation.hours;
        this.confirm(item);
        receipts.push(`${item.displayAlias} 记为 ${item.hours} 小时`);
        return;
      }
      case "set_project": {
        const item = this.requireItem(state, operation.itemId);
        this.guard.assertProjectVisible(state, operation.projectId);
        item.projectId = operation.projectId;
        item.projectName = operation.projectId === null ? null : state.visibleProjects.find((project) => project.id === operation.projectId)?.name ?? null;
        item.financeCodeId = null;
        item.financeCode = null;
        item.scopeType = operation.projectId === null ? "department_daily" : "project";
        this.confirm(item);
        receipts.push(`${item.displayAlias} 归入 ${item.projectName ?? "部门日常"}`);
        return;
      }
      case "set_finance_code": {
        const item = this.requireItem(state, operation.itemId);
        if (item.scopeType !== "project" || !item.projectId) {
          throw new AssistantV2Error("invalid_operation", `${item.displayAlias} 不是项目事项，不能设置财务项目编码`, true);
        }
        const code = getFinanceProjectCode(item.projectId, operation.financeCodeId, this.db);
        if (!code) throw new AssistantV2Error("invalid_operation", `${item.displayAlias} 的财务项目编码无效`, true);
        item.financeCodeId = code.id;
        item.financeCode = code.name;
        this.confirm(item);
        receipts.push(`${item.displayAlias} 财务项目编码选择为「${code.name}」`);
        return;
      }
      case "set_status": {
        const item = this.requireItem(state, operation.itemId);
        item.status = operation.status;
        this.confirm(item);
        receipts.push(`${item.displayAlias} 状态改为 ${item.status}`);
        return;
      }
      case "set_blocker": {
        const item = this.requireItem(state, operation.itemId);
        item.blocker = operation.blocker;
        if (operation.nextAction !== undefined) item.nextAction = operation.nextAction;
        if (operation.supportNeeded !== undefined) item.supportNeeded = operation.supportNeeded;
        if (operation.supportPeople !== undefined) item.supportPeople = [...operation.supportPeople];
        if (!item.blocker && item.status === "blocked") item.status = "in_progress";
        this.confirm(item);
        receipts.push(item.blocker ? `${item.displayAlias} 阻塞记为「${item.blocker}」` : `${item.displayAlias} 阻塞已清除`);
        return;
      }
      case "set_next_action": {
        const item = this.requireItem(state, operation.itemId);
        item.nextAction = operation.nextAction;
        this.confirm(item);
        receipts.push(`${item.displayAlias} 下一步记为「${item.nextAction}」`);
        return;
      }
      case "set_support": {
        const item = this.requireItem(state, operation.itemId);
        item.supportNeeded = operation.supportNeeded;
        item.supportPeople = operation.supportPeople ? [...operation.supportPeople] : [];
        if (!item.supportNeeded && !item.supportPeople.length) throw new AssistantV2Error("invalid_operation", "set_support 需要支持内容或支持人", true);
        this.confirm(item);
        receipts.push(`${item.displayAlias} 需要支持：${item.supportNeeded}${item.supportPeople.length ? `（${item.supportPeople.join("、")}）` : ""}`);
        return;
      }
      case "set_tomorrow_plan": {
        const item = this.requireItem(state, operation.itemId);
        item.tomorrowPlan = operation.tomorrowPlan;
        this.confirm(item);
        receipts.push(`${item.displayAlias} 明日计划记为「${item.tomorrowPlan}」`);
        return;
      }
      case "merge_items": {
        const ids = [...new Set(operation.itemIds)];
        if (ids.length < 2) throw new AssistantV2Error("invalid_operation", "merge_items 至少需要两个不同事项", true);
        const items = ids.map((id) => this.requireItem(state, id));
        const keep = items[0];
        keep.summary = operation.summary ? text(operation.summary, "summary") : uniqueParts(items.map((item) => item.summary));
        keep.result = uniqueParts(items.map((item) => item.result));
        keep.hours = items.every((item) => item.hours !== null)
          ? Math.round(items.reduce((sum, item) => sum + Number(item.hours), 0) * 100) / 100
          : null;
        keep.blocker = uniqueParts(items.map((item) => item.blocker));
        keep.nextAction = uniqueParts(items.map((item) => item.nextAction));
        keep.supportNeeded = uniqueParts(items.map((item) => item.supportNeeded));
        keep.supportPeople = [...new Set(items.flatMap((item) => item.supportPeople))];
        keep.tomorrowPlan = uniqueParts(items.map((item) => item.tomorrowPlan));
        const financeCodeIds = new Set(items.map((item) => item.financeCodeId));
        keep.financeCodeId = financeCodeIds.size === 1 ? (items[0].financeCodeId ?? null) : null;
        keep.financeCode = financeCodeIds.size === 1 ? (items[0].financeCode ?? null) : null;
        if (items.some((item) => item.status === "blocked")) keep.status = "blocked";
        this.confirm(keep);
        const removed = new Set(items.slice(1).map((item) => item.itemId));
        state.items = state.items.filter((item) => !removed.has(item.itemId));
        refreshAliases(state);
        receipts.push(`已合并为 ${keep.displayAlias}「${keep.summary}」`);
        return;
      }
      case "split_item": {
        const item = this.requireItem(state, operation.itemId);
        const index = state.items.indexOf(item);
        item.summary = operation.summaries[0];
        item.result = "";
        item.hours = null;
        this.confirm(item);
        const additions = operation.summaries.slice(1).map((summary): AgentDraftItem => ({
          ...cloneAgentState(item),
          recordId: null,
          itemId: newItemId(state),
          summary,
          result: "",
          hours: null,
          origin: "employee",
          sourceKind: "employee",
          referenceIds: [],
        }));
        state.items.splice(index + 1, 0, ...additions);
        refreshAliases(state);
        receipts.push(`${item.displayAlias} 已拆成 ${operation.summaries.length} 项：${operation.summaries.join(" / ")}`);
        return;
      }
      case "confirm_items": {
        const ids = operation.itemIds === "all" ? state.items.map((item) => item.itemId) : [...new Set(operation.itemIds)];
        if (!ids.length) throw new AssistantV2Error("invalid_operation", "confirm_items 需要至少一个事项", true);
        for (const id of ids) this.confirm(this.requireItem(state, id));
        receipts.push(`已确认 ${ids.map((id) => this.requireItem(state, id).displayAlias).join("、")}`);
        return;
      }
      case "mark_no_outside_work":
        state.outsideWorkAsked = true;
        state.outsideWorkAnswered = true;
        receipts.push("已记录：钉钉之外没有其他工作");
    }
  }

  private persistItems(stamp: string): void {
    this.db.prepare("UPDATE assistant_session_items SET deleted = 1, updated_at = ? WHERE session_id = ?").run(stamp, this.state.sessionId);
    for (const item of this.state.items) {
      if (item.recordId === null) {
        const existing = this.db
          .prepare("SELECT id FROM assistant_session_items WHERE session_id = ? AND item_key = ?")
          .get(this.state.sessionId, item.itemId) as { id: number } | undefined;
        if (existing) item.recordId = existing.id;
      }
      if (item.recordId !== null) {
        const result = this.db.prepare(
          `UPDATE assistant_session_items SET
             ord = ?, scope_type = ?, project_id = ?, project_name_snapshot = ?, finance_project_code_id = ?, work_status = ?,
             work_summary = ?, result_text = ?, hours = ?, blocker_text = ?, next_action = ?,
             support_needed = ?, support_people_json = ?, tomorrow_plan = ?, source_kind = ?,
             reference_ids_json = ?, needs_confirmation_json = ?, employee_confirmed = ?,
             source_completeness = ?, candidate_confidence = ?, missing_facts_json = ?,
             candidate_origin = ?, deleted = 0, updated_at = ?
           WHERE id = ? AND session_id = ?`,
        ).run(
          item.order, item.scopeType, item.projectId, item.projectName, item.financeCodeId, item.status, item.summary, item.result,
          item.hours, item.blocker, item.nextAction, item.supportNeeded, JSON.stringify(item.supportPeople),
          item.tomorrowPlan, item.sourceKind, JSON.stringify(item.referenceIds), JSON.stringify(item.needsConfirmation),
          item.confirmed ? 1 : 0, item.sourceCompleteness, item.confidence, JSON.stringify(item.missingFacts),
          item.origin, stamp, item.recordId, this.state.sessionId,
        );
        if (Number(result.changes) !== 1) throw new AssistantV2Error("item_forbidden", `事项 ${item.itemId} 不属于当前会话`);
      } else {
        const result = this.db.prepare(
          `INSERT INTO assistant_session_items
            (session_id, item_key, ord, scope_type, project_id, project_name_snapshot, finance_project_code_id, work_status,
             work_summary, result_text, hours, blocker_text, next_action, support_needed,
             support_people_json, tomorrow_plan, source_kind, reference_ids_json,
             needs_confirmation_json, employee_confirmed, source_completeness, candidate_confidence,
             missing_facts_json, candidate_origin, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(
          this.state.sessionId, item.itemId, item.order, item.scopeType, item.projectId, item.projectName, item.financeCodeId,
          item.status, item.summary, item.result, item.hours, item.blocker, item.nextAction,
          item.supportNeeded, JSON.stringify(item.supportPeople), item.tomorrowPlan, item.sourceKind,
          JSON.stringify(item.referenceIds), JSON.stringify(item.needsConfirmation), item.confirmed ? 1 : 0,
          item.sourceCompleteness, item.confidence, JSON.stringify(item.missingFacts), item.origin, stamp, stamp,
        );
        item.recordId = Number(result.lastInsertRowid);
      }
    }
  }
}
