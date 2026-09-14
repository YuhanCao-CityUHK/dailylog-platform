import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { EvidenceWithReference } from "../src/assistant/evidence-store";
import { clusterWorkItems } from "../src/assistant/work-item-clusterer";

test("大量临时证据聚合仍保持候选上限和可交互耗时", () => {
  const evidences: EvidenceWithReference[] = Array.from({ length: 400 }, (_, index) => ({
    referenceId: `perf-${index}`,
    expiresAt: "2026-08-25T20:00:00.000Z",
    evidence: {
      sourceType: "document",
      externalId: `doc-${index}`,
      title: `独立交付${index}`,
      summary: `完成独立交付${index}`,
      occurredAt: "2026-08-25T09:00:00+08:00",
      actorUserIds: ["perf-user"],
      actorNames: ["性能测试员工"],
      participantNames: [],
      privacyScope: "normal",
      projectSignals: [`项目${index}`],
      evidenceStrength: "strong",
    },
  }));
  const started = performance.now();
  const candidates = clusterWorkItems(evidences, "2026-08-25");
  const elapsed = performance.now() - started;
  assert.equal(candidates.length <= 8, true);
  assert.equal(elapsed < 2_000, true, `聚合耗时 ${elapsed.toFixed(1)}ms 超过离线验收阈值`);
});

test("新版会话协议显式请求 202 轮询并使用独立静态资源版本", () => {
  const routes = readFileSync(new URL("../src/assistant/routes.ts", import.meta.url), "utf8");
  const conversationRoute = routes.slice(
    routes.indexOf('router.get("/api/daily-assistant/conversation"'),
    routes.indexOf('router.post("/api/daily-assistant/conversation/message"'),
  );
  assert.match(conversationRoute, /searchParams\.get\("analysis_poll"\) === "1"/);
  assert.match(conversationRoute, /candidateService\.usesRolloutAnalysis\(user\)/);
  assert.match(conversationRoute, /candidateService\.prepare\(/);
  assert.match(conversationRoute, /sendJson\(ctx\.res, 202/);
  assert.match(conversationRoute, /ready:\s*false/);
  assert.match(conversationRoute, /analysisRunning:\s*true/);

  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const polling = app.slice(
    app.indexOf("function pollAssistantConversation"),
    app.indexOf("function loadDwsAssistant"),
  );
  assert.match(polling, /\/api\/daily-assistant\/conversation\?analysis_poll=1/);
  assert.match(polling, /conversationData\.ready === false && conversationData\.analysisRunning/);
  assert.match(polling, /setTimeout\(function \(\) \{ pollAssistantConversation\(data\); \}, 1000\)/);
  assert.match(app, /analyzing \? "工作分析中" : "上下文准备中"/);

  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(index, /\/app\.js\?v=20260908-vivoflow/);
});
