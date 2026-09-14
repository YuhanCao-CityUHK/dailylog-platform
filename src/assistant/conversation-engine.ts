import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { nowIso } from "../infra/db";
import { getFormalProject, listFormalProjects, ProjectServiceError } from "../projects/service";
import { nextMissingFact } from "./completeness-evaluator";
import type {
  AssistantAction,
  AssistantConversationState,
  AssistantItemPatch,
  AssistantSession,
  AssistantSessionItem,
} from "./conversation-schema";
import type { AssistantMode } from "./conversation-schema";
import type { DailyAssistantCandidate } from "./candidate-service";
import type { WorkItemAnalysisMode } from "./work-item-analysis-service";
import type { ConversationPlannerService } from "./conversation-planner-service";
import { buildAssistantDraft } from "./draft-service";
import { AssistantSessionService } from "./session-service";
import { scrubTaskSignalSecrets, taskSignalSecretFromRow } from "./task-signal-privacy";
import { AssistantValidationError, validateAssistantAction, validatedText } from "./structured-validation";
import { getFinanceProjectCode, listFinanceProjectCodes } from "../platform/finance-project-codes";

const OUTPUT_PATTERN = /(完成|交付|形成|确定|确认|解决|修复|通过|发布|上线|更新|修改|编写|开发|验证|定位|推进|处理|排查|协调)/;
const ORDINALS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };

function ordinal(value: string): number {
  return ORDINALS[value] ?? Number(value);
}

function itemAt(session: AssistantSession, value: string): AssistantSessionItem | undefined {
  const number = ordinal(value);
  const alias = `第 ${number} 项`;
  return session.items.find((item) => item.displayAlias === alias) ?? session.items[number - 1];
}

function uniqueText(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].join("；");
}

function exactVisibleProject(user: SessionUser, name: string, db: DatabaseSync): number | null {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s，。、“”‘’：:；;！？!?（）()【】_\-—]/g, "");
  const wanted = normalize(name.replace(/项目$/, ""));
  const project = listFormalProjects(user, db, true).find((candidate) => normalize(candidate.name) === wanted);
  return project?.id ?? null;
}

function inferredStatus(text: string): AssistantSessionItem["workStatus"] {
  if (/(受阻|阻塞|卡住|等待)/.test(text)) return "blocked";
  if (/(完成|交付|形成|解决|修复|发布|上线|通过)/.test(text)) return "completed";
  if (/(没有进展|无进展)/.test(text)) return "no_progress";
  return "in_progress";
}

function isUnconfirmedTaskSignalRow(item: Record<string, unknown>): boolean {
  return item.source_kind === "candidate"
    && Number(item.employee_confirmed) === 0
    && String(item.needs_confirmation_json ?? "").includes('"task_signal"');
}

function updateSql(patch: AssistantItemPatch): { assignments: string[]; values: unknown[] } {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const columns: Array<[keyof AssistantItemPatch, string, (value: unknown) => unknown]> = [
    ["workSummary", "work_summary", String],
    ["resultText", "result_text", String],
    ["hours", "hours", (value) => value],
    ["workStatus", "work_status", String],
    ["blockerText", "blocker_text", String],
    ["nextAction", "next_action", String],
    ["supportNeeded", "support_needed", String],
    ["supportPeople", "support_people_json", (value) => JSON.stringify(value)],
    ["tomorrowPlan", "tomorrow_plan", String],
  ];
  for (const [key, column, convert] of columns) {
    if (!(key in patch)) continue;
    assignments.push(`${column} = ?`);
    values.push(convert(patch[key]));
  }
  return { assignments, values };
}

export class ConversationEngine {
  private readonly sessions: AssistantSessionService;

  constructor(
    private readonly db: DatabaseSync,
    private readonly planner?: ConversationPlannerService,
    candidateTtlHours = 12,
  ) {
    this.sessions = new AssistantSessionService(db, candidateTtlHours);
  }

  cleanupExpiredTaskSignals(now = new Date()): number {
    return this.sessions.cleanupExpiredTaskSignals(now);
  }

