import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import type { DailyAssistantCandidate } from "../src/assistant/candidate-service";
import { ConversationEngine } from "../src/assistant/conversation-engine";
import { AssistantValidationError } from "../src/assistant/structured-validation";
import { buildAssistantDraft } from "../src/assistant/draft-service";
import { createFormalProject } from "../src/projects/service";
import { addUser, createMigratedFixtureDb } from "./helpers";
import { AssistantV2StateRepository } from "../src/assistant-v2/state-repository";
import { renderAgentProjection } from "../src/assistant-v2/projection";
import { ensureFinanceProjectCodeTable } from "../src/platform/finance-project-codes";

function candidate(id: string, projectId: number, projectName: string, title: string): DailyAssistantCandidate {
  return {
    candidateId: id,
    title,
    workSummary: title,
    resultHint: `完成${title}并形成验证结果`,
    referenceIds: [`ref-${id}`],
    sourceTypes: ["document"],
    needsConfirmation: ["hours"],
    scopeType: "project",
    selectedProjectId: projectId,
    selectedProjectName: projectName,
    projectCandidates: [{ projectId, projectName, score: 0.9, reason: "测试" }],
    groupKey: `project:${projectId}`,
    groupLabel: projectName,
    origin: "today",
    confidence: 0.9,
    sourceCompleteness: "complete",
    missingFacts: [],
  };
}

function taskCandidate(id: string, projectId: number, projectName: string, title: string, referenceId: string): DailyAssistantCandidate {
  return {
    ...candidate(id, projectId, projectName, title),
    resultHint: "",
    referenceIds: [referenceId],
    sourceTypes: ["chat_group"],
    needsConfirmation: ["task_signal", "today", "result", "status"],
    missingFacts: ["today", "result", "status"],
    candidateKind: "task_signal",
  };
}

function fixture() {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "测试员工", role: "lead", dept: "研发部" });
  const user: SessionUser = {
    id: userId,
    kind: "dingtalk",
    ddUserid: "employee-1",
    name: "测试员工",
    title: "",
    dept: "研发部",
    role: "lead",
    isExternal: false,
    mustChangePw: false,
  };
  const project = createFormalProject(user, { name: "日报助手项目" }, db);
  ensureFinanceProjectCodeTable(db);
  const financeCode = db
    .prepare("INSERT INTO finance_project_codes (project_id, code, name) VALUES (?, ?, ?)")
    .run(project.id, "TEST-CONVERSATION", "TEST-CONVERSATION 测试编码");
  return { db, user, project, financeCodeId: Number(financeCode.lastInsertRowid) };
}

test("对话会话自动保存恢复，闭环后生成完整草稿且不写入 Reference 正文", async () => {
  const { db, user, project, financeCodeId } = fixture();
  const engine = new ConversationEngine(db);
  const session = engine.ensureSession(user.id, "2026-08-25", "complete", "job-1", [
    candidate("one", project.id, project.name, "上下文账号隔离验证"),
  ]);
  db.prepare("UPDATE assistant_session_items SET finance_project_code_id = ? WHERE session_id = ? AND project_id = ?")
    .run(financeCodeId, session.id, project.id);
  assert.equal(engine.state(session.id, user.id).promptKind, "confirm_candidates");

  await engine.handleMessage(user, session.id, "候选都对", "message-1");
  assert.equal(engine.state(session.id, user.id).promptKind, "hours");
  const completed = await engine.handleMessage(user, session.id, "没有其他，第1项实际投入3小时", "message-2");
  assert.equal(completed.promptKind, "draft");
  assert.equal(completed.draft?.complete, true);
  assert.equal(completed.draft?.totalHours, 3);
  assert.match(completed.draft?.text ?? "", /完成上下文账号隔离验证并形成验证结果/);
  assert.doesNotMatch(completed.draft?.text ?? "", /ref-one|Reference/i);

  const revision = completed.session.revision;
  const duplicate = await engine.handleMessage(user, session.id, "没有其他，第1项实际投入3小时", "message-2");
  assert.equal(duplicate.session.revision, revision);
  const restored = new ConversationEngine(db).state(session.id, user.id);
  assert.equal(restored.draft?.totalHours, 3);
  assert.equal(restored.session.messages.filter((message) => message.role === "user").length, 2);
  db.close();
});

