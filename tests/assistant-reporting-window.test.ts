import assert from "node:assert/strict";
import test from "node:test";
import { assistantReportingWindow, isInAssistantReportingWindow } from "../src/assistant/reporting-window";
import { dayWindow, happenedOnWorkDate } from "../src/dws/collectors/shared";
import { applyTemporalGate } from "../src/assistant/temporal-gate";
import type { EvidenceWithReference } from "../src/assistant/evidence-store";
import { chatCollector } from "../src/dws/collectors/chat-collector";

test("北京时间17:30窗口跨月、跨年、闰日均连续且恰好24小时", () => {
  for (const [date, previous] of [["2027-01-01", "2026-12-31"], ["2028-03-01", "2028-02-29"], ["2026-09-07", "2026-09-06"]]) {
    const window = assistantReportingWindow(date);
    assert.deepEqual(window, { start: `${previous}T17:30:00+08:00`, end: `${date}T17:30:00+08:00` });
    assert.equal(Date.parse(window.end) - Date.parse(window.start), 86_400_000);
    assert.equal(assistantReportingWindow(previous).end, window.start);
    assert.deepEqual(dayWindow(date), window);
    for (const [stamp, expected] of [
      [Date.parse(window.start) - 1, false], [Date.parse(window.start), true],
      [Date.parse(window.end) - 1, true], [Date.parse(window.end), false],
    ] as const) {
      assert.equal(isInAssistantReportingWindow(new Date(stamp).toISOString(), date), expected);
      assert.equal(happenedOnWorkDate(String(stamp), date), expected, "DWS 毫秒时间戳与模型闸门一致");
    }
  }
  assert.equal(isInAssistantReportingWindow("invalid", "2026-09-07"), false);
});

test("采集查询与候选闸门保留昨晚内容，排除窗口前及本日17:30之后内容", async () => {
  const times = ["2026-09-06T17:29:59+08:00", "2026-09-06T17:30:00+08:00", "2026-09-06T23:50:00+08:00", "2026-09-07T01:00:00+08:00", "2026-09-07T17:29:59+08:00", "2026-09-07T17:30:00+08:00"];
  const commands: string[][] = [];
  const result = await chatCollector.collect({
    platformUserId: 1, ddUserid: "self", profile: "test", workDate: "2026-09-07", historyWorkDates: [],
    now: new Date("2026-09-07T18:00:00+08:00"),
    run: async (args) => {
      commands.push(args);
      if (args.includes("+chat-messages")) return {
        messages: times.map((sendTime, index) => ({ id: `message-${index}`, content: `完成接口联调检查步骤${index}`, senderId: "self", sendTime })),
        complete: true, hasMore: false,
      };
      return { conversations: [{ conversationId: "group-1", conversationType: "2", title: "项目群" }], hasMore: false };
    },
  });
  assert.deepEqual(result.evidences.map((item) => item.externalId), ["message-1", "message-2", "message-3", "message-4"]);
  const query = commands.find((args) => args.includes("+chat-messages"))!;
  assert.equal(query[query.indexOf("--start") + 1], "2026-09-06T17:30:00+08:00");
  assert.equal(query[query.indexOf("--end") + 1], "2026-09-07T17:30:00+08:00");
  const refs: EvidenceWithReference[] = result.evidences.map((evidence, index) => ({
    referenceId: `ref-${index}`, jobId: "job", userId: 1, workDate: "2026-09-07", expiresAt: "2026-09-08T06:00:00Z",
    evidence: { ...evidence, analysisTitle: `接口联调步骤${index}`, temporalRole: "today", workUse: "direct_work" },
  }));
  assert.equal(applyTemporalGate(refs, "2026-09-07").candidateEvidence.length, 4);
  assert.equal(applyTemporalGate(refs, "2026-09-06").candidateEvidence.length, 0);
});