  activeTaskSignalCount(userId: number, workDate: string): number | undefined {
    this.sessions.cleanupExpiredTaskSignals();
    const session = this.db.prepare("SELECT id FROM assistant_sessions WHERE user_id = ? AND work_date = ?")
      .get(userId, workDate) as { id: number } | undefined;
    if (!session) return undefined;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count
         FROM assistant_session_items i
        WHERE i.session_id = ? AND i.deleted = 0
          AND i.employee_confirmed = 0
          AND i.needs_confirmation_json LIKE '%"task_signal"%'`,
    ).get(session.id) as { count: number };
    return Number(row.count);
  }

  ensureSession(
    userId: number,
    workDate: string,
    mode: AssistantMode,
    contextJobId: string | undefined,
    candidates: DailyAssistantCandidate[],
    analysisMode: WorkItemAnalysisMode | "manual" = candidates.length ? "deterministic" : "manual",
  ): AssistantSession {
    return this.sessions.ensure(userId, workDate, mode, contextJobId, candidates, analysisMode);
  }

  state(sessionId: number, userId: number): AssistantConversationState {
    let session = this.sessions.readById(sessionId, userId);
    const missing = nextMissingFact(session, this.db);
    if (missing?.kind === "outside_work" && !session.outsideWorkAsked) {
      this.sessions.markOutsideWorkAsked(session.id);
      session = this.sessions.readById(sessionId, userId);
    }
    if (!missing || session.forceDraft) {
      const draft = buildAssistantDraft(session, this.db);
      return {
        session,
        promptKind: "draft",
        prompt: draft.complete
          ? "信息已经闭环，我已生成完整草稿。你可以继续用自然语言修改；确认无误后再明确说“确认提交”。"
          : "先按现有信息生成了暂定草稿。标注的缺失信息仍需在提交前补齐。",
        draft,
      };
    }
    const aliases = missing.itemIds
      .map((id) => session.items.find((item) => item.id === id)?.displayAlias)
      .filter((value): value is string => Boolean(value))
      .join("、");
    const prompts: Record<typeof missing.kind, string> = {
      confirm_candidates: session.items.some((item) => !item.employeeConfirmed && item.needsConfirmation.includes("task_signal"))
        ? `请先确认${aliases}中哪些是你今天实际处理的。标为任务线索的事项只表示收到了交办或待跟进，尚不能算作今天已完成；也可以删除、合并、拆分或改项目。`
        : session.items.some((item) => !item.employeeConfirmed && item.origin === "continuation")
        ? `请先确认${aliases}是否属于今天；“昨日延续待确认”只有今天实际推进后才会保留。也可以直接删除、合并、拆分或改项目。`
        : `请先确认候选事项是否真实，尤其是${aliases}；也可以直接删除、合并、拆分或改项目。`,
      result: `${aliases}还只有动作线索。今天实际形成了什么结果或当前进展？`,
      person: `${aliases}使用了“同事、领导、他们”等模糊称呼。请补充真实姓名，或明确说明该人员与结果无关。`,
      outside_work: "除了这些，今天还有没有未在钉钉里体现的工作，例如本地文档、代码产出、现场处理、电话沟通或临时支持？",
      project: `${aliases}的项目归属还不确定。请确认应归入哪个可见项目，或明确改为部门日常。`,
      finance_code: `${aliases}还没有选择具体财务项目编码，请从对应项目的财务编码中选择后再继续。`,
      hours: `请补充${aliases}的实际投入工时。工时不会按会议时长或考勤自动推算。`,
      blocked_loop: `${aliases}存在阻塞。下一步准备怎么处理，或需要谁提供什么支持？如果暂时没有方案，可以明确说“待确认方案”。`,
      manual_start: session.mode === "manual"
        ? "今天暂时没有可用上下文。请直接描述今天主要做了什么、形成了什么结果；可以一次说多项。"
        : "我没有从今天的证据中整理出可靠候选；历史已完成内容不会自动带入今天。请直接描述今天主要做了什么、形成了什么结果。",
    };
    return { session, promptKind: missing.kind, prompt: prompts[missing.kind] };
  }

  applyStructured(user: SessionUser, sessionId: number, rawActions: unknown[]): AssistantConversationState {
    const actions = rawActions.map(validateAssistantAction);
    this.applyActions(user, sessionId, actions);
    return this.state(sessionId, user.id);
  }

  async handleMessage(
    user: SessionUser,
    sessionId: number,
    rawMessage: unknown,
    clientMessageId?: string,
  ): Promise<AssistantConversationState> {
    const message = validatedText(rawMessage, "消息", 4000, false);
    const added = this.sessions.addMessage(sessionId, "user", "message", message, {}, clientMessageId);
    if (added.duplicate) return this.state(sessionId, user.id);
    const session = this.sessions.readById(sessionId, user.id);
    let actions = this.parseNaturalLanguage(user, session, message);
    if (actions.length === 0 && this.planner) {
      const projects = listFormalProjects(user, this.db, true).map((project) => ({ id: project.id, name: project.name }));
      actions = (await this.planner.plan({ session, message, projects })) ?? [];
    }
    if (actions.length) this.applyActions(user, sessionId, actions);
    const state = this.state(sessionId, user.id);
    const reply = actions.length
      ? state.prompt
      : `我没有可靠识别出要执行的修改，没有改动草稿。你可以说“第 1 项删掉”“第 1、2 项合并”“第 1 项 2 小时”，或直接补充具体结果。\n\n${state.prompt}`;
    this.sessions.addMessage(sessionId, "assistant", state.promptKind, reply, {
      appliedActions: actions.map((action) => action.type),
      revision: state.session.revision,
    });
    return this.state(sessionId, user.id);
  }

  private requireItem(sessionId: number, itemId: number): Record<string, unknown> {
    const item = this.db
      .prepare("SELECT * FROM assistant_session_items WHERE session_id = ? AND id = ? AND deleted = 0")
      .get(sessionId, itemId) as Record<string, unknown> | undefined;
    if (!item) throw new AssistantValidationError("事项不存在或已删除");
    return item;
  }

  private applyActions(user: SessionUser, sessionId: number, actions: AssistantAction[]): void {
    this.sessions.readById(sessionId, user.id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const action of actions) this.applyAction(user, sessionId, action);
      this.sessions.touch(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyAction(user: SessionUser, sessionId: number, action: AssistantAction): void {
    const stamp = nowIso();
    if (action.type === "confirm") {
      const ids = action.itemIds ?? [];
      if (ids.length) {
        for (const id of ids) this.requireItem(sessionId, id);
        this.db.prepare(
          `UPDATE assistant_session_items SET employee_confirmed = 1, needs_confirmation_json = '[]', missing_facts_json = '[]', updated_at = ?
            WHERE session_id = ? AND deleted = 0 AND id IN (${ids.map(() => "?").join(",")})`,
        ).run(stamp, sessionId, ...(ids as never[]));
      } else {
        this.db.prepare("UPDATE assistant_session_items SET employee_confirmed = 1, needs_confirmation_json = '[]', missing_facts_json = '[]', updated_at = ? WHERE session_id = ? AND deleted = 0").run(
          stamp,
          sessionId,
        );
      }
      return;
    }
    if (action.type === "delete") {
      const item = this.requireItem(sessionId, action.itemId);
      if (isUnconfirmedTaskSignalRow(item)) {
        scrubTaskSignalSecrets(this.db, sessionId, [taskSignalSecretFromRow(item)]);
        this.db.prepare("DELETE FROM assistant_session_items WHERE id = ?").run(action.itemId);
        return;
      }
      this.db.prepare("UPDATE assistant_session_items SET deleted = 1, employee_confirmed = 1, updated_at = ? WHERE id = ?").run(
        stamp,
        action.itemId,
      );
      return;
    }
    if (action.type === "merge") {
      const items = action.itemIds.map((id) => this.requireItem(sessionId, id)).sort((a, b) => Number(a.ord) - Number(b.ord));
      const keep = items[0];
      const projectIds = new Set(items.map((item) => Number(item.project_id) || null));
      const projectId = projectIds.size === 1 ? Number(keep.project_id) || null : null;
      const hours = items.every((item) => item.hours !== null)
        ? Math.round(items.reduce((sum, item) => sum + Number(item.hours), 0) * 100) / 100
        : null;
      const refs = [...new Set(items.flatMap((item) => {
        try { return JSON.parse(String(item.reference_ids_json)) as string[]; } catch { return []; }
      }))];
      this.db.prepare(
        `UPDATE assistant_session_items
            SET scope_type = ?, project_id = ?, project_name_snapshot = ?, work_status = ?,
                work_summary = ?, result_text = ?, hours = ?, blocker_text = ?, next_action = ?,
                support_needed = ?, tomorrow_plan = ?, reference_ids_json = ?, employee_confirmed = 1,
                needs_confirmation_json = '[]', missing_facts_json = '[]', updated_at = ?
          WHERE id = ?`,
      ).run(
        projectId ? "project" : projectIds.size === 1 ? String(keep.scope_type) : "unconfirmed",
        projectId,
        projectId ? String(keep.project_name_snapshot ?? "") : null,
        items.some((item) => item.work_status === "blocked") ? "blocked" : items.every((item) => item.work_status === "completed") ? "completed" : "in_progress",
        uniqueText(items.map((item) => String(item.work_summary))),
        uniqueText(items.map((item) => String(item.result_text))),
        hours,
        uniqueText(items.map((item) => String(item.blocker_text))),
        uniqueText(items.map((item) => String(item.next_action))),
        uniqueText(items.map((item) => String(item.support_needed))),
        uniqueText(items.map((item) => String(item.tomorrow_plan))),
        JSON.stringify(refs),
        stamp,
        Number(keep.id),
      );
      const removedItems = items.slice(1);
      const transientTaskSignals = removedItems.filter(isUnconfirmedTaskSignalRow);
      const softDeleted = removedItems.filter((item) => !isUnconfirmedTaskSignalRow(item)).map((item) => Number(item.id));
      if (softDeleted.length) {
        this.db.prepare(`UPDATE assistant_session_items SET deleted = 1, updated_at = ? WHERE id IN (${softDeleted.map(() => "?").join(",")})`).run(
          stamp,
          ...(softDeleted as never[]),
        );
      }
      if (transientTaskSignals.length) {
        scrubTaskSignalSecrets(this.db, sessionId, transientTaskSignals.map(taskSignalSecretFromRow));
        const hardDelete = this.db.prepare(
          `DELETE FROM assistant_session_items
            WHERE id = ? AND session_id = ? AND source_kind = 'candidate'
              AND employee_confirmed = 0 AND needs_confirmation_json LIKE '%"task_signal"%'`,
        );
        for (const item of transientTaskSignals) {
          const deleted = hardDelete.run(Number(item.id), sessionId);
          if (Number(deleted.changes) !== 1) throw new AssistantValidationError("待确认任务线索未能安全清除，请重试");
        }
      }
      return;
    }
    if (action.type === "split") {
      const source = this.requireItem(sessionId, action.itemId);
      this.db.prepare(
        `UPDATE assistant_session_items SET work_summary = ?, result_text = '', hours = NULL,
          employee_confirmed = 1, needs_confirmation_json = '[]', missing_facts_json = '[]', updated_at = ? WHERE id = ?`,
      ).run(action.summaries[0], stamp, action.itemId);
      for (const summary of action.summaries.slice(1)) {
        this.sessions.insertEmployeeItem(sessionId, {
          itemKey: `employee:${randomUUID()}`,
          scopeType: source.scope_type as AssistantSessionItem["scopeType"],
          projectId: Number(source.project_id) || undefined,
          projectName: String(source.project_name_snapshot ?? "") || undefined,
          workStatus: "in_progress",
          workSummary: summary,
          resultText: "",
          hours: null,
          blockerText: "",
          nextAction: "",
          supportNeeded: "",
          supportPeople: [],
          tomorrowPlan: "",
          sourceKind: "employee",
          referenceIds: [],
          needsConfirmation: ["result", "hours"],
          sourceCompleteness: "complete",
          confidence: 1,
          missingFacts: [],
          employeeConfirmed: true,
          origin: "employee",
        });
      }
      return;
    }
    if (action.type === "assign_project") {
      this.requireItem(sessionId, action.itemId);
      if (action.projectId === null) {
        this.db.prepare(
          "UPDATE assistant_session_items SET scope_type = 'department_daily', project_id = NULL, project_name_snapshot = NULL, finance_project_code_id = NULL, employee_confirmed = 1, needs_confirmation_json = '[]', missing_facts_json = '[]', updated_at = ? WHERE id = ?",
        ).run(stamp, action.itemId);
        return;
      }
      const visible = listFormalProjects(user, this.db, true).some((project) => project.id === action.projectId);
      if (!visible) throw new ProjectServiceError(403, "project_assignment_forbidden", "无权将事项归入该项目");
      const project = getFormalProject(action.projectId, this.db);
      this.db.prepare(
        "UPDATE assistant_session_items SET scope_type = 'project', project_id = ?, project_name_snapshot = ?, finance_project_code_id = NULL, employee_confirmed = 1, needs_confirmation_json = '[]', missing_facts_json = '[]', updated_at = ? WHERE id = ?",
      ).run(project.id, project.name, stamp, action.itemId);
      return;
    }
    if (action.type === "assign_finance_code") {
      const item = this.requireItem(sessionId, action.itemId);
      if (item.scopeType !== "project" || !item.projectId) throw new AssistantValidationError("该事项不是项目工作，不能设置财务项目编码");
      const code = getFinanceProjectCode(Number(item.projectId), Number(action.financeCodeId), this.db);
      if (!code) throw new AssistantValidationError("财务项目编码与该项目不匹配");
      this.db.prepare(
        "UPDATE assistant_session_items SET finance_project_code_id = ?, employee_confirmed = 1, needs_confirmation_json = '[]', missing_facts_json = '[]', updated_at = ? WHERE id = ?",
      ).run(code.id, stamp, action.itemId);
      return;
    }
    if (action.type === "update") {
      this.requireItem(sessionId, action.itemId);
      const update = updateSql(action.patch);
      this.db.prepare(
        `UPDATE assistant_session_items SET ${update.assignments.join(", ")}, employee_confirmed = 1, needs_confirmation_json = '[]', missing_facts_json = '[]', updated_at = ? WHERE id = ?`,
      ).run(...(update.values as never[]), stamp, action.itemId);
      return;
    }
    if (action.type === "add") {
      let projectId: number | undefined;
      let projectName: string | undefined;
      if (action.item.projectId) {
        const visible = listFormalProjects(user, this.db, true).some((project) => project.id === action.item.projectId);
        if (!visible) throw new ProjectServiceError(403, "project_assignment_forbidden", "无权将事项归入该项目");
        const project = getFormalProject(action.item.projectId, this.db);
        projectId = project.id;
        projectName = project.name;
      }
      this.sessions.insertEmployeeItem(sessionId, {
        itemKey: `employee:${randomUUID()}`,
        scopeType: projectId ? "project" : "department_daily",
        projectId,
        projectName,
        financeCodeId: undefined,
        workStatus: action.item.workStatus ?? inferredStatus(`${action.item.workSummary} ${action.item.resultText ?? ""}`),
        workSummary: action.item.workSummary,
        resultText: action.item.resultText ?? "",
        hours: action.item.hours ?? null,
        blockerText: "",
        nextAction: "",
        supportNeeded: "",
        supportPeople: [],
        tomorrowPlan: "",
        sourceKind: "employee",
        referenceIds: [],
        needsConfirmation: [],
        sourceCompleteness: "complete",
        confidence: 1,
        missingFacts: [],
        employeeConfirmed: true,
        origin: "employee",
      });
      return;
    }
    if (action.type === "outside_work_answered") {
      this.sessions.markOutsideWorkAnswered(sessionId);
      return;
    }
    this.sessions.markForceDraft(sessionId);
  }

  private parseNaturalLanguage(user: SessionUser, session: AssistantSession, message: string): AssistantAction[] {
    const actions: AssistantAction[] = [];
    const actionKeys = new Set<string>();
    const push = (action: AssistantAction) => {
      const key = JSON.stringify(action);
      if (!actionKeys.has(key)) { actionKeys.add(key); actions.push(action); }
    };

    if (/(先生成|生成|看一下).{0,4}(草稿|这版)/.test(message)) push({ type: "force_draft" });
    if (/(都对|都没问题|基本准确|候选.{0,4}(正确|没问题)|这些.{0,4}(都做了|都保留|基本准确))/.test(message)) push({ type: "confirm" });

    const codeOrdinal = message.match(/第\s*([一二三四五六七八\d]+)\s*项/);
    if (codeOrdinal) {
      const item = itemAt(session, codeOrdinal[1]);
      if (item?.projectId) {
        const code = listFinanceProjectCodes(item.projectId, this.db).find((candidate) => message.includes(candidate.name));
        if (code) push({ type: "assign_finance_code", itemId: item.id, financeCodeId: code.id });
      }
    }
    const confirmOneRe = /第\s*([一二三四五六七八\d]+)\s*项.{0,8}(?:是对的|正确|保留|确实做了)/g;
    for (const match of message.matchAll(confirmOneRe)) {
      const item = itemAt(session, match[1]);
      if (item) push({ type: "confirm", itemIds: [item.id] });
    }

    const merge = message.match(/第\s*([一二三四五六七八\d]+)\s*项\s*(?:和|、|与)\s*第?\s*([一二三四五六七八\d]+)\s*项.{0,8}合并|合并.{0,8}第\s*([一二三四五六七八\d]+)\s*项.{0,6}第\s*([一二三四五六七八\d]+)\s*项/);
    if (merge) {
      const first = itemAt(session, merge[1] || merge[3]);
      const second = itemAt(session, merge[2] || merge[4]);
      if (first && second) push({ type: "merge", itemIds: [first.id, second.id] });
    }

    const split = message.match(/(?:把)?第\s*([一二三四五六七八\d]+)\s*项.{0,6}拆成\s*(.+)/);
    if (split) {
      const item = itemAt(session, split[1]);
      const summaries = split[2].replace(/[。；;]$/, "").split(/(?:、|，|；|;|和|以及)/).map((value) => value.trim()).filter(Boolean);
      if (item && summaries.length >= 2) push({ type: "split", itemId: item.id, summaries });
    }
    const splitSingle = message.match(/(?:把)?(?:这项|这个任务).{0,6}拆成\s*(.+)/);
    if (splitSingle && session.items.length === 1) {
      const summaries = splitSingle[1].replace(/[。；;]$/, "").split(/(?:、|，|；|;|和|以及)/).map((value) => value.trim()).filter(Boolean);
      if (summaries.length >= 2) push({ type: "split", itemId: session.items[0].id, summaries });
    }

    const deleteRe = /第\s*([一二三四五六七八\d]+)\s*项[^。；;]{0,30}(?:删掉|删除|不是今天做|今天没有做|不要单独算)/g;
    for (const match of message.matchAll(deleteRe)) {
      const item = itemAt(session, match[1]);
      if (item) push({ type: "delete", itemId: item.id });
    }

    const hoursRe = /第\s*([一二三四五六七八\d]+)\s*项[^，。；;\d]{0,30}(\d+(?:\.\d+)?)\s*(?:个)?小时/g;
    for (const match of message.matchAll(hoursRe)) {
      const item = itemAt(session, match[1]);
      if (item) push(validateAssistantAction({ type: "update", itemId: item.id, patch: { hours: Number(match[2]) } }));
    }

    const projectRe = /第\s*([一二三四五六七八\d]+)\s*项.{0,20}(?:属于|归到|改到)\s*([^，。；;]{2,60}?)(?:项目)?(?:[，。；;]|$)/g;
    for (const match of message.matchAll(projectRe)) {
      const item = itemAt(session, match[1]);
      const name = match[2].replace(/项目$/, "").trim();
      if (!item) continue;
      if (/部门日常/.test(name)) push({ type: "assign_project", itemId: item.id, projectId: null });
      else {
        const projectId = exactVisibleProject(user, name, this.db);
        if (projectId) push({ type: "assign_project", itemId: item.id, projectId });
      }
    }

    const resultRe = /第\s*([一二三四五六七八\d]+)\s*项.{0,12}(?:结果是|结果为|结果：|进展是|改成)\s*([^。；;]+)(?:[。；;]|$)/g;
    for (const match of message.matchAll(resultRe)) {
      const item = itemAt(session, match[1]);
      if (item) push(validateAssistantAction({ type: "update", itemId: item.id, patch: { resultText: match[2] } }));
    }

    const noProgressRe = /第\s*([一二三四五六七八\d]+)\s*项[^。；;]*(?:没有进展|无进展)/g;
    for (const match of message.matchAll(noProgressRe)) {
      const item = itemAt(session, match[1]);
      if (!item) continue;
      if (/(排查|协调|阻塞|卡点|处理)/.test(match[0])) {
        push({ type: "update", itemId: item.id, patch: { workStatus: "no_progress", resultText: match[0].trim() } });
      } else push({ type: "delete", itemId: item.id });
    }
    if (session.items.length === 1 && /(?:这项|这个任务).*(?:没有进展|无进展)/.test(message)) {
      if (/(排查|协调|阻塞|卡点|处理)/.test(message)) {
        push({ type: "update", itemId: session.items[0].id, patch: { workStatus: "no_progress", resultText: message } });
      } else push({ type: "delete", itemId: session.items[0].id });
    }

    if (/(问题|阻塞).{0,8}(已经|已)?解决.{0,12}(删掉|删除)?阻塞|删掉阻塞部分/.test(message)) {
      const target = session.items.length === 1 ? session.items : session.items.filter((item) => item.blockerText);
      for (const item of target) push({ type: "update", itemId: item.id, patch: { blockerText: "", supportNeeded: "" } });
    }
    const tomorrow = message.match(/(?:补上|增加|明日计划(?:是|：)?)[^。；;]*明天(?:要|计划)?\s*([^。；;]+)/);
    if (tomorrow && session.items.length === 1) push({ type: "update", itemId: session.items[0].id, patch: { tomorrowPlan: tomorrow[1] } });

    if (session.items.length === 1) {
      const directResult = message.match(/^(?:结果(?:是|为|：)|进展(?:是|为|：))\s*(.+)$/);
      if (directResult) push({ type: "update", itemId: session.items[0].id, patch: { resultText: directResult[1] } });
      else if (nextMissingFact(session, this.db)?.kind === "result" && OUTPUT_PATTERN.test(message) && !/(还漏了|补充|还有)/.test(message)) {
        push({ type: "update", itemId: session.items[0].id, patch: { resultText: message, workStatus: inferredStatus(message) } });
      }
      const nextAction = message.match(/(?:下一步|解决方向|准备)(?:是|为|：)?\s*([^。；;]+)/);
      if (nextAction) push({ type: "update", itemId: session.items[0].id, patch: { nextAction: nextAction[1] } });
      const support = message.match(/(?:需要|请)([^。；;]{1,30})(?:支持|协助)\s*([^。；;]*)/);
      if (support) push({ type: "update", itemId: session.items[0].id, patch: { supportNeeded: `${support[1]}支持${support[2]}`.trim() } });
      const projectSingle = message.match(/(?:这项|这个任务).{0,12}(?:属于|归到|改到)\s*([^，。；;]{2,60}?)(?:项目)?(?:[，。；;]|$)/);
      if (projectSingle) {
        const name = projectSingle[1].replace(/项目$/, "").trim();
        const projectId = exactVisibleProject(user, name, this.db);
        if (/部门日常/.test(name)) push({ type: "assign_project", itemId: session.items[0].id, projectId: null });
        else if (projectId) push({ type: "assign_project", itemId: session.items[0].id, projectId });
      }
    }

    const oneItemHours = message.match(/(?:实际|只|共|投入|用了)[^\d]{0,6}(\d+(?:\.\d+)?)\s*(?:个)?小时/);
    if (oneItemHours && session.items.length === 1 && !hoursRe.test(message)) {
      push(validateAssistantAction({ type: "update", itemId: session.items[0].id, patch: { hours: Number(oneItemHours[1]) } }));
    }

    const outsideNo = /(没有了|没有其他|没有遗漏|没有未体现|除此之外没有|就这些)/.test(message);
    if (outsideNo) push({ type: "outside_work_answered" });

    const addMatch = message.match(/(?:还漏了|补充(?:一项)?|还有(?:一项)?)(?:没有在钉钉里体现的)?\s*[：:]?\s*(.+)/);
    if (addMatch) {
      const chunks = addMatch[1].split(/[；;\n]+/).map((value) => value.trim()).filter(Boolean).slice(0, 8);
      for (const chunk of chunks) {
        const hours = chunk.match(/(\d+(?:\.\d+)?)\s*(?:个)?小时/);
        const summary = chunk.replace(/(?:投入|用了|共)?\s*\d+(?:\.\d+)?\s*(?:个)?小时/g, "").trim();
        push(validateAssistantAction({
          type: "add",
          item: {
            workSummary: summary,
            resultText: OUTPUT_PATTERN.test(summary) ? summary : "",
            hours: hours ? Number(hours[1]) : null,
            workStatus: inferredStatus(summary),
          },
        }));
      }
      if (session.outsideWorkAsked) push({ type: "outside_work_answered" });
    }

    if (session.items.length === 0 && !actions.some((action) => action.type === "add")) {
      const chunks = message.split(/[；;\n]+/).map((value) => value.trim()).filter(Boolean).slice(0, 8);
      for (const chunk of chunks) {
        const hours = chunk.match(/(\d+(?:\.\d+)?)\s*(?:个)?小时/);
        const summary = chunk.replace(/(?:投入|用了|共)?\s*\d+(?:\.\d+)?\s*(?:个)?小时/g, "").trim();
        if (!summary || outsideNo) continue;
        push(validateAssistantAction({
          type: "add",
          item: {
            workSummary: summary,
            resultText: OUTPUT_PATTERN.test(summary) ? summary : "",
            hours: hours ? Number(hours[1]) : null,
            workStatus: inferredStatus(summary),
          },
        }));
      }
    }
    return actions;
  }
}
