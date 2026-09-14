import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assistantWorkDiscoveryEnabledForUser } from "../src/assistant/features";

function readConfig(overrides: Record<string, string>): { maxCandidates: number; problems: string[] } {
  const script = [
    'const { CONFIG, validateConfig } = await import("./src/infra/config.ts");',
    'process.stdout.write(JSON.stringify({',
    '  maxCandidates: CONFIG.assistant.workDiscoveryMaxCandidates,',
    '  problems: validateConfig().filter((item) => item.includes("WORK_DISCOVERY"))',
    '}));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DOTENV_CONFIG_QUIET: "true",
      DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED: "0",
      DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS: "",
      DAILY_ASSISTANT_WORK_DISCOVERY_MAX_CANDIDATES: "",
      LLM_ENABLED: "1",
      LLM_API_KEY: "test-key",
      ...overrides,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { maxCandidates: number; problems: string[] };
}

test("工作发现严格按独立开关和 userid 名单灰度", () => {
  assert.equal(assistantWorkDiscoveryEnabledForUser("pilot-a", true, ["pilot-a"]), true);
  assert.equal(assistantWorkDiscoveryEnabledForUser("other", true, ["pilot-a"]), false);
  assert.equal(assistantWorkDiscoveryEnabledForUser("pilot-a", false, ["pilot-a"]), false);
  assert.equal(assistantWorkDiscoveryEnabledForUser(" ", true, ["pilot-a"]), false);
});

test("工作发现候选上限默认 50，并限制在 8 到 100", () => {
  assert.equal(readConfig({}).maxCandidates, 50);
  assert.equal(readConfig({ DAILY_ASSISTANT_WORK_DISCOVERY_MAX_CANDIDATES: "3" }).maxCandidates, 8);
  assert.equal(readConfig({ DAILY_ASSISTANT_WORK_DISCOVERY_MAX_CANDIDATES: "72" }).maxCandidates, 72);
  assert.equal(readConfig({ DAILY_ASSISTANT_WORK_DISCOVERY_MAX_CANDIDATES: "500" }).maxCandidates, 100);
});

test("启用工作发现必须同时配置试点 userid 和真实 LLM", () => {
  const missing = readConfig({
    DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED: "1",
    DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS: "",
    LLM_API_KEY: "",
    DASHSCOPE_API_KEY: "",
    QWEN_API_KEY: "",
  }).problems;
  assert.equal(missing.some((item) => item.includes("PILOT_USERIDS")), true);
  assert.equal(missing.some((item) => item.includes("真实 LLM_API_KEY")), true);

  const valid = readConfig({
    DAILY_ASSISTANT_WORK_DISCOVERY_ENABLED: "1",
    DAILY_ASSISTANT_WORK_DISCOVERY_PILOT_USERIDS: "pilot-a",
    LLM_API_KEY: "test-key",
  }).problems;
  assert.deepEqual(valid, []);
});