test("结构化指令支持删除、合并、拆分、改项目、补充和改工时", () => {
  const { db, user, project } = fixture();
  const other = createFormalProject(user, { name: "客户支持项目" }, db);
  const engine = new ConversationEngine(db);
  let session = engine.ensureSession(user.id, "2026-08-25", "partial", "job-2", [
    candidate("one", project.id, project.name, "方案设计"),
    candidate("two", project.id, project.name, "研发验证"),
    candidate("three", project.id, project.name, "无关会议"),
  ]);
  engine.applyStructured(user, session.id, [
    { type: "delete", itemId: session.items[2].id },
    { type: "merge", itemIds: [session.items[0].id, session.items[1].id] },
  ]);
  session = engine.state(session.id, user.id).session;
  assert.equal(session.items.length, 1);
  assert.match(session.items[0].workSummary, /方案设计；研发验证/);

  engine.applyStructured(user, session.id, [
    { type: "split", itemId: session.items[0].id, summaries: ["方案设计", "研发验证"] },
  ]);
  session = engine.state(session.id, user.id).session;
  assert.deepEqual(session.items.map((item) => item.workSummary), ["方案设计", "研发验证"]);
  engine.applyStructured(user, session.id, [
    { type: "assign_project", itemId: session.items[1].id, projectId: other.id },
    { type: "update", itemId: session.items[0].id, patch: { resultText: "形成评审方案", hours: 2 } },
    { type: "add", item: { workSummary: "现场问题处理", resultText: "解决客户现场问题", hours: 1, projectId: other.id } },
  ]);
  session = engine.state(session.id, user.id).session;
  assert.equal(session.items[1].projectId, other.id);
  assert.equal(session.items[0].hours, 2);
  assert.equal(session.items[2].sourceKind, "employee");
  assert.deepEqual(session.items[2].referenceIds, []);
  db.close();
});

