import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { ConversationEngine } from "../src/assistant/conversation-engine";
import { assistantDraftAffiliations, isEditableReportDate } from "../src/platform/routes-fill";
import { addUser, createMigratedFixtureDb } from "./helpers";

test("只允许当天和前一工作日修改，更早日报只读", () => {
  assert.equal(isEditableReportDate("2026-08-25", "2026-08-25", "2026-08-24"), true);
  assert.equal(isEditableReportDate("2026-08-24", "2026-08-25", "2026-08-24"), true);
  assert.equal(isEditableReportDate("2026-08-21", "2026-08-25", "2026-08-24"), false);
});

test("前一工作日没有正式日报时可恢复助手结构化草稿且不依赖 Reference", async () => {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "补填员工", role: "emp", dept: "研发部" });
  const user: SessionUser = {
    id: userId,
    kind: "dingtalk",
    ddUserid: "retro-user",
    name: "补填员工",
    title: "",
    dept: "研发部",
    role: "emp",
    isExternal: false,
    mustChangePw: false,
  };
  const engine = new ConversationEngine(db);
  const session = engine.ensureSession(user.id, "2026-08-24", "manual", undefined, []);
  await engine.handleMessage(user, session.id, "完成本地资料核对并形成清单2小时", "retro-draft");
  const restored = assistantDraftAffiliations(user.id, "2026-08-24", db);
  assert.equal(restored?.length, 1);
  assert.equal(restored?.[0].affId, "dept");
  assert.equal(restored?.[0].items[0].hours, 2);
  assert.match(restored?.[0].items[0].text ?? "", /完成本地资料核对并形成清单/);
  assert.doesNotMatch(JSON.stringify(restored), /reference|context/i);
  db.close();
});
