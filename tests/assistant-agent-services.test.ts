import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { GatedWorkEvidence } from "../src/assistant/temporal-gate";
import {
  HybridWorkItemAnalysisService,
  validateModelWorkItemOutput,
  type WorkItemModel,
} from "../src/assistant/work-item-analysis-service";

function gated(origin: "today" | "continuation"): GatedWorkEvidence {
  return {
    referenceId: `ref-${origin}`,
    expiresAt: "2026-08-25T20:00:00.000Z",
    origin,
    workSummary: "推进日报助手项目匹配和提交链路验证",
    resultHint: origin === "today" ? "已定位匹配失败原因并完成模拟验证" : "",
    projectSignals: ["工作日志平台"],
    confidence: 0.9,
    evidence: {
      sourceType: origin === "today" ? "document" : "dingtalk_report",
      externalId: `external-${origin}`,
      title: origin === "today" ? "日报助手验证文档" : "示例管理员的总经办日志",
      summary: origin === "today" ? "已定位匹配失败原因并完成模拟验证" : "历史已完成正文",
      occurredAt: origin === "today" ? "2026-08-25T10:00:00+08:00" : "2026-08-24T18:00:00+08:00",
      actorUserIds: ["employee-1"],
      actorNames: ["测试员工"],
      participantNames: [],
      privacyScope: "normal",
      projectSignals: ["工作日志平台"],
      evidenceStrength: "strong",
    },
  };
}

test("模型事项输出经过 Schema 校验，continuation 的历史结果被服务端硬清空", async () => {
  const model: WorkItemModel = {
    async analyze() {
      return {
        items: [{
          workSummary: "推进日报助手项目匹配和提交链路验证",
          resultHint: "错误沿用了历史完成结果",
          origin: "continuation",
          referenceIds: ["ref-continuation"],
          projectSignals: ["工作日志平台"],
          needsConfirmation: ["hours"],
          confidence: 0.88,
        }],
      };
    },
  };
  const result = await new HybridWorkItemAnalysisService(model).analyze({
    workDate: "2026-08-25",
    evidences: [gated("continuation")],
  });
  assert.equal(result.mode, "model");
  assert.equal(result.items[0].origin, "continuation");
  assert.equal(result.items[0].resultHint, "");
  assert.match(result.items[0].needsConfirmation.join(","), /result/);
  assert.throws(() => validateModelWorkItemOutput({ items: [{ workSummary: "无效" }] }));
});

test("模型返回来源容器名时自动降级为确定性整理", async () => {
  const model: WorkItemModel = {
    async analyze() {
      return {
        items: [{
          workSummary: "示例管理员的总经办日志",
          resultHint: "",
          origin: "continuation",
          referenceIds: ["ref-continuation"],
          projectSignals: [],
          needsConfirmation: ["result", "hours"],
          confidence: 0.9,
        }],
      };
    },
  };
  const result = await new HybridWorkItemAnalysisService(model).analyze({
    workDate: "2026-08-25",
    evidences: [gated("continuation")],
  });
  assert.equal(result.mode, "deterministic");
  assert.equal(result.items[0].title, "推进日报助手项目匹配和提交链路验证");
});

test("模型聚合大量聊天证据时只保留前二十条引用", () => {
  const output = validateModelWorkItemOutput({
    items: [{
      workSummary: "汇总客户流程调整并完成验证",
      resultHint: "已完成流程调整",
      origin: "today",
      referenceIds: Array.from({ length: 25 }, (_, index) => `ref-${index + 1}`),
      projectSignals: [],
      needsConfirmation: ["hours"],
      confidence: 0.86,
    }],
  });
  assert.equal(output.items[0].referenceIds.length, 20);
  assert.deepEqual(output.items[0].referenceIds.slice(0, 2), ["ref-1", "ref-2"]);
});

test("conversation 首屏保留来源状态、待确认状态和三项快捷操作", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderAssistantConversation");
  const end = source.indexOf("function renderAssistantSubmitted", start);
  const conversationRenderer = source.slice(start, end);
  assert.match(conversationRenderer, /assistantSourceStatusHtml\(\(contextData\.job/);
  assert.match(conversationRenderer, /候选已准备 · 待确认/);
  assert.match(conversationRenderer, /这些基本准确/);
  assert.match(conversationRenderer, /有几项不对/);
  assert.match(conversationRenderer, /补充其他工作/);
  assert.doesNotMatch(conversationRenderer, /已自动保存/);
  assert.match(conversationRenderer, /data\.promptKind === "confirm_candidates"/);
  assert.match(conversationRenderer, /scrollTop =/);
  assert.match(source, /已读取：/);
  assert.match(source, /暂不可用：/);
});