test("V1 合并会硬删被移除的未确认任务线索，并保持普通被合并项为软删除", () => {
  const { db, user, project } = fixture();
  const engine = new ConversationEngine(db);
  const taskTitle = "旧 actions 路由临时任务标题";
  const taskReference = "ref-v1-merge-task";
  const session = engine.ensureSession(user.id, "2026-08-25", "complete", "job-v1-task-merge", [
    candidate("merge-keep", project.id, project.name, "保留的普通事项"),
    taskCandidate("task:v1-merge", project.id, project.name, taskTitle, taskReference),
    candidate("merge-soft-delete", project.id, project.name, "普通被合并事项"),
  ], "real_model");
  const source = db.prepare(
    `INSERT INTO assistant_messages (session_id, role, kind, content, structured_json, created_at)
     VALUES (?, 'user', 'agent_v2_user', '合并这三项', '{}', ?)`,
  ).run(session.id, "2026-08-25T08:00:00.000Z");
  db.prepare(
    `INSERT INTO assistant_messages
      (session_id, role, kind, content, structured_json, focus_json, tool_trace_json, created_at)
     VALUES (?, 'assistant', 'agent_v2_reply', ?, ?, 'null', ?, ?)`,
  ).run(
    session.id,
    `${taskTitle} ${taskReference}`,
    JSON.stringify({ draftProjection: { items: [{ itemId: "task:v1-merge", summary: taskTitle, referenceIds: [taskReference] }] } }),
    JSON.stringify([{ summary: taskTitle, referenceId: taskReference }]),
    "2026-08-25T08:00:01.000Z",
  );
  const taskSnapshot = JSON.stringify({
    outsideWorkAsked: false,
    outsideWorkAnswered: false,
    items: [{ itemId: "task:v1-merge", summary: taskTitle, referenceIds: [taskReference] }],
  });
  db.prepare(
    `INSERT INTO assistant_changes
      (change_id, session_id, revision, op, before_json, after_json, receipts_json, operations_json,
       source_message_id, created_at)
     VALUES ('legacy-v1-merge-copy', ?, 0, 'merge_items', ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    taskSnapshot,
    taskSnapshot,
    JSON.stringify([`${taskTitle} ${taskReference}`]),
    JSON.stringify([{ op: "merge_items", itemIds: ["merge-keep", "task:v1-merge"] }]),
    Number(source.lastInsertRowid),
    "2026-08-25T08:00:02.000Z",
  );

  engine.applyStructured(user, session.id, [{ type: "merge", itemIds: session.items.map((item) => item.id) }]);

  assert.equal(Number((db.prepare(
    "SELECT COUNT(*) AS count FROM assistant_session_items WHERE session_id = ? AND item_key = 'task:v1-merge'",
  ).get(session.id) as { count: number }).count), 0, "未确认任务线索必须物理删除");
  assert.equal(Number((db.prepare(
    "SELECT deleted FROM assistant_session_items WHERE session_id = ? AND item_key = 'merge-soft-delete'",
  ).get(session.id) as { deleted: number }).deleted), 1, "普通事项继续保留可恢复的软删除语义");
  const durableCopies = JSON.stringify({
    messages: db.prepare(
      "SELECT content, structured_json, focus_json, tool_trace_json FROM assistant_messages WHERE session_id = ? AND role = 'assistant'",
    ).all(session.id),
    changes: db.prepare(
      "SELECT before_json, after_json, receipts_json, operations_json FROM assistant_changes WHERE session_id = ?",
    ).all(session.id),
  });
  assert.doesNotMatch(durableCopies, new RegExp(`${taskTitle}|${taskReference}`));
  db.close();
});

test("员工删除的候选在会话刷新时保持删除且不触发唯一键冲突", () => {
  const { db, user, project } = fixture();
  const engine = new ConversationEngine(db);
  let session = engine.ensureSession(user.id, "2026-08-25", "complete", "job-delete", [
    candidate("deleted", project.id, project.name, "应删除候选"),
    candidate("kept", project.id, project.name, "应保留候选"),
  ]);
  engine.applyStructured(user, session.id, [{ type: "delete", itemId: session.items[0].id }]);

  session = engine.ensureSession(user.id, "2026-08-25", "complete", "job-delete", [
    candidate("deleted", project.id, project.name, "应删除候选"),
    candidate("kept", project.id, project.name, "应保留候选"),
  ]);

  assert.deepEqual(session.items.map((item) => item.itemKey), ["kept"]);
  assert.equal(
    db.prepare("SELECT deleted FROM assistant_session_items WHERE session_id = ? AND item_key = ?").get(session.id, "deleted")!.deleted,
    1,
  );
  db.close();
});

test("员工已确认事实不会被同一候选的增量证据覆盖，非法结构动作被拒绝", () => {
  const { db, user, project } = fixture();
  const engine = new ConversationEngine(db);
  let session = engine.ensureSession(user.id, "2026-08-25", "partial", "job-3", [
    candidate("stable", project.id, project.name, "原始候选"),
  ]);
  engine.applyStructured(user, session.id, [
    { type: "update", itemId: session.items[0].id, patch: { resultText: "员工确认的真实结果", hours: 4 } },
  ]);
  const changed = candidate("stable", project.id, project.name, "后续证据错误标题");
  session = engine.ensureSession(user.id, "2026-08-25", "complete", "job-4", [changed]);
  assert.equal(session.items[0].workSummary, "原始候选");
  assert.equal(session.items[0].resultText, "员工确认的真实结果");
  assert.throws(
    () => engine.applyStructured(user, session.id, [{ type: "update", itemId: session.items[0].id, patch: { hours: 99 } }]),
    AssistantValidationError,
  );
  db.close();
});

test("新 contextJobId 替换未确认系统候选，并保留员工确认、修改和手工补充事项", () => {
  const { db, user, project } = fixture();
  const engine = new ConversationEngine(db);
  let session = engine.ensureSession(user.id, "2026-08-25", "partial", "job-old", [
    candidate("old-pending", project.id, project.name, "错误历史候选"),
    candidate("kept", project.id, project.name, "需要保留的候选"),
  ]);
  engine.applyStructured(user, session.id, [
    { type: "update", itemId: session.items[1].id, patch: { resultText: "员工确认结果", hours: 2 } },
    { type: "add", item: { workSummary: "员工手工补充", resultText: "形成线下核对清单", hours: 1 } },
  ]);

  session = engine.ensureSession(user.id, "2026-08-25", "complete", "job-new", [
    candidate("new-current", project.id, project.name, "新的今日候选"),
  ]);
  assert.equal(session.contextJobId, "job-new");
  assert.deepEqual(session.items.map((item) => item.workSummary), ["需要保留的候选", "员工手工补充", "新的今日候选"]);
  assert.equal(session.items.find((item) => item.itemKey === "kept")?.resultText, "员工确认结果");
  assert.equal(session.items.find((item) => item.sourceKind === "employee")?.workSummary, "员工手工补充");
  assert.equal(session.items.some((item) => item.itemKey === "old-pending"), false);
  db.close();
});

test("手工模式可从自然语言补充无 Reference 事项并继续追问结果", async () => {
  const { db, user } = fixture();
  const engine = new ConversationEngine(db);
  const session = engine.ensureSession(user.id, "2026-08-25", "manual", undefined, []);
  assert.equal(engine.state(session.id, user.id).promptKind, "manual_start");
  const next = await engine.handleMessage(user, session.id, "整理本地客户资料2小时", "manual-1");
  assert.equal(next.session.items.length, 1);
  assert.equal(next.session.items[0].hours, 2);
  assert.deepEqual(next.session.items[0].referenceIds, []);
  assert.equal(next.promptKind, "result");
  const result = await engine.handleMessage(user, session.id, "结果是完成客户资料核对并形成清单", "manual-2");
  assert.equal(result.promptKind, "outside_work");
  db.close();
});

test("逻辑闭环会追问模糊人员，但不强制询问不存在的阻塞", () => {
  const { db, user, project } = fixture();
  const engine = new ConversationEngine(db);
  const session = engine.ensureSession(user.id, "2026-08-25", "complete", "job-person", [
    candidate("person", project.id, project.name, "接口联调"),
  ]);
  engine.applyStructured(user, session.id, [
    { type: "update", itemId: session.items[0].id, patch: { resultText: "与同事完成接口联调", hours: 2 } },
    { type: "outside_work_answered" },
  ]);
  const state = engine.state(session.id, user.id);
  assert.equal(state.promptKind, "person");
  assert.doesNotMatch(state.prompt, /阻塞/);
  db.close();
});

test("候选态、草稿文本、前端和旧引擎共用全局连续 displayAlias", async () => {
  const { db, user, project } = fixture();
  const other = createFormalProject(user, { name: "第二项目" }, db);
  const engine = new ConversationEngine(db);
  const session = engine.ensureSession(user.id, "2026-08-25", "partial", "job-alias", [
    candidate("one", project.id, project.name, "第一项工作"),
    candidate("two", project.id, project.name, "第二项工作"),
    candidate("three", other.id, other.name, "第三项工作"),
  ]);
  assert.deepEqual(session.items.map((item) => item.displayAlias), ["第 1 项", "第 2 项", "第 3 项"]);
  const draft = buildAssistantDraft(session);
  assert.match(draft.text, /第 1 项：/);
  assert.match(draft.text, /第 2 项：/);
  assert.match(draft.text, /第 3 项：/);

  const changed = await engine.handleMessage(user, session.id, "第3项实际投入2小时", "alias-message");
  assert.equal(changed.session.items.find((item) => item.displayAlias === "第 3 项")?.hours, 2);

  const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(frontend, /esc\(item\.displayAlias\)/);
  assert.doesNotMatch(frontend, /var displayNumber = 0/);
  db.close();
});

test("来源完整性、事件置信度和 missingFacts 进入会话存储与 Harness V2 投影", () => {
  const { db, user, project } = fixture();
  const item = {
    ...candidate("partial-event", project.id, project.name, "事件融合候选"),
    sourceCompleteness: "partial" as const,
    confidence: 0.6,
    missingFacts: ["status", "actor"],
    needsConfirmation: ["status", "actor", "hours"],
  };
  const session = new ConversationEngine(db).ensureSession(user.id, "2026-08-25", "partial", "job-event", [item], "real_model");
  assert.equal(session.items[0].sourceCompleteness, "partial");
  assert.equal(session.items[0].confidence, 0.6);
  assert.deepEqual(session.items[0].missingFacts, ["status", "actor"]);
  const projection = renderAgentProjection(new AssistantV2StateRepository(db).read(user, session.id));
  assert.match(projection, /证据完整性：partial/);
  assert.match(projection, /置信度：0\.60/);
  assert.match(projection, /缺失事实：status、actor/);
  assert.match(projection, /部分来源未完整读取/);
  db.close();
});
