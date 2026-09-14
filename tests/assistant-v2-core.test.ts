import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../src/auth/types";
import { AssistantSessionService } from "../src/assistant/session-service";
import { todayYmd } from "../src/infra/workcal";
import { createFormalProject } from "../src/projects/service";
import { AssistantV2DraftTransaction } from "../src/assistant-v2/draft-transaction";
import { DailyAssistantV2Harness } from "../src/assistant-v2/harness";
import { assertSnapshotModel, type AssistantModelProvider, type ProviderCallInput, type ProviderResponse } from "../src/assistant-v2/provider-adapter";
import { parseReplyArguments } from "../src/assistant-v2/schema";
import { AssistantV2StateRepository } from "../src/assistant-v2/state-repository";
import { AssistantV2Error } from "../src/assistant-v2/types";
import { projectDraftGaps } from "../src/assistant-v2/gap-projection";
import { ensureFinanceProjectCodeTable } from "../src/platform/finance-project-codes";
import { addUser, createMigratedFixtureDb } from "./helpers";

function setup() {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "V2员工", role: "lead", dept: "研发部" });
  const user: SessionUser = {
    id: userId,
    kind: "dingtalk",
    ddUserid: "v2-user",
    name: "V2员工",
    title: "",
    dept: "研发部",
    role: "lead",
    isExternal: false,
    mustChangePw: false,
  };
  const project = createFormalProject(user, { name: "V2测试项目" }, db);
  ensureFinanceProjectCodeTable(db);
  const financeCode = db
    .prepare("INSERT INTO finance_project_codes (project_id, code, name) VALUES (?, ?, ?)")
    .run(project.id, "TEST-V2", "TEST-V2 测试编码");
  const sessions = new AssistantSessionService(db);
  const session = sessions.ensure(user.id, todayYmd(), "complete", undefined, [], "manual");
  const stamp = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO assistant_session_items
      (session_id, item_key, ord, scope_type, project_id, project_name_snapshot, work_status,
       work_summary, result_text, hours, blocker_text, next_action, support_needed,
       support_people_json, tomorrow_plan, source_kind, reference_ids_json,
       needs_confirmation_json, employee_confirmed, candidate_origin, created_at, updated_at)
     VALUES (?, ?, ?, 'unconfirmed', NULL, NULL, 'in_progress', ?, '', NULL, '', '', '', '[]', '',
             'candidate', '[]', '["today","result","hours","project"]', 0, 'today', ?, ?)`,
  );
  insert.run(session.id, "wi_01", 1, "日报助手内核", stamp, stamp);
  insert.run(session.id, "wi_02", 2, "第二事项", stamp, stamp);
  return { db, user, project, financeCodeId: Number(financeCode.lastInsertRowid), sessions, sessionId: session.id };
}

function projectedCandidate(
  candidateId: string,
  title: string,
  project: { id: number; name: string },
) {
  return {
    candidateId,
    title,
    workSummary: title,
    resultHint: "",
    referenceIds: [],
    sourceTypes: ["document"] as const,
    needsConfirmation: ["today", "result", "hours", "project"],
    scopeType: "project" as const,
    selectedProjectId: project.id,
    selectedProjectName: project.name,
    projectCandidates: [{ projectId: project.id, projectName: project.name, score: 1, reason: "测试" }],
    groupKey: `project:${project.id}`,
    groupLabel: project.name,
    origin: "today" as const,
    confidence: 0.9,
    sourceCompleteness: "complete" as const,
    missingFacts: ["today", "result", "hours", "project"],
    candidateKind: "work_event" as const,
  };
}

function userMessage(
  db: DatabaseSync,
  sessions: AssistantSessionService,
  sessionId: number,
  content: string,
  focus: unknown = null,
): number {
  sessions.addMessage(sessionId, "assistant", "test_focus", "上一轮问题", {}, undefined);
  const assistant = db.prepare("SELECT id FROM assistant_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as { id: number };
  db.prepare("UPDATE assistant_messages SET focus_json = ? WHERE id = ?").run(JSON.stringify(focus), assistant.id);
  return sessions.addMessage(sessionId, "user", "test_user", content, {}, `m-${Date.now()}-${Math.random()}`).id;
}

test("V2 草稿事务覆盖 15 种操作并生成可撤销变更账本", () => {
  const { db, user, project, sessions, sessionId } = setup();
  const source = userMessage(db, sessions, sessionId, "补全日报");
  const transaction = new AssistantV2DraftTransaction(db, user, source, "补全日报");
  transaction.applyPatch({
    expectedRevision: 0,
    operations: [
      { op: "update_summary", itemId: "wi_01", summary: "日报助手 V2 内核" },
      { op: "set_result", itemId: "wi_01", result: "完成原子事务" },
      { op: "set_hours", itemId: "wi_01", hours: 3 },
      { op: "set_project", itemId: "wi_01", projectId: project.id },
      { op: "set_status", itemId: "wi_01", status: "blocked" },
      { op: "set_blocker", itemId: "wi_01", blocker: "等待接口", nextAction: "明早联调" },
      { op: "set_next_action", itemId: "wi_01", nextAction: "完成联调" },
      { op: "set_support", itemId: "wi_01", supportNeeded: "接口确认", supportPeople: ["张三"] },
      { op: "set_tomorrow_plan", itemId: "wi_01", tomorrowPlan: "验证会议纪要" },
      { op: "confirm_items", itemIds: ["wi_02"] },
      { op: "mark_no_outside_work" },
    ],
  });
  transaction.applyPatch({ expectedRevision: 1, operations: [{ op: "add_item", summary: "新增事项", result: "已完成", hours: 1, projectId: null }] });
  const addedId = transaction.state.items.at(-1)!.itemId;
  transaction.applyPatch({ expectedRevision: 2, operations: [{ op: "split_item", itemId: addedId, summaries: ["拆分甲", "拆分乙"] }] });
  const splitIds = transaction.state.items.filter((item) => item.summary.startsWith("拆分")).map((item) => item.itemId);
  transaction.applyPatch({ expectedRevision: 3, operations: [{ op: "merge_items", itemIds: splitIds, summary: "重新合并" }] });
  transaction.applyPatch({ expectedRevision: 4, operations: [{ op: "delete_item", itemId: "wi_02", reason: "不属于今天" }] });
  transaction.commit();

  const state = new AssistantV2StateRepository(db).read(user, sessionId);
  assert.equal(state.revision, 5);
  assert.equal(state.outsideWorkAnswered, true);
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].summary, "日报助手 V2 内核");
  assert.equal(state.items[0].projectId, project.id);
  assert.equal(state.items[0].tomorrowPlan, "验证会议纪要");
  assert.equal(state.items[1].summary, "重新合并");
  assert.equal((db.prepare("SELECT COUNT(*) AS value FROM assistant_changes WHERE session_id = ?").get(sessionId) as { value: number }).value, 5);

  const undoSource = userMessage(db, sessions, sessionId, "撤销");
  const undo = new AssistantV2DraftTransaction(db, user, undoSource, "撤销");
  undo.undo();
  undo.commit();
  const restored = new AssistantV2StateRepository(db).read(user, sessionId);
  assert.equal(restored.items.some((item) => item.itemId === "wi_02"), true);
  assert.equal(restored.revision, 6);
  db.close();
});

test("无效项目使整组 patch 原子失败，revision 和事项均不变化", () => {
  const { db, user, sessions, sessionId } = setup();
  const source = userMessage(db, sessions, sessionId, "修改结果并归项目");
  const transaction = new AssistantV2DraftTransaction(db, user, source, "修改结果并归项目");
  assert.throws(
    () => transaction.applyPatch({
      expectedRevision: 0,
      operations: [
        { op: "set_result", itemId: "wi_01", result: "不应落库" },
        { op: "set_project", itemId: "wi_01", projectId: 999999 },
      ],
    }),
    AssistantV2Error,
  );
  const state = new AssistantV2StateRepository(db).read(user, sessionId);
  assert.equal(state.revision, 0);
  assert.equal(state.items[0].result, "");
  assert.throws(
    () => transaction.applyPatch({ expectedRevision: 2, operations: [{ op: "set_hours", itemId: "wi_01", hours: 1 }] }),
    /revision 冲突/,
  );
  db.close();
});

test("提交授权只接受 submit focus 下的肯定答复", () => {
  const { db, user, project, financeCodeId, sessions, sessionId } = setup();
  db.prepare(
    `UPDATE assistant_session_items SET scope_type = 'project', project_id = ?, project_name_snapshot = ?,
       finance_project_code_id = ?, result_text = '完成', hours = 2, employee_confirmed = 1, needs_confirmation_json = '[]'
     WHERE session_id = ?`,
  ).run(project.id, project.name, financeCodeId, sessionId);
  db.prepare("UPDATE assistant_sessions SET outside_work_asked = 1, outside_work_answered = 1 WHERE id = ?").run(sessionId);

  const unauthorizedSource = userMessage(db, sessions, sessionId, "好的", { itemId: "wi_01", field: "hours", questionKind: "ask_missing" });
  const unauthorized = new AssistantV2DraftTransaction(db, user, unauthorizedSource, "好的");
  assert.throws(() => unauthorized.prepareSubmission(), /没有结构化提交授权/);

  const focusedSource = userMessage(db, sessions, sessionId, "好的", { itemId: null, field: "submit", questionKind: "confirm_submit" });
  const focused = new AssistantV2DraftTransaction(db, user, focusedSource, "好的");
  assert.equal(Boolean(focused.prepareSubmission().preparedHash), true);

  const explicitSource = userMessage(db, sessions, sessionId, "可以交了");
  const explicit = new AssistantV2DraftTransaction(db, user, explicitSource, "可以交了");
  assert.throws(() => explicit.prepareSubmission(), /没有结构化提交授权/);

  const explicitAfterFocusSource = userMessage(db, sessions, sessionId, "确认提交", { itemId: null, field: "submit", questionKind: "confirm_submit" });
  const explicitAfterFocus = new AssistantV2DraftTransaction(db, user, explicitAfterFocusSource, "确认提交");
  assert.equal(Boolean(explicitAfterFocus.prepareSubmission().preparedHash), true);
  db.close();
});

class SequenceProvider implements AssistantModelProvider {
  readonly model = "qwen3.7-max-2026-06-08";
  private index = 0;
  constructor(private readonly responses: ProviderResponse[]) {}
  async call(_input: ProviderCallInput): Promise<ProviderResponse> {
    return this.responses[this.index++] ?? this.responses.at(-1)!;
  }
}

function response(toolCalls: ProviderResponse["toolCalls"]): ProviderResponse {
  return { content: "", toolCalls, finishReason: "tool_calls", usage: { prompt: 0, completion: 0, cached: 0 } };
}

function call(id: string, name: string, args: unknown) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

test("Harness 同批先写后 reply，并对重复 clientMessageId 返回同一结果", async () => {
  const { db, user, sessions, sessionId } = setup();
  const provider = new SequenceProvider([
    response([
      call("p1", "apply_draft_patch", { expectedRevision: 0, operations: [{ op: "set_hours", itemId: "wi_01", hours: 2 }] }),
      call("r1", "reply", { message: "还需要补充什么吗？", focus: JSON.stringify({ itemId: null, field: "outside_work", questionKind: "ask_missing" }) }),
    ]),
  ]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider });
  const first = await harness.handleTurn(user, sessionId, "第一项 2 小时", "client-1");
  assert.equal(first.revision, 1);
  assert.equal(first.focus?.field, "outside_work");
  assert.equal(first.receipts.length, 1);
  const replay = await harness.handleTurn(user, sessionId, "第一项 2 小时", "client-1");
  assert.deepEqual(replay, first);
  assert.equal(new AssistantV2StateRepository(db).read(user, sessionId).items[0].hours, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS value FROM assistant_changes").get() as { value: number }).value, 1);
  sessions.readById(sessionId, user.id);
  db.close();
});

test("V2 持久工具轨迹只记录证据数量和投影版本，不复制证据正文或事项标题", async () => {
  const { db, user, sessionId } = setup();
  const rawEvidence = "只能在本轮模型上下文出现的客户私聊原句";
  const rawReference = "raw-private-reference-001";
  const provider = new SequenceProvider([
    response([
      call("e1", "find_work_evidence", { query: "客户进展" }),
      call("s1", "get_report_state", {}),
      call("r1", "reply", {
        message: "请继续补充第一项结果。",
        focus: { itemId: "wi_01", field: "result", questionKind: "ask_missing" },
      }),
    ]),
  ]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider }, {
    findEvidence: async () => [{ rawText: rawEvidence, referenceId: rawReference }],
  });
  await harness.handleTurn(user, sessionId, "帮我再查一下", "trace-metadata-only");
  const row = db.prepare(
    "SELECT tool_trace_json FROM assistant_messages WHERE session_id = ? AND kind = 'agent_v2_reply' ORDER BY id DESC LIMIT 1",
  ).get(sessionId) as { tool_trace_json: string };
  assert.doesNotMatch(row.tool_trace_json, new RegExp(rawEvidence));
  assert.doesNotMatch(row.tool_trace_json, new RegExp(rawReference));
  assert.doesNotMatch(row.tool_trace_json, /日报助手内核|第二事项/);
  const trace = JSON.parse(row.tool_trace_json) as Array<{ tool: string; summary: string }>;
  assert.deepEqual(JSON.parse(trace.find((entry) => entry.tool === "find_work_evidence")?.summary ?? "{}"), { evidenceCount: 1 });
  assert.deepEqual(JSON.parse(trace.find((entry) => entry.tool === "get_report_state")?.summary ?? "{}"), { revision: 0 });
  db.close();
});

test("Harness 只允许一次 Schema 修复，失败回合不提交已暂存写入", async () => {
  const { db, user, sessionId } = setup();
  const repairProvider = new SequenceProvider([
    response([call("r-bad", "reply", { message: "请补充结果？", focus: { itemId: "wi_01", field: "bad_field", questionKind: "clarify" } })]),
    response([call("r-good", "reply", { message: "请补充结果？", focus: { itemId: "wi_01", field: "result", questionKind: "ask_missing" } })]),
  ]);
  const repaired = await new DailyAssistantV2Harness(db, { primary: repairProvider, backup: repairProvider })
    .handleTurn(user, sessionId, "继续", "repair-1");
  assert.equal(repaired.focus?.field, "result");
  assert.equal(repaired.revision, 0);

  const failingProvider = new SequenceProvider([
    response([
      call("p-stage", "apply_draft_patch", { expectedRevision: 0, operations: [{ op: "set_hours", itemId: "wi_01", hours: 9 }] }),
      call("r-stage-bad", "reply", { message: "继续？", focus: { itemId: "wi_01", field: "invalid", questionKind: "clarify" } }),
    ]),
    { content: "纯文本结束", toolCalls: [], finishReason: "stop", usage: { prompt: 0, completion: 0, cached: 0 } },
  ]);
  await assert.rejects(
    new DailyAssistantV2Harness(db, { primary: failingProvider, backup: failingProvider })
      .handleTurn(user, sessionId, "九小时", "rollback-1"),
    /没有调用 reply/,
  );
  const state = new AssistantV2StateRepository(db).read(user, sessionId);
  assert.equal(state.revision, 0);
  assert.equal(state.items[0].hours, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS value FROM assistant_changes").get() as { value: number }).value, 0);
  db.close();
});

test("Provider focus 传输归一化后仍严格校验，生产拒绝浮动模型名", () => {
  const reply = parseReplyArguments(JSON.stringify({
    message: "要现在提交吗？",
    focus: JSON.stringify({ itemId: null, field: "submit", questionKind: "confirm_submit" }),
  }));
  assert.equal(reply.normalizedStringFocus, true);
  assert.equal(reply.focus?.field, "submit");
  assert.throws(() => parseReplyArguments(JSON.stringify({ message: "继续吗？", focus: "not-json" })), AssistantV2Error);
  assert.throws(() => assertSnapshotModel("qwen3.8-max"), AssistantV2Error);
  assert.doesNotThrow(() => assertSnapshotModel("qwen3.7-max-2026-06-08"));
});

test("提交授权只看结构（上一轮 submit 焦点），不做原话白名单匹配", () => {
  const { db, user, project, financeCodeId, sessions, sessionId } = setup();
  db.prepare(
    `UPDATE assistant_session_items SET scope_type = 'project', project_id = ?, project_name_snapshot = ?,
       finance_project_code_id = ?, result_text = '完成', hours = 2, employee_confirmed = 1, needs_confirmation_json = '[]'
     WHERE session_id = ?`,
  ).run(project.id, project.name, financeCodeId, sessionId);
  db.prepare("UPDATE assistant_sessions SET outside_work_asked = 1, outside_work_answered = 1 WHERE id = ?").run(sessionId);
  const submitFocus = { itemId: null, field: "submit", questionKind: "confirm_submit" };

  // V1 的精确匹配会拒绝这些口语；结构化授权只要上一轮问过“要提交吗”就交给模型判断肯定/否定
  for (const phrase of ["嗯，交了吧", "行行行", "OK 提交", "可以，就这版"]) {
    const source = userMessage(db, sessions, sessionId, phrase, submitFocus);
    const transaction = new AssistantV2DraftTransaction(db, user, source, phrase);
    assert.equal(Boolean(transaction.prepareSubmission().preparedHash), true, phrase);
  }
  // 没有 submit 焦点时，哪怕原话是标准的“确认提交”也不能提交
  const noFocus = userMessage(db, sessions, sessionId, "确认提交", { itemId: "wi_01", field: "hours", questionKind: "ask_missing" });
  assert.throws(() => new AssistantV2DraftTransaction(db, user, noFocus, "确认提交").prepareSubmission(), /没有结构化提交授权/);
  db.close();
});

test("同一轮既修改草稿又提交会被事务层拒绝", () => {
  const { db, user, project, financeCodeId, sessions, sessionId } = setup();
  db.prepare(
    `UPDATE assistant_session_items SET scope_type = 'project', project_id = ?, project_name_snapshot = ?,
       finance_project_code_id = ?, result_text = '完成', hours = 2, employee_confirmed = 1, needs_confirmation_json = '[]'
     WHERE session_id = ?`,
  ).run(project.id, project.name, financeCodeId, sessionId);
  db.prepare("UPDATE assistant_sessions SET outside_work_asked = 1, outside_work_answered = 1 WHERE id = ?").run(sessionId);
  const source = userMessage(db, sessions, sessionId, "第一项改成3小时，然后提交", { itemId: null, field: "submit", questionKind: "confirm_submit" });
  const transaction = new AssistantV2DraftTransaction(db, user, source, "第一项改成3小时，然后提交");
  const prepared = transaction.prepareSubmission();
  transaction.applyPatch({ expectedRevision: transaction.state.revision, operations: [{ op: "set_hours", itemId: "wi_01", hours: 3 }] });
  assert.throws(() => transaction.requestSubmit(prepared.preparedHash, source), /同一轮不能既修改草稿又提交/);
  db.close();
});

test("V2 项目未配置财务编码时不产生提交缺口", () => {
  const { db, user, project, sessions, sessionId } = setup();
  db.prepare("DELETE FROM finance_project_codes WHERE project_id = ?").run(project.id);
  db.prepare(
    `UPDATE assistant_session_items SET scope_type = 'project', project_id = ?, project_name_snapshot = ?,
       finance_project_code_id = NULL, result_text = '完成', hours = 2, employee_confirmed = 1, needs_confirmation_json = '[]'
     WHERE session_id = ?`,
  ).run(project.id, project.name, sessionId);
  db.prepare("UPDATE assistant_sessions SET outside_work_asked = 1, outside_work_answered = 1 WHERE id = ?").run(sessionId);

  const state = new AssistantV2StateRepository(db).read(user, sessionId);
  assert.equal(state.financeCodes[String(project.id)].length, 0);
  assert.equal(projectDraftGaps(state).some((gap) => gap.field === "finance_code"), false);

  const source = userMessage(db, sessions, sessionId, "确认提交", { itemId: null, field: "submit", questionKind: "confirm_submit" });
  const transaction = new AssistantV2DraftTransaction(db, user, source, "确认提交");
  const prepared = transaction.prepareSubmission();
  assert.equal(Boolean(prepared.preparedHash), true);
  db.close();
});

test("模型上下文带着真实回执：历史回复前缀【已执行】，最近变更显示回执而不是 op 名", async () => {
  const { db, user, sessionId } = setup();
  const provider = new SequenceProvider([
    response([
      call("p1", "apply_draft_patch", { expectedRevision: 0, operations: [{ op: "delete_item", itemId: "wi_02", reason: "昨天已完成" }] }),
      call("r1", "reply", { message: "第 1 项今天形成了什么结果？", focus: { itemId: "wi_01", field: "result", questionKind: "ask_missing" } }),
    ]),
    response([call("r2", "reply", { message: "好的，还有别的吗？", focus: { itemId: null, field: "outside_work", questionKind: "ask_missing" } })]),
  ]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider });
  const first = await harness.handleTurn(user, sessionId, "第二个昨天做完了", "ctx-1");
  assert.match(first.receipts[0].text, /已删除 第 2 项/);
  const nextSource = db.prepare("SELECT MAX(id) AS id FROM assistant_messages").get() as { id: number };
  const state = new AssistantV2StateRepository(db).read(user, sessionId, nextSource.id + 1);
  assert.equal(state.recentChanges.length, 1);
  assert.match(state.recentChanges[0].summary, /已删除 第 2 项「第二事项」（昨天已完成）/);
  const lastAssistant = state.history.filter((entry) => entry.role === "assistant").at(-1);
  assert.match(lastAssistant?.content ?? "", /^【已执行】已删除 第 2 项/);
  assert.match(lastAssistant?.content ?? "", /第 1 项今天形成了什么结果/);
  await harness.handleTurn(user, sessionId, "验证通过了", "ctx-2");
  db.close();
});

test("模型失败时不清空上一轮焦点，员工重说一遍仍能对上", async () => {
  const { db, user, sessionId } = setup();
  const provider = new SequenceProvider([
    response([call("r1", "reply", { message: "第 1 项实际投入了多少时间？", focus: { itemId: "wi_01", field: "hours", questionKind: "ask_missing" } })]),
    { content: "纯文本，违反契约", toolCalls: [], finishReason: "stop", usage: { prompt: 0, completion: 0, cached: 0 } },
  ]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider });
  const asked = await harness.handleTurn(user, sessionId, "都对", "focus-1");
  assert.equal(asked.focus?.field, "hours");
  await assert.rejects(harness.handleTurn(user, sessionId, "1h", "focus-2"), /没有调用 reply/);
  const nextSource = db.prepare("SELECT MAX(id) AS id FROM assistant_messages").get() as { id: number };
  const state = new AssistantV2StateRepository(db).read(user, sessionId, nextSource.id + 1);
  assert.equal(state.lastFocus?.field, "hours");
  const failure = db.prepare("SELECT content FROM assistant_messages WHERE kind = 'agent_v2_error' ORDER BY id DESC LIMIT 1").get() as { content: string };
  assert.match(failure.content, /没有修改草稿/);
  db.close();
});

test("开场消息由系统按投影生成，会话视图只含 V2 消息并带权威草稿", () => {
  const { db, user, sessions, sessionId } = setup();
  sessions.addMessage(sessionId, "assistant", "result", "旧内核：我没有可靠识别出要执行的修改", {}, undefined);
  const provider = new SequenceProvider([]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider }, {
    sourceStatus: () => ({ read: ["待办"], unavailable: ["文档"], reading: [] }),
  });
  const view = harness.readConversation(user, sessionId);
  assert.equal(view.engine, "v2");
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].kind, "agent_v2_opening");
  assert.match(view.messages[0].text, /整理出 2 项工作/);
  assert.match(view.messages[0].text, /文档暂时没读到/);
  assert.equal(view.messages[0].focus?.field, "today");
  assert.deepEqual(view.options, ["都是今天的", "有几项不对", "还有别的工作"]);
  assert.equal(view.draft.items.length, 2);
  assert.equal(view.draft.canSubmit, false);
  assert.equal(view.draft.items[0].displayAlias, "第 1 项");
  // 重复读取不会再生成第二条开场
  assert.equal(harness.readConversation(user, sessionId).messages.length, 1);
  db.close();
});

test("V2 已有对话时刷新 context 会追加权威同步提示并使用新候选数量", () => {
  const { db, user, project, sessions, sessionId } = setup();
  sessions.ensure(user.id, todayYmd(), "complete", "job-old", [
    projectedCandidate("wi_01", "日报助手内核", project),
    projectedCandidate("wi_02", "第二事项", project),
  ], "real_model");
  const provider = new SequenceProvider([]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider });
  assert.match(harness.readConversation(user, sessionId).messages[0].text, /整理出 2 项/);
  sessions.addMessage(sessionId, "user", "agent_v2_user", "先重新整理", {}, "refresh-user-turn");
  sessions.ensure(user.id, todayYmd(), "complete", "job-new", [{
    candidateId: "task:new",
    title: "跟进供应商报价",
    workSummary: "不应持久化的长摘要",
    resultHint: "",
    referenceIds: ["ref-new"],
    sourceTypes: ["chat_private"],
    needsConfirmation: ["task_signal", "today", "result", "status"],
    scopeType: "department_daily",
    projectCandidates: [],
    groupKey: "department_daily",
    groupLabel: "部门日常",
    origin: "today",
    confidence: 0.7,
    sourceCompleteness: "complete",
    missingFacts: ["today", "result", "status"],
    candidateKind: "task_signal",
  }], "real_model");
  const refreshed = harness.readConversation(user, sessionId);
  assert.equal(refreshed.draft.items.length, 1);
  assert.equal(refreshed.messages.at(-1)?.kind, "agent_v2_context_refresh");
  assert.match(refreshed.messages.at(-1)?.text ?? "", /当前有 1 项待确认事项，其中 1 项/);
  assert.match(refreshed.messages.at(-1)?.text ?? "", /旧开场中的事项数量已经失效/);
  const storedMessages = JSON.stringify(db.prepare(
    "SELECT content, structured_json, tool_trace_json FROM assistant_messages WHERE session_id = ? AND role = 'assistant'",
  ).all(sessionId));
  assert.doesNotMatch(storedMessages, /跟进供应商报价|不应持久化的长摘要|ref-new/);
  db.close();
});

test("新 context job 改变候选投影会递增 revision，使旧 V2 事务冲突且不能覆盖新候选", () => {
  const { db, user, project, sessions, sessionId } = setup();
  sessions.ensure(user.id, todayYmd(), "complete", "job-before-interleaving", [
    projectedCandidate("wi_01", "日报助手内核", project),
    projectedCandidate("wi_02", "第二事项", project),
  ], "real_model");
  const source = userMessage(db, sessions, sessionId, "第一项记 2 小时");
  const stale = new AssistantV2DraftTransaction(db, user, source, "第一项记 2 小时");
  stale.applyPatch({ expectedRevision: 1, operations: [{ op: "set_hours", itemId: "wi_01", hours: 2 }] });

  const refreshed = sessions.ensure(user.id, todayYmd(), "complete", "job-after-interleaving", [{
    candidateId: "new-context-candidate",
    title: "新上下文候选",
    workSummary: "新上下文候选摘要",
    resultHint: "形成新结果",
    referenceIds: ["ref-new-context"],
    sourceTypes: ["document"],
    needsConfirmation: ["today", "hours", "project"],
    scopeType: "department_daily",
    projectCandidates: [],
    groupKey: "department_daily",
    groupLabel: "部门日常",
    origin: "today",
    confidence: 0.8,
    sourceCompleteness: "complete",
    missingFacts: ["today", "hours", "project"],
    candidateKind: "work_event",
  }], "real_model");
  assert.equal(refreshed.revision, 2);
  assert.deepEqual(refreshed.items.map((item) => item.itemKey), ["new-context-candidate"]);
  assert.throws(() => stale.commit(), /草稿在本轮期间已被修改/);

  const latest = sessions.readById(sessionId, user.id);
  assert.equal(latest.revision, 2);
  assert.deepEqual(latest.items.map((item) => item.itemKey), ["new-context-candidate"]);
  db.close();
});

test("已有非 manual 会话从空 context 接入首个 job 时替换并投影候选", () => {
  const { db, user, project, sessions, sessionId } = setup();
  db.prepare("UPDATE assistant_sessions SET analysis_mode = 'real_model' WHERE id = ?").run(sessionId);

  const refreshed = sessions.ensure(user.id, todayYmd(), "complete", "job-first-context", [
    projectedCandidate("first-context-candidate", "首个上下文工作候选", project),
  ], "real_model");

  assert.equal(refreshed.contextJobId, "job-first-context");
  assert.equal(refreshed.revision, 1);
  assert.deepEqual(refreshed.items.map((item) => item.itemKey), ["first-context-candidate"]);
  db.close();
});

test("V2 删除未确认任务线索会硬删除且不在事项、账本或助手消息中残留标题与引用", async () => {
  const { db, user, sessions, sessionId } = setup();
  const taskTitle = "仅用于临时确认的供应商报价";
  const taskReference = "private-ref-delete-001";
  sessions.ensure(user.id, todayYmd(), "complete", undefined, [{
    candidateId: "task:private-delete",
    title: taskTitle,
    workSummary: "来自聊天的临时摘要",
    resultHint: "",
    referenceIds: [taskReference],
    sourceTypes: ["chat_private"],
    needsConfirmation: ["task_signal", "today", "result", "status"],
    scopeType: "department_daily",
    projectCandidates: [],
    groupKey: "department_daily",
    groupLabel: "部门日常",
    origin: "today",
    confidence: 0.7,
    sourceCompleteness: "complete",
    missingFacts: ["today", "result", "status"],
    candidateKind: "task_signal",
  }], "real_model");

  const provider = new SequenceProvider([
    response([
      call("p1", "apply_draft_patch", { expectedRevision: 1, operations: [{ op: "set_hours", itemId: "wi_01", hours: 2 }] }),
      call("r1", "reply", {
        message: `继续确认 ${taskTitle}（${taskReference}）？`,
        focus: { itemId: "task:private-delete", field: "today", questionKind: "ask_missing" },
      }),
    ]),
    response([
      call("p2", "apply_draft_patch", { expectedRevision: 2, operations: [{ op: "delete_item", itemId: "task:private-delete", reason: taskTitle }] }),
      call("r2", "reply", {
        message: `已删除 ${taskTitle}，引用是 ${taskReference}`,
        focus: { itemId: "wi_01", field: "result", questionKind: "ask_missing" },
      }),
    ]),
  ]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider });
  const opening = harness.readConversation(user, sessionId);
  assert.match(opening.messages[0].text, new RegExp(taskTitle));
  assert.match(opening.messages[0].text, /待确认任务线索/);
  const storedOpening = JSON.stringify(db.prepare(
    "SELECT content, structured_json, tool_trace_json FROM assistant_messages WHERE session_id = ? AND kind = 'agent_v2_opening'",
  ).all(sessionId));
  assert.match(storedOpening, /待确认任务线索/);
  assert.equal(storedOpening.includes(taskTitle), false);
  assert.equal(storedOpening.includes(taskReference), false);

  const normalChange = await harness.handleTurn(user, sessionId, "第一项 2 小时", "privacy-normal-change");
  const continued = harness.readConversation(user, sessionId);
  const historicalOpening = continued.messages.find((message) => message.kind === "agent_v2_opening");
  assert.match(historicalOpening?.text ?? "", /\[待确认任务线索\]/);
  assert.doesNotMatch(historicalOpening?.text ?? "", new RegExp(taskTitle));
  assert.equal(continued.draft.items.some((item) => item.summary === taskTitle), true, "对话后真实标题只由右侧权威草稿展示");
  const activeCopies = JSON.stringify({
    messages: db.prepare(
      "SELECT content, structured_json, tool_trace_json FROM assistant_messages WHERE session_id = ? AND role = 'assistant'",
    ).all(sessionId),
    changes: db.prepare(
      "SELECT before_json, after_json, receipts_json, operations_json FROM assistant_changes WHERE session_id = ?",
    ).all(sessionId),
  });
  assert.equal(activeCopies.includes(taskTitle), false, "任务仍待确认时也不得复制进持久消息或账本");
  assert.equal(activeCopies.includes(taskReference), false, "任务仍待确认时也不得复制进持久消息或账本");
  const removed = await harness.handleTurn(user, sessionId, "第三项删掉", "privacy-delete-task");
  assert.equal(removed.receipts[0].undoable, false);
  assert.doesNotMatch(removed.receipts[0].text, new RegExp(taskTitle));

  const itemRows = JSON.stringify(db.prepare(
    "SELECT * FROM assistant_session_items WHERE session_id = ?",
  ).all(sessionId));
  const changeRows = JSON.stringify(db.prepare(
    "SELECT before_json, after_json, receipts_json, operations_json FROM assistant_changes WHERE session_id = ?",
  ).all(sessionId));
  const messageRows = JSON.stringify(db.prepare(
    "SELECT content, structured_json, focus_json, tool_trace_json FROM assistant_messages WHERE session_id = ?",
  ).all(sessionId));
  for (const token of [taskTitle, taskReference]) {
    assert.equal(itemRows.includes(token), false, `assistant_session_items 不得残留 ${token}`);
    assert.equal(changeRows.includes(token), false, `assistant_changes 不得残留 ${token}`);
    assert.equal(messageRows.includes(token), false, `assistant_messages 不得残留 ${token}`);
  }
  assert.equal(Number((db.prepare(
    "SELECT COUNT(*) AS count FROM assistant_session_items WHERE session_id = ? AND item_key = 'task:private-delete'",
  ).get(sessionId) as { count: number }).count), 0);
  assert.equal(Number((db.prepare(
    "SELECT COUNT(*) AS count FROM assistant_changes WHERE session_id = ?",
  ).get(sessionId) as { count: number }).count), 1, "任务硬删除自身不应写入可撤销账本");
  await assert.rejects(harness.undoDirect(user, sessionId, removed.receipts[0].changeId), /不存在或已撤销/);

  const undoneNormal = await harness.undoDirect(user, sessionId, normalChange.receipts[0].changeId);
  assert.equal(undoneNormal.draftProjection.items.find((item) => item.itemId === "wi_01")?.hours, null);
  assert.equal(undoneNormal.draftProjection.items.some((item) => item.itemId === "task:private-delete"), false);
  db.close();
});

test("V2 合并普通事项与未确认任务线索时硬删被移除线索行", () => {
  const { db, user, sessions, sessionId } = setup();
  const taskTitle = "合并后不得残留的任务标题";
  const taskReference = "ref-merge-hard-delete";
  sessions.ensure(user.id, todayYmd(), "complete", undefined, [{
    candidateId: "task:merge-hard-delete",
    title: taskTitle,
    workSummary: "临时摘要",
    resultHint: "",
    referenceIds: [taskReference],
    sourceTypes: ["chat_group"],
    needsConfirmation: ["task_signal", "today", "result", "status"],
    scopeType: "department_daily",
    projectCandidates: [],
    groupKey: "department_daily",
    groupLabel: "部门日常",
    origin: "today",
    confidence: 0.7,
    sourceCompleteness: "complete",
    missingFacts: ["today", "result", "status"],
    candidateKind: "task_signal",
  }], "real_model");
  const source = userMessage(db, sessions, sessionId, "把第一项和第三项合并");
  const transaction = new AssistantV2DraftTransaction(db, user, source, "把第一项和第三项合并");
  transaction.applyPatch({
    expectedRevision: 1,
    operations: [{
      op: "merge_items",
      itemIds: ["wi_01", "task:merge-hard-delete"],
      summary: "合并后的员工确认事项",
    }],
  });
  transaction.commit();

  const storedItems = JSON.stringify(db.prepare("SELECT * FROM assistant_session_items WHERE session_id = ?").all(sessionId));
  assert.equal(storedItems.includes(taskTitle), false);
  assert.equal(storedItems.includes(taskReference), false);
  assert.equal(Number((db.prepare(
    "SELECT COUNT(*) AS count FROM assistant_session_items WHERE session_id = ? AND item_key = 'task:merge-hard-delete'",
  ).get(sessionId) as { count: number }).count), 0);
  assert.equal(new AssistantV2StateRepository(db).read(user, sessionId).items[0].summary, "合并后的员工确认事项");
  db.close();
});

test("撤销按钮不经过模型：反向应用账本并保留上一轮焦点", async () => {
  const { db, user, sessionId } = setup();
  const provider = new SequenceProvider([
    response([
      call("p1", "apply_draft_patch", { expectedRevision: 0, operations: [{ op: "delete_item", itemId: "wi_02" }] }),
      call("r1", "reply", { message: "第 1 项今天形成了什么结果？", focus: { itemId: "wi_01", field: "result", questionKind: "ask_missing" } }),
    ]),
  ]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider });
  const turn = await harness.handleTurn(user, sessionId, "第二个删掉", "undo-1");
  assert.equal(turn.draftProjection.items.length, 1);
  const undone = await harness.undoDirect(user, sessionId, turn.receipts[0].changeId);
  assert.equal(undone.draftProjection.items.length, 2);
  assert.match(undone.assistantMessage.text, /已撤销/);
  assert.equal(undone.focus?.field, "result");
  const view = harness.readConversation(user, sessionId);
  assert.equal(view.revision, 2);
  assert.equal(view.messages.at(-1)?.kind, "agent_v2_reply");
  await assert.rejects(harness.undoDirect(user, sessionId, "c_missing"), /不存在或已撤销/);
  db.close();
});

test("提交按钮是确定性授权：校验 revision 与缺口后提交，提交后仍可继续修改并再次提交新版本", async () => {
  const { db, user, project, financeCodeId, sessions, sessionId } = setup();
  db.prepare(
    `UPDATE assistant_session_items SET scope_type = 'project', project_id = ?, project_name_snapshot = ?,
       finance_project_code_id = ?, result_text = '完成', hours = 2, employee_confirmed = 1, needs_confirmation_json = '[]'
     WHERE session_id = ?`,
  ).run(project.id, project.name, financeCodeId, sessionId);
  db.prepare("UPDATE assistant_sessions SET outside_work_asked = 1, outside_work_answered = 1 WHERE id = ?").run(sessionId);
  sessions.addMessage(sessionId, "user", "agent_v2_user", "都对", {}, "submit-0");
  const provider = new SequenceProvider([
    response([
      call("p1", "apply_draft_patch", { expectedRevision: 0, operations: [{ op: "set_hours", itemId: "wi_01", hours: 3 }] }),
      call("r1", "reply", { message: "还有别的要改吗？", focus: { itemId: null, field: "submit", questionKind: "confirm_submit" } }),
    ]),
  ]);
  const harness = new DailyAssistantV2Harness(db, { primary: provider, backup: provider });
  await assert.rejects(harness.submitDirect(user, sessionId, 99), /草稿已经变化/);
  const submitted = await harness.submitDirect(user, sessionId, 0);
  assert.equal(submitted.submitted, true);
  assert.match(submitted.assistantMessage.text, /版本 1/);
  const again = await harness.submitDirect(user, sessionId, 0);
  assert.equal(again.submitted, true);
  assert.match(again.assistantMessage.text, /已经提交过/);
  // 提交后继续对话修改（同一会话），再次提交形成版本 2
  const edited = await harness.handleTurn(user, sessionId, "第一项改成3小时", "submit-1");
  assert.equal(edited.draftProjection.items[0].hours, 3);
  const resubmitted = await harness.submitDirect(user, sessionId, edited.revision);
  assert.match(resubmitted.assistantMessage.text, /版本 2/);
  db.close();
});
