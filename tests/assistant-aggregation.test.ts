import assert from "node:assert/strict";
import test from "node:test";
import { deterministicEvidenceFilter } from "../src/assistant/evidence-filter";
import type { EvidenceWithReference } from "../src/assistant/evidence-store";
import { HybridWorkItemAnalysisService } from "../src/assistant/work-item-analysis-service";
import { clusterWorkItems } from "../src/assistant/work-item-clusterer";
import { applyTemporalGate } from "../src/assistant/temporal-gate";

function evidence(
  referenceId: string,
  sourceType: EvidenceWithReference["evidence"]["sourceType"],
  title: string,
  summary: string,
  strength: EvidenceWithReference["evidence"]["evidenceStrength"] = "medium",
): EvidenceWithReference {
  return {
    referenceId,
    expiresAt: "2026-08-25T20:00:00.000Z",
    evidence: {
      sourceType,
      externalId: referenceId,
      title,
      summary,
      occurredAt: "2026-08-25T09:00:00+08:00",
      actorUserIds: ["user-1"],
      actorNames: ["测试员工"],
      participantNames: [],
      privacyScope: sourceType === "chat_private" ? "employee_only" : "normal",
      projectSignals: ["日报助手"],
      evidenceStrength: strength,
    },
  };
}

test("确定性去噪并将会议、听记和沟通并入实际任务", () => {
  const filtered = deterministicEvidenceFilter([
    evidence("noise", "chat_group", "日报助手群", "收到"),
    evidence("doc", "document", "日报助手开发方案", "完成上下文任务方案结构", "strong"),
    evidence("calendar", "calendar", "日报助手方案评审", "讨论上下文任务方案"),
    evidence("minutes", "minutes", "日报助手方案评审", "讨论任务状态与数据边界"),
    evidence("chat", "chat_group", "日报助手方案讨论", "确认接口边界和下一步"),
  ]);
  assert.equal(filtered.some((item) => item.referenceId === "noise"), false);
  const clusters = clusterWorkItems(filtered, "2026-08-25");
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0].sourceTypes), new Set(["document", "calendar", "minutes", "chat_group"]));
  assert.match(clusters[0].resultHint, /完成上下文任务方案结构/);
  assert.deepEqual(clusters[0].needsConfirmation, ["hours"]);
});

test("无输出的单独会议不成项，有明确交付结论的沟通可独立成项", () => {
  const noOutput = clusterWorkItems(
    [evidence("meeting", "calendar", "项目例会", "同步进展，没有结论", "weak")],
    "2026-08-25",
  );
  assert.equal(noOutput.length, 0);
  const delivered = clusterWorkItems(
    [evidence("review", "minutes", "方案评审", "形成评审结论：采用后台任务方案")],
    "2026-08-25",
  );
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].resultHint, /形成评审结论/);
});

test("模型失败时聊天 Markdown、附件标识和链接不会进入兜底候选", async () => {
  const noisy = evidence(
    "chat-noisy",
    "chat_group",
    "工作会话",
    "#### 我更新了「OA系统流程指引」并完成表格调整 > ###### 叶鹏确认采用新版流程\n(https://alidocs.dingtalk.com/i/nodes/example)\n[图片消息](mediaId=QLPJX08FZWY2EPNA8JNBZAWIQA2NCDEO4QKX2AKEEPIAA)\n@开发者小助手 文件下载报错 unsupported file type",
  );
  const attachment = evidence(
    "chat-attachment",
    "chat_group",
    "工作会话",
    "[图片消息](mediaId=QLPJX08FZWY2EPNA8JNBZAWIQA2NCDEO4QKX2AKEEPIAA)",
  );
  const filtered = deterministicEvidenceFilter([noisy, attachment]);
  assert.equal(filtered.length, 1);
  assert.doesNotMatch(filtered[0].evidence.summary, /####|https?:\/\/|mediaId|unsupported file type|@开发者小助手/i);
  assert.match(filtered[0].evidence.summary, /更新了「OA系统流程指引」/);
  assert.match(filtered[0].evidence.summary, /不支持该文件类型/);

  const gated = applyTemporalGate(filtered, "2026-08-25").candidateEvidence;
  assert.equal(gated[0].workSummary, "我更新了「OA系统流程指引」并完成表格调整");
  const result = await new HybridWorkItemAnalysisService({
    async analyze() {
      throw new SyntaxError("invalid model JSON");
    },
  }).analyze({ workDate: "2026-08-25", evidences: gated });
  assert.equal(result.mode, "deterministic");
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].title, /更新了「OA系统流程指引」/);
  assert.doesNotMatch(`${result.items[0].title}\n${result.items[0].resultHint}`, /工作会话|####|https?:\/\/|mediaId|unsupported file type/i);
});

test("候选事项严格限制为最多八项", () => {
  const topics = [
    "光学仿真",
    "客户支持",
    "法规注册",
    "采购核对",
    "算法训练",
    "样机装配",
    "专利检索",
    "培训组织",
    "库存盘点",
    "展会准备",
    "合同审阅",
    "设备维护",
  ];
  const items = topics.map((topic, index) => {
    const item = evidence(`doc-${index}`, "document", topic, `${topic}完成`, "strong");
    item.evidence.projectSignals = [topic];
    return item;
  });
  assert.equal(clusterWorkItems(items, "2026-08-25").length, 8);
});
