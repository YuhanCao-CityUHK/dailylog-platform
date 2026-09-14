import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import type { DailyAssistantCandidate } from "../src/assistant/candidate-service";
import { ConversationEngine } from "../src/assistant/conversation-engine";
import { AssistantSubmitService } from "../src/assistant/submit-service";
import { AssistantValidationError } from "../src/assistant/structured-validation";
import { ensureFinanceProjectCodeTable } from "../src/platform/finance-project-codes";
import { todayYmd } from "../src/infra/workcal";
import { createFormalProject } from "../src/projects/service";
import { addUser, createMigratedFixtureDb } from "./helpers";

function setup() {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "提交员工", role: "lead", dept: "研发部" });
  const user: SessionUser = {
    id: userId,
    kind: "dingtalk",
    ddUserid: "submit-user",
    name: "提交员工",
    title: "",
    dept: "研发部",
    role: "lead",
    isExternal: false,
    mustChangePw: false,
  };
  const project = createFormalProject(user, { name: "提交测试项目" }, db);
  ensureFinanceProjectCodeTable(db);
  const financeCode = db
    .prepare("INSERT INTO finance_project_codes (project_id, code, name) VALUES (?, ?, ?)")
    .run(project.id, "TEST-SUBMIT", "TEST-SUBMIT 测试编码");
  const candidate: DailyAssistantCandidate = {
    candidateId: "submit-candidate",
    title: "日报提交链路",
    workSummary: "日报提交链路",
    resultHint: "完成日报提交链路并通过幂等验证",
    referenceIds: ["temporary-reference-id"],
    sourceTypes: ["document"],
    needsConfirmation: ["hours"],
    scopeType: "project",
    selectedProjectId: project.id,
    selectedProjectName: project.name,
    projectCandidates: [],
    groupKey: `project:${project.id}`,
    groupLabel: project.name,
    origin: "today",
    confidence: 0.9,
    sourceCompleteness: "complete",
    missingFacts: [],
  };
  const engine = new ConversationEngine(db);
  const session = engine.ensureSession(user.id, todayYmd(), "complete", "submit-job", [candidate]);
  db.prepare("UPDATE assistant_session_items SET finance_project_code_id = ? WHERE session_id = ? AND project_id = ?")
    .run(Number(financeCode.lastInsertRowid), session.id, project.id);
  return { db, user, engine, session, candidate };
}

test("明确确认后一天一篇，重复请求幂等，当日续改只增加版本", () => {
  const { db, user, engine, session } = setup();
  engine.applyStructured(user, session.id, [
    { type: "update", itemId: session.items[0].id, patch: { hours: 3 } },
    { type: "outside_work_answered" },
  ]);
  const submit = new AssistantSubmitService(db);
  const first = submit.submit(user, session.id, "确认提交", "submit-key-1");
  assert.equal(first.idempotent, false);
  assert.equal(first.report.totalHours, 3);
  assert.equal(first.report.currentVersion, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM logs WHERE user_id = ? AND date = ? AND status = 'submitted'").get(user.id, todayYmd())!.value, 1);

  const replay = submit.submit(user, session.id, "确认提交", "submit-key-1");
  assert.equal(replay.idempotent, true);
  assert.equal(replay.version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM log_versions").get()!.value, 1);

  engine.applyStructured(user, session.id, [
    { type: "update", itemId: session.items[0].id, patch: { resultText: "完成日报提交链路、幂等与版本验证", hours: 4 } },
  ]);
  const second = submit.submit(user, session.id, "提交这版", "submit-key-2");
  assert.equal(second.report.id, first.report.id);
  assert.equal(second.report.currentVersion, 2);
  assert.equal(second.report.totalHours, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM logs WHERE user_id = ? AND date = ? AND status = 'submitted'").get(user.id, todayYmd())!.value, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM log_versions").get()!.value, 2);

  const originalReplay = submit.submit(user, session.id, "确认提交", "submit-key-1");
  assert.equal(originalReplay.report.currentVersion, 1);
  assert.equal(originalReplay.report.totalHours, 3);
  db.close();
});

test("正式日报与版本快照不保存 Reference 或原始上下文", () => {
  const { db, user, engine, session } = setup();
  engine.applyStructured(user, session.id, [
    { type: "update", itemId: session.items[0].id, patch: { hours: 2 } },
    { type: "outside_work_answered" },
  ]);
  new AssistantSubmitService(db).submit(user, session.id, "确认并提交", "safe-submit");
  const item = db.prepare("SELECT * FROM log_items").get() as Record<string, unknown>;
  const version = db.prepare("SELECT snapshot_json FROM log_versions").get() as { snapshot_json: string };
  assert.equal(Object.keys(item).some((key) => /reference|context|source_raw/i.test(key)), false);
  assert.doesNotMatch(JSON.stringify(item), /temporary-reference-id/);
  assert.doesNotMatch(version.snapshot_json, /temporary-reference-id|referenceIds|contextJob/i);
  db.close();
});

test("删除系统候选后刷新会话仍可提交员工补充日报", () => {
  const { db, user, engine, session, candidate } = setup();
  engine.applyStructured(user, session.id, [
    { type: "delete", itemId: session.items[0].id },
    { type: "add", item: { workSummary: "员工补充的真实工作", resultText: "完成真实工作并通过验证", hours: 8 } },
    { type: "outside_work_answered" },
  ]);

  const refreshed = engine.ensureSession(user.id, todayYmd(), "complete", "submit-job", [candidate]);
  assert.deepEqual(refreshed.items.map((item) => item.sourceKind), ["employee"]);

  const submitted = new AssistantSubmitService(db).submit(user, refreshed.id, "确认提交", "deleted-candidate-submit");
  assert.equal(submitted.report.totalHours, 8);
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM logs WHERE user_id = ? AND date = ? AND status = 'submitted'").get(user.id, todayYmd())!.value, 1);
  db.close();
});

test("项目未配置财务编码时助手仍可提交，并将编码留空", () => {
  const { db, user, engine, session } = setup();
  db.prepare("UPDATE assistant_session_items SET finance_project_code_id = NULL WHERE session_id = ?").run(session.id);
  db.prepare("DELETE FROM finance_project_codes WHERE project_id = ?").run(session.items[0].projectId);
  engine.applyStructured(user, session.id, [
    { type: "update", itemId: session.items[0].id, patch: { hours: 3 } },
    { type: "outside_work_answered" },
  ]);

  const result = new AssistantSubmitService(db).submit(user, session.id, "确认提交", "no-finance-code-submit");
  assert.equal(result.report.totalHours, 3);
  assert.equal((db.prepare("SELECT finance_project_code_id FROM log_items WHERE log_id = ?").get(result.report.id) as { finance_project_code_id: number | null }).finance_project_code_id, null);
  db.close();
});

test("未闭环草稿或不明确提交意图不能落正式库", () => {
  const { db, user, session } = setup();
  const submit = new AssistantSubmitService(db);
  assert.throws(() => submit.submit(user, session.id, "帮我看看", "invalid-intent"), AssistantValidationError);
  assert.throws(() => submit.submit(user, session.id, "确认提交", "incomplete"), AssistantValidationError);
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM logs").get()!.value, 0);
  db.close();
});
