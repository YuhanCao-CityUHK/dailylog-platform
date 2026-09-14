/** DWS 身份核验的确定性验证；不调用真实钉钉数据。 */
import assert from "node:assert/strict";
import { dwsUserHome, inspectDwsConnection, type DwsRunner } from "../src/dws/client";
import { parseDwsDeviceAuthorization } from "../src/dws/device-auth";

const corpId = "ding-test";
const userId = "user-1";
const platformUserId = 7;

function runner(actualUserId = userId): DwsRunner {
  return async (args) => {
    const command = args.join(" ");
    if (command === "profile list --format json") {
      return JSON.stringify({
        success: true,
        profiles: [{ profile: `${corpId}:${userId}`, corpId, status: "active", isOrgCurrent: true }],
      });
    }
    if (command.includes("auth status")) {
      return JSON.stringify({ authenticated: true, token_valid: true, refresh_token_valid: true });
    }
    if (command.includes("contact user get-self")) {
      return JSON.stringify({
        success: true,
        result: [
          {
            orgEmployeeModel: {
              corpId,
              userId: actualUserId,
              orgUserName: "测试用户",
              orgName: "测试企业",
              depts: [{ deptName: "测试部门" }],
            },
          },
        ],
      });
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

const connected = await inspectDwsConnection({ platformUserId, corpId, ddUserid: userId }, runner());
assert.equal(connected.state, "connected");
assert.equal(connected.connected, true);
assert.equal(connected.profile, `${corpId}:${userId}`);
assert.equal(connected.identity?.name, "测试用户");

const mismatch = await inspectDwsConnection({ platformUserId, corpId, ddUserid: userId }, runner("other-user"));
assert.equal(mismatch.state, "identity_mismatch");
assert.equal(mismatch.connected, false);

const noProfile = await inspectDwsConnection(
  { platformUserId, corpId, ddUserid: userId },
  async () => JSON.stringify({ success: true, profiles: [] }),
);
assert.equal(noProfile.state, "unauthenticated");

const otherUserOnly = await inspectDwsConnection(
  { platformUserId, corpId, ddUserid: userId },
  async () =>
    JSON.stringify({
      success: true,
      profiles: [{ profile: `${corpId}:other-user`, corpId, status: "active", isOrgCurrent: true }],
    }),
);
assert.equal(otherUserOnly.state, "unauthenticated");

const disabled = await inspectDwsConnection({ platformUserId, corpId, ddUserid: userId }, runner(), false);
assert.equal(disabled.state, "disabled");

const prompt = parseDwsDeviceAuthorization(`
  link: https://login.dingtalk.com/oauth2/device/verify.htm
  authorization code: AB12-CD34
  https://login.dingtalk.com/oauth2/device/verify.htm?user_code=AB12-CD34
`);
assert.equal(prompt?.userCode, "AB12-CD34");
assert.equal(
  prompt?.verificationUrl,
  "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=AB12-CD34",
);
assert.equal(parseDwsDeviceAuthorization("https://evil.example/device?user_code=AB12-CD34"), null);
assert.notEqual(dwsUserHome(7), dwsUserHome(8));
assert.throws(() => dwsUserHome(0), /无效的平台用户 ID/);

console.log(
  JSON.stringify({
    connected: true,
    mismatchRejected: true,
    crossUserProfileRejected: true,
    credentialHomesIsolated: true,
    missingProfileRejected: true,
    devicePromptParsed: true,
    disabled: true,
  }),
);
