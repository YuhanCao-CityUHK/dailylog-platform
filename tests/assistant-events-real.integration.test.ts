import assert from "node:assert/strict";
import test from "node:test";
import { EventModelClient } from "../src/assistant/events/event-model-client";
import { OpenAiCompatibleEventProvider } from "../src/assistant/events/openai-compatible-event-provider";
import { EVENT_FUSION_SYSTEM_PROMPT } from "../src/assistant/events/prompts/event-fusion-v1";
import { CONFIG } from "../src/infra/config";

const enabled = process.env.DAILY_ASSISTANT_REAL_MODEL_TEST === "1";

test("真实 OpenAI 兼容事件模型返回可校验 JSON 和 Token 统计", { skip: !enabled }, async () => {
  const baseUrl = CONFIG.llm.primary.baseUrl;
  const apiKey = CONFIG.llm.primary.apiKey;
  const model = CONFIG.assistant.eventPrimaryModel;
  assert.ok(baseUrl && apiKey && model, "显式真实模型测试需要 LLM_BASE_URL、LLM_API_KEY 和固定事件模型快照");
  const provider = new OpenAiCompatibleEventProvider({
    providerName: "real-integration",
    baseUrl,
    apiKey,
    model,
    timeoutMs: CONFIG.assistant.eventModelTimeoutMs,
  });
  const result = await new EventModelClient([provider]).analyze({
    phase: "fuse",
    systemPrompt: EVENT_FUSION_SYSTEM_PROMPT,
    promptVersion: "event-fusion-v1",
    maxOutputTokens: 2000,
    payload: {
      workDate: "2026-08-25",
      employee: { userId: 1, displayName: "集成员工" },
      completeness: [{ source: "document", complete: true, hasMore: false, failures: 0, pagesFetched: 1, itemCount: 1 }],
      bundles: [{
        bundleId: "integration-bundle",
        bundleType: "cross_source",
        evidenceIds: ["integration-evidence"],
        sourceTypes: ["document"],
        completeness: "complete",
        items: [{
          evidenceId: "integration-evidence",
          sourceType: "document",
          title: "日报助手接口验证",
          summary: "集成员工完成日报助手接口验证并形成测试结果",
          occurredAt: "2026-08-25T15:00:00+08:00",
          actorNames: ["集成员工"],
          participantNames: ["集成员工"],
          relationToSelf: "self",
          temporalRole: "today",
          workUse: "direct_work",
          sourceCompleteness: "complete",
          projectSignals: ["日报助手"],
          resourceRefs: [],
          linkedObjectIds: [],
        }],
      }],
    },
  });
  assert.equal(result.output.schemaVersion, "work-event-v1");
  assert.ok(result.inputTokens > 0);
  assert.ok(result.outputTokens > 0);
  assert.equal(result.model, model);
});
