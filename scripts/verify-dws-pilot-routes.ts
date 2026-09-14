/** 兼容旧脚本名：验证助手已向全部钉钉员工开放，同时仍拒绝本地外部账号。 */
import assert from "node:assert/strict";
import { canUseDwsAssistant } from "../src/auth/types";

const formerPilots = ["example-user-5", "example-user-2"];
assert.equal(canUseDwsAssistant({ kind: "dingtalk", ddUserid: "example-user-5" }, formerPilots, true), true);
assert.equal(canUseDwsAssistant({ kind: "dingtalk", ddUserid: "not-a-pilot" }, formerPilots, true), true);
assert.equal(canUseDwsAssistant({ kind: "local" }, formerPilots, true), false);
assert.equal(canUseDwsAssistant({ kind: "dingtalk", ddUserid: "not-a-pilot" }, formerPilots, false), false);

console.log(JSON.stringify({ allDingTalkEmployeesEnabled: true, localAccountsExcluded: true }));
