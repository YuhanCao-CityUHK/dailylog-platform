import assert from "node:assert/strict";
import test from "node:test";
import { assistantEventFusionEnabledForUser, assistantFeatureEnabled, type AssistantRolloutFlags } from "../src/assistant/features";
import { canUseDwsAssistant, type SessionUser } from "../src/auth/types";

const allOn: AssistantRolloutFlags = {
  enabled: true,
  conversationEnabled: true,
  submitEnabled: true,
  managerOverviewEnabled: true,
  prewarmEnabled: true,
  reminderEnabled: true,
};

test("总开关关闭时所有新链路关闭，可回退旧填写和旧主管首页", () => {
  const off = { ...allOn, enabled: false };
  for (const feature of ["context", "conversation", "submit", "manager", "prewarm", "reminder"] as const) {
    assert.equal(assistantFeatureEnabled(feature, off), false);
  }
});

test("对话、提交、主管首页、预准备和提醒可独立灰度", () => {
  const flags: AssistantRolloutFlags = {
    ...allOn,
    conversationEnabled: false,
    submitEnabled: true,
    managerOverviewEnabled: false,
    prewarmEnabled: true,
    reminderEnabled: false,
  };
  assert.equal(assistantFeatureEnabled("context", flags), true);
  assert.equal(assistantFeatureEnabled("conversation", flags), false);
  assert.equal(assistantFeatureEnabled("submit", flags), false);
  assert.equal(assistantFeatureEnabled("manager", flags), false);
  assert.equal(assistantFeatureEnabled("prewarm", flags), true);
  assert.equal(assistantFeatureEnabled("reminder", flags), false);
});

test("员工助手已面向全部钉钉员工开放，不再受旧试点名单限制", () => {
  const user: SessionUser = {
    id: 1,
    kind: "dingtalk",
    ddUserid: "pilot-1",
    name: "试点主管",
    title: "",
    dept: "研发部",
    role: "mgr",
    isExternal: false,
    mustChangePw: false,
  };
  assert.equal(canUseDwsAssistant(user, ["pilot-1"], true), true);
  assert.equal(canUseDwsAssistant(user, ["pilot-2"], true), true);
  assert.equal(canUseDwsAssistant({ ...user, kind: "local" }, ["pilot-1"], true), false);
});

test("WorkEvent 新链路使用独立开关并按 userid 灰度", () => {
  assert.equal(assistantEventFusionEnabledForUser("pilot-1", false, ["pilot-1"]), false);
  assert.equal(assistantEventFusionEnabledForUser("pilot-1", true, ["pilot-1"]), true);
  assert.equal(assistantEventFusionEnabledForUser("pilot-2", true, ["pilot-1"]), false);
  assert.equal(assistantEventFusionEnabledForUser(undefined, true, ["pilot-1"]), false);
});
