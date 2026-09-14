import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { createContextDatabase } from "../src/assistant/context-db";
import { ContextJobStore } from "../src/assistant/context-jobs";
import { ContextOrchestrator } from "../src/assistant/context-orchestrator";
import { deterministicEvidenceFilter } from "../src/assistant/evidence-filter";
import { EvidenceStore } from "../src/assistant/evidence-store";
import type { CollectorInput, ContextCollector, JsonObject } from "../src/assistant/schema";
import { workInteractionCollector } from "../src/dws/collectors/work-interaction-collector";

const workDate = "2026-09-02";

function input(run: CollectorInput["run"]): CollectorInput {
  return {
    platformUserId: 7,
    ddUserid: "user-1",
    selfUserIds: ["user-1", "open-user-1"],
    displayName: "测试员工",
    profile: "corp:user-1",
    workDate,
    historyWorkDates: [],
    now: new Date("2026-09-02T10:00:00+08:00"),
    run,
  };
}

test("OA 与 DING 只保留当天工作交互，并区分本人动作和入站任务", async () => {
  const commands: string[] = [];
  const result = await workInteractionCollector.collect(input(async (args): Promise<JsonObject> => {
    const command = args.join(" ");
    commands.push(command);
    assert.match(command, /^--profile corp:user-1 /);
    assert.match(command, / --format json$/);
    if (command.includes("oa approval list-pending")) {
      return {
        result: [
          { taskId: "pending-1", processName: "产品代码审批", originatorName: "王海刚", status: "RUNNING" },
          { taskId: "pending-2", processName: "产品代码审批", originatorName: "王海刚", status: "RUNNING" },
        ],
      };
    }
    if (command.includes("oa approval list-executed")) {
      return {
        result: [
          { taskId: "done-1", processName: "车辆使用审批", operateTime: "2026-09-02T09:54:00+08:00", status: "AGREE" },
          { taskId: "old-1", processName: "旧审批", operateTime: "2026-09-01T09:54:00+08:00", status: "AGREE" },
        ],
      };
    }
    if (command.includes("ding message list")) {
      return {
        result: [
          { openDingId: "ding-in", content: "请跟进供应商报价", createTime: "2026-09-02T10:10:00+08:00", type: "RECEIVE", senderUserId: "manager-1" },
          { openDingId: "ding-out", content: "提醒王海刚审批", createTime: "2026-09-02T10:20:00+08:00", type: "SEND", senderUserId: "user-1" },
          { openDingId: "ding-old", content: "昨天提醒", createTime: "2026-09-01T10:20:00+08:00", type: "RECEIVE" },
        ],
      };
    }
    if (command.includes("chat +at-me")) {
      // DWS v1.0.59 shortcut's production projection: conversation/sender/time are strings.
      const item = {
        messageId: "at-me-1",
        conversationId: "cid-project",
        conversation: "项目大群",
        sender: "李咏赋",
        text: "@杨工 请准备活动照片并发布公司大群",
        time: "2026-09-02T13:34:00+08:00",
      };
      return {
        contractVersion: "im.message-list.v1",
        messages: [item, { ...item }, {
          ...item,
          messageId: "at-me-old",
          time: "2026-09-01T13:34:00+08:00",
        }, {
          ...item,
          messageId: "at-me-system",
          sender: "钉钉系统通知",
          time: "2026-09-02T14:00:00+08:00",
        }],
        complete: true,
        hasMore: false,
        pagesFetched: 1,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  }));

  assert.equal(result.status, "complete");
  assert.equal(result.evidences.length, 6);
  assert.deepEqual(result.evidences.map((item) => item.externalId).sort(), ["at-me-1", "ding-in", "ding-out", "done-1", "pending-1", "pending-2"]);
  assert.deepEqual(
    result.evidences.find((item) => item.externalId === "pending-1") && {
      relation: result.evidences.find((item) => item.externalId === "pending-1")!.relationToSelf,
      workUse: result.evidences.find((item) => item.externalId === "pending-1")!.workUse,
      resultEligible: result.evidences.find((item) => item.externalId === "pending-1")!.resultEligible,
    },
    { relation: "addressed", workUse: "task_signal", resultEligible: false },
  );
  assert.equal(result.evidences.find((item) => item.externalId === "done-1")?.workUse, "direct_work");
  assert.equal(result.evidences.find((item) => item.externalId === "done-1")?.resultEligible, true);
  assert.equal(result.evidences.find((item) => item.externalId === "ding-in")?.relationToSelf, "addressed");
  assert.equal(result.evidences.find((item) => item.externalId === "ding-out")?.relationToSelf, "self");
  assert.deepEqual(
    result.evidences.find((item) => item.externalId === "at-me-1") && {
      relation: result.evidences.find((item) => item.externalId === "at-me-1")!.relationToSelf,
      workUse: result.evidences.find((item) => item.externalId === "at-me-1")!.workUse,
      conversationId: result.evidences.find((item) => item.externalId === "at-me-1")!.conversationId,
    },
    { relation: "addressed", workUse: "task_signal", conversationId: "cid-project" },
  );
  assert.equal(result.evidences.find((item) => item.externalId === "at-me-1")?.title, "项目大群");
  assert.deepEqual(result.evidences.find((item) => item.externalId === "at-me-1")?.actorNames, ["李咏赋"]);
  assert.deepEqual(result.evidences.find((item) => item.externalId === "at-me-1")?.actorUserIds, []);
  assert.equal(result.evidences.some((item) => item.externalId === "at-me-system"), false);
  assert.equal(result.evidences.filter((item) => item.sourceType === "ding").every((item) => item.resultEligible === false), true);
  const filtered = deterministicEvidenceFilter(result.evidences.map((evidence, index) => ({
    referenceId: `ref-${index}`,
    jobId: "job-1",
    userId: 7,
    workDate,
    evidence,
    expiresAt: "2026-09-03T00:00:00.000Z",
  })));
  assert.equal(filtered.filter((item) => item.evidence.sourceType === "approval").length, 3,
    "同名但不同 taskId 的审批不能按标题误去重");
  assert.equal(commands.some((command) => command.includes("oa approval list-pending")
    && command.includes("--start 2026-09-01T17:30:00+08:00")
    && command.includes("--end 2026-09-02T17:30:00+08:00")), true);
  assert.equal(commands.some((command) => command.includes("ding message list --type ALL --cursor 0")), true);
  assert.equal(commands.some((command) => command.includes("chat +at-me --days 2 --page-all --page-limit 50")), true);
});

test("一个工作交互子来源失败时保留其它 OA/DING 结果并标记 partial", async () => {
  const result = await workInteractionCollector.collect(input(async (args): Promise<JsonObject> => {
    const command = args.join(" ");
    if (command.includes("oa approval list-pending")) {
      throw Object.assign(new Error("forbidden detail"), { safeCode: "permission_denied" });
    }
    if (command.includes("oa approval list-executed")) {
      return { result: [{ taskId: "done-1", processName: "报废审批", operateTime: "2026-09-02T09:00:00+08:00" }] };
    }
    if (command.includes("ding message list")) return { result: [] };
    if (command.includes("chat +at-me")) return { messages: [], complete: true, hasMore: false };
    throw new Error(`unexpected command: ${command}`);
  }));

  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, "permission_denied");
  assert.equal(result.evidences.length, 1);
  assert.equal(result.evidences[0].externalId, "done-1");
  assert.equal(result.evidences[0].sourceCompleteness, "partial");
});

test("所有 OA/DING 子来源都失败时必须标记 error", async () => {
  const result = await workInteractionCollector.collect(input(async () => {
    throw Object.assign(new Error("unavailable"), { safeCode: "service_unavailable" });
  }));

  assert.equal(result.status, "error");
  assert.equal(result.evidences.length, 0);
  assert.equal(result.completeness?.failures, 4);
  assert.equal(result.errorCode, "service_unavailable");
});

test("工作交互 collector 仅对工作发现灰度用户运行", async () => {
  const user: SessionUser = {
    id: 11,
    kind: "dingtalk",
    ddUserid: "user-11",
    name: "测试员工",
    title: "",
    dept: "研发部",
    role: "emp",
    isExternal: false,
    mustChangePw: false,
  };
  let calls = 0;
  const collector: ContextCollector = {
    source: "work_interactions",
    async collect() {
      calls += 1;
      return { source: "work_interactions", status: "empty", evidences: [] };
    },
  };
  const create = (enabled: boolean) => {
    const db = createContextDatabase(":memory:");
    const orchestrator = new ContextOrchestrator({
      jobStore: new ContextJobStore(db),
      evidenceStore: new EvidenceStore(db, Buffer.alloc(32, 1)),
      collectors: [collector],
      connectionInspector: async () => ({
        enabled: true,
        available: true,
        connected: true,
        state: "connected",
        profile: "corp:user-11",
      }),
      dwsJsonRunner: async () => ({}),
      workDiscoveryEnabledForUser: () => enabled,
    });
    return { db, orchestrator };
  };

  const disabled = create(false);
  const disabledJob = disabled.orchestrator.start(user, workDate);
  await disabled.orchestrator.waitForIdle(disabledJob.id);
  assert.equal(calls, 0);
  assert.equal(disabled.orchestrator.get(user.id, workDate)?.sources.length, 0);
  disabled.db.close();

  const enabled = create(true);
  const enabledJob = enabled.orchestrator.start(user, workDate);
  await enabled.orchestrator.waitForIdle(enabledJob.id);
  assert.equal(calls, 1);
  assert.equal(enabled.orchestrator.get(user.id, workDate)?.sources[0]?.source, "work_interactions");
  enabled.db.close();
});
