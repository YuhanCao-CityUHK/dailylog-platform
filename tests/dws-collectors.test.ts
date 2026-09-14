import assert from "node:assert/strict";
import test from "node:test";
import type { CollectorInput, ContextCollector, JsonObject } from "../src/assistant/schema";
import { classifyDwsFailure } from "../src/dws/client";
import { runCommand } from "../src/dws/collectors/shared";
import {
  attendanceApprovalCollector,
  calendarCollector,
  chatCollector,
  dingtalkReportCollector,
  documentCollector,
  minutesCollector,
  todoCollector,
  wikiCollector,
} from "../src/dws/collectors/index";

const now = new Date("2026-08-25T04:00:00.000Z");

function input(run: CollectorInput["run"]): CollectorInput {
  return {
    platformUserId: 7,
    ddUserid: "user-1",
    displayName: "测试员工",
    profile: "corp:user-1",
    workDate: "2026-08-25",
    historyWorkDates: ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-25"],
    now,
    run,
  };
}

function fixtureRunner(commands: string[] = []): CollectorInput["run"] {
  return async (args): Promise<JsonObject> => {
    const command = args.join(" ");
    commands.push(command);
    assert.match(command, /^--profile corp:user-1 /);
    assert.match(command, / --format json$/);
    if (command.includes("chat list-all-conversations")) {
      return {
        result: {
          conversations: [{ openConversationId: "private-chat", title: "日报项目讨论", singleChat: true }],
          hasMore: false,
          nextCursor: 0,
        },
      };
    }
    if (command.includes("chat +chat-messages")) {
      return { messages: [{ id: "message-1", content: "完成上下文任务接口联调", senderId: "user-1", senderName: "测试员工", sendTime: "2026-08-25T09:00:00+08:00" }], complete: true };
    }
    if (command.includes("doc +search")) {
      return {
        documents: [
          { nodeId: "read-only", name: "只读文档", docType: "adoc" },
          { nodeId: "edited", name: "日报助手方案", docType: "adoc" },
        ],
        complete: true,
      };
    }
    if (command.includes("doc +version-list") && command.includes("read-only")) return { versions: [], hasMore: false };
    if (command.includes("doc +version-list") && command.includes("edited")) {
      return { versions: [{ userId: "user-1", updateTime: "2026-08-25T09:10:00+08:00" }], hasMore: false };
    }
    if (command.includes("doc +fetch") && command.includes("edited")) {
      return {
        content: {
          title: "日报助手方案",
          nodeId: "edited",
          docUrl: "https://alidocs.dingtalk.com/i/nodes/edited",
          markdown: "# 日报助手方案\n补充多来源失败降级设计",
        },
      };
    }
    if (command.includes("doc +fetch") && command.includes("wiki-node")) {
      return {
        content: {
          title: "日报助手知识库",
          nodeId: "wiki-node",
          docUrl: "https://alidocs.dingtalk.com/i/nodes/wiki-node",
          markdown: "# 日报助手\n完成跨来源工作事项融合方案",
        },
      };
    }
    if (command.includes("wiki +space-list")) {
      return { ok: true, outcome: "success", data: { autoPageComplete: true, count: 1, hasMore: false, pagesFetched: 1, spaces: [{ workspaceId: "workspace-1", name: "研发知识库" }] } };
    }
    if (command.includes("wiki +feed-list")) {
      return {
        ok: true,
        outcome: "success",
        data: {
          autoPageComplete: true,
          count: 1,
          hasMore: false,
          pagesFetched: 1,
          feeds: [{
            id: "wiki-1",
            content: JSON.stringify({
              doc: { dentryUuid: "wiki-node", extension: "adoc", name: "日报助手知识库" },
              users: [{ id: "user-1", nick: "测试员工" }],
            }),
            time: Date.parse("2026-08-25T09:20:00+08:00"),
          }],
        },
      };
    }
    if (command.includes("calendar event list")) {
      return {
        result: { events: [
            { id: "event-1", title: "日报助手评审", description: "形成采集器接口结论", status: "confirmed", startTime: "2026-08-25T09:30:00+08:00" },
            { id: "event-2", title: "已取消会议", status: "cancelled", startTime: "2026-08-25T10:00:00+08:00" },
          ] },
      };
    }
    if (command.includes("minutes list all")) {
      return {
        result: {
          itemList: [{ id: "minutes-1", title: "上下文方案讨论", startTime: "2026-08-25T10:00:00+08:00" }],
          hasMore: false,
          nextToken: "0",
        },
      };
    }
    if (command.includes("minutes get summary")) return { result: { summary: "确定 Reference 只保留 12 小时" } };
    if (command.includes("minutes get todos")) return { result: [{ title: "补充过期测试" }] };
    if (command.includes("todo +get-my-tasks") && command.includes("--status false")) {
      return { ok: true, outcome: "success", data: { complete: true, todos: [{ id: "todo-open", title: "补充上下文测试", description: "等待执行" }] } };
    }
    if (command.includes("todo +get-my-tasks") && command.includes("--status true")) {
      return { ok: true, outcome: "success", data: { complete: true, todos: [{ id: "todo-done", title: "完成 Runner 改造", finishTime: "2026-08-25T11:00:00+08:00" }] } };
    }
    if (command.includes("report outbox list")) return { result: [{ reportId: "report-1", report_name: "昨日工作日志", createTime: "2026-08-22T18:00:00+08:00", report_content: [{ key: "明日计划", value: "继续开发日报助手" }] }] };
    if (command.includes("attendance +list-approve")) {
      return { ok: true, data: { approvals: [{ id: "leave-1", type: "部分请假", status: "approved", startTime: "2026-08-25T13:00:00+08:00" }] } };
    }
    throw new Error(`unexpected fixture command: ${command}`);
  };
}

test("八类 DWS 采集器只用模拟 Schema 归一化证据", async () => {
  const commands: string[] = [];
  const collectors: ContextCollector[] = [
    chatCollector,
    documentCollector,
    wikiCollector,
    calendarCollector,
    minutesCollector,
    todoCollector,
    dingtalkReportCollector,
    attendanceApprovalCollector,
  ];
  const results = await Promise.all(collectors.map((collector) => collector.collect(input(fixtureRunner(commands)))));
  assert.equal(
    results.every((result) => result.status === "complete"),
    true,
    JSON.stringify(results.map((result) => ({ source: result.source, status: result.status, completeness: result.completeness }))),
  );
  const bySource = new Map(results.map((result) => [result.source, result]));
  assert.equal(bySource.get("chat")?.evidences[0].sourceType, "chat_private");
  assert.equal(bySource.get("chat")?.evidences[0].privacyScope, "employee_only");
  assert.equal(bySource.get("document")?.evidences.length, 1, "仅阅读文档必须排除");
  assert.equal(bySource.get("document")?.evidences[0].externalId, "edited");
  assert.match(bySource.get("document")?.evidences[0].analysisSummary ?? "", /多来源失败降级设计/);
  assert.equal(bySource.get("wiki")?.evidences[0].title, "日报助手知识库");
  assert.match(bySource.get("wiki")?.evidences[0].analysisSummary ?? "", /跨来源工作事项融合方案/);
  assert.doesNotMatch(bySource.get("wiki")?.evidences[0].summary ?? "", /\{\"doc\"/);
  assert.equal(bySource.get("calendar")?.evidences.length, 1, "取消日程必须排除");
  assert.equal(bySource.get("todo")?.evidences.length, 2);
  assert.equal(bySource.get("attendance_approval")?.evidences.some((item) => item.sourceType === "attendance"), true);
  assert.equal(bySource.get("attendance_approval")?.evidences.every((item) => item.evidenceStrength === "weak"), true);
  assert.equal(bySource.get("dingtalk_report")?.evidences[0].temporalRole, "previous_workday");
  assert.equal(bySource.get("dingtalk_report")?.evidences[0].workUse, "continuation_hint");
  assert.equal(bySource.get("dingtalk_report")?.evidences[0].analysisTitle, "继续开发日报助手");
  assert.equal(bySource.get("dingtalk_report")?.evidences[0].resultEligible, false);
  assert.equal(commands.some((command) => command.includes("chat list-all-conversations --limit 100 --cursor 0")), true);
  assert.equal(commands.some((command) => command.includes("chat +chat-messages --group private-chat")
    && command.includes("--order asc --page-all --page-limit 50")), true);
  assert.equal(commands.some((command) => command.includes("doc +search --page-all --limit 20 --max-pages 2 --max-items 40")), true);
  assert.equal(commands.some((command) => command.includes("doc +version-list --node edited --limit 50")), true);
  assert.equal(commands.some((command) => command.includes("doc +fetch --node edited")), true);
  assert.equal(commands.some((command) => command.includes("doc +fetch --node wiki-node")), true);
  assert.equal(commands.some((command) => command.includes("doc +inspect")), false);
  assert.equal(commands.some((command) => command.includes("wiki +space-list --type orgWikiSpace --limit 50 --page-all --page-limit 20 --max-items 500")), true);
  assert.equal(commands.some((command) => command.includes("wiki +feed-list --workspace workspace-1 --limit 20 --page-all --page-limit 20 --max-items 500")), true);
  assert.equal(commands.some((command) => command.includes("calendar event list") && command.includes("--limit 100")), true);
  assert.equal(commands.some((command) => command.includes("minutes list all") && command.includes("--limit 20")), true);
  assert.equal(commands.some((command) => command.includes("minutes get todos --id minutes-1") && !command.includes("--page-all")), true);
  assert.equal(commands.some((command) => command.includes("todo +get-my-tasks --all --max-pages 40 --size 20")), true);
  assert.equal(commands.some((command) => command.includes("report outbox list") && command.includes("--cursor 0 --size 20")), true);
  assert.equal(commands.some((command) => command.includes("attendance +list-approve --users user-1 --types overtime,leave,trip,patch --start 2026-08-25 --end 2026-08-25")), true);
  assert.equal(commands.some((command) => !command.includes("chat ") && command.includes("--page-limit 50")), false);
  assert.equal(commands.some((command) => command.includes("attendance +list-approve") && command.includes("--page-all")), false);
  assert.equal(commands.some((command) => /(?:^| )--(?:page|size) /.test(command) && command.includes("chat ")), false);
  assert.equal(commands.some((command) => command.includes("report entry get") || command.includes("approval +list")), false);
});

test("日历按真实 nextCursor 翻页并保留完整性账本", async () => {
  const commands: string[] = [];
  const result = await calendarCollector.collect(input(async (args) => {
    const command = args.join(" ");
    commands.push(command);
    if (!command.includes("--cursor")) {
      return {
        result: {
          events: [{ id: "event-1", title: "上午评审", startTime: "2026-08-25T09:00:00+08:00" }],
          hasMore: true,
          nextCursor: "cursor-2",
        },
      };
    }
    assert.match(command, /--cursor cursor-2/);
    return {
      result: {
        events: [{ id: "event-2", title: "午前复盘", startTime: "2026-08-25T11:00:00+08:00" }],
        hasMore: false,
      },
    };
  }));

  assert.equal(result.status, "complete");
  assert.equal(result.evidences.length, 2);
  assert.equal(result.completeness?.complete, true);
  assert.equal(result.completeness?.pagesFetched, 2);
  assert.equal(commands.length, 2);
  assert.equal(commands.every((command) => command.includes("--limit 100") && !command.includes("--page-all")), true);
});

test("27 人群聊按发送者、@、回复与机器人类型标注本人关系", async () => {
  const members = Array.from({ length: 27 }, (_, index) => ({ userId: `member-${index}`, name: `成员${index}` }));
  const result = await chatCollector.collect(input(async (args) => {
    const command = args.join(" ");
    if (command.includes("chat list-all-conversations")) {
      return {
        result: {
          conversations: [{ openConversationId: "group-27", title: "研发大群", singleChat: false, members }],
          hasMore: false,
          nextCursor: 0,
        },
      };
    }
    if (command.includes("chat +chat-messages")) {
      return { messages: [
        { id: "bot", content: "日报缺交名单：张三、李四", senderId: "robot-1", senderType: "bot", sendTime: "2026-08-25T09:00:00+08:00" },
        { id: "others", content: "我完成了客户报价修订", senderId: "user-2", senderType: "user", sendTime: "2026-08-25T09:01:00+08:00" },
        { id: "at-self", content: "请处理接口联调", senderId: "user-3", atUsers: [{ userId: "user-1" }], sendTime: "2026-08-25T09:02:00+08:00" },
        { id: "name-self", content: "@测试员工 请补充验收结论", senderId: "user-4", sendTime: "2026-08-25T09:03:00+08:00" },
        { id: "reply-self", content: "这个方案可以继续", senderId: "user-5", threadId: "thread-1", replyTo: { senderId: "user-1", messageId: "self-origin" }, quotedMessageId: "quoted-1", sendTime: "2026-08-25T09:04:00+08:00" },
        { id: "self", content: "我已完成日报助手回归", senderId: "user-1", sendTime: "2026-08-25T09:05:00+08:00" },
        { id: "unknown", content: "完成了不明任务", sendTime: "2026-08-25T09:06:00+08:00" },
      ] };
    }
    throw new Error(`unexpected command: ${command}`);
  }));
  const byId = new Map(result.evidences.map((item) => [item.externalId, item]));
  assert.deepEqual([byId.get("bot")?.relationToSelf, byId.get("bot")?.senderKind], ["bot_or_unknown", "bot"]);
  assert.equal(byId.get("others")?.relationToSelf, "others");
  assert.equal(byId.get("at-self")?.relationToSelf, "addressed");
  assert.equal(byId.get("name-self")?.relationToSelf, "addressed");
  assert.equal(byId.get("reply-self")?.relationToSelf, "addressed");
  assert.deepEqual([
    byId.get("reply-self")?.conversationId,
    byId.get("reply-self")?.threadId,
    byId.get("reply-self")?.replyToMessageId,
    byId.get("reply-self")?.quotedMessageId,
  ], ["group-27", "thread-1", "self-origin", "quoted-1"]);
  assert.equal(byId.get("self")?.relationToSelf, "self");
  assert.deepEqual([byId.get("unknown")?.relationToSelf, byId.get("unknown")?.senderKind], ["bot_or_unknown", "unknown"]);
  assert.equal(result.evidences.every((item) => item.groupMemberCount === 27), true);
});

test("缺少稳定列表字段时返回 schema_error，不能把解析失败伪装成 empty", async () => {
  const result = await chatCollector.collect(input(async () => ({ ok: true })));
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "schema_error");
  assert.equal(result.failureStage, "response_validation");
});

test("听记详情单项失败会标记 partial，不会被静默吞掉", async () => {
  const result = await minutesCollector.collect(input(async (args) => {
    const command = args.join(" ");
    if (command.includes("minutes list all")) return { itemList: [{ id: "minutes-1", title: "会议", startTime: "2026-08-25T10:00:00+08:00" }] };
    if (command.includes("minutes get summary")) return { result: { summary: "结论" } };
    if (command.includes("minutes get todos")) throw new Error("upstream unavailable");
    throw new Error("unexpected");
  }));
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, "collector_failed");
  assert.equal(result.failureStage, "minutes_detail");
  assert.equal(result.evidences.length, 1);
});

test("文档详情只接受 nodeId、dentryUuid 或 URL，绝不把纯数字 dentryId 当 nodeId", async () => {
  const commands: string[] = [];
  const result = await documentCollector.collect(input(async (args) => {
    const command = args.join(" ");
    commands.push(command);
    if (command.includes("doc +search")) return { documents: [{ id: "123456", title: "错误 ID 命名空间" }] };
    throw new Error("不应调用详情命令");
  }));
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "schema_error");
  assert.equal(result.failureStage, "target_selection");
  assert.equal(commands.some((command) => command.includes("doc +version-list") || command.includes("doc +fetch")), false);
});

test("文档版本读取失败保留 DWS 安全失败阶段并受控降级", async () => {
  const result = await documentCollector.collect(input(async (args) => {
    const command = args.join(" ");
    if (command.includes("doc +search")) {
      return { documents: [{ id: "123456", dentryUuid: "node-stable", name: "文档", docType: "adoc" }] };
    }
    if (command.includes("doc +version-list --node node-stable")) {
      throw Object.assign(new Error("raw target detail"), {
        safeCode: "service_unavailable",
        failureStage: "target_resolution",
      });
    }
    throw new Error("unexpected");
  }));
  assert.equal(result.status, "partial");
  assert.equal(result.evidences.length, 0);
  assert.equal(result.errorCode, "service_unavailable");
  assert.equal(result.failureStage, "target_resolution");
});

test("已证明本人今天编辑时，正文读取失败仍保留工作证据并标记 partial", async () => {
  const result = await documentCollector.collect(input(async (args) => {
    const command = args.join(" ");
    if (command.includes("doc +search")) {
      return { documents: [{ nodeId: "node-stable", name: "文档", docType: "adoc" }], complete: true };
    }
    if (command.includes("doc +version-list --node node-stable")) {
      return { versions: [{ userId: "user-1", updateTime: "2026-08-25T09:00:00+08:00" }], hasMore: false };
    }
    if (command.includes("doc +fetch --node node-stable")) {
      throw Object.assign(new Error("raw optional detail"), {
        safeCode: "service_unavailable",
        failureStage: "document_body",
      });
    }
    throw new Error("unexpected");
  }));
  assert.equal(result.status, "partial");
  assert.equal(result.evidences.length, 1);
  assert.match(result.evidences[0].summary, /正文暂未读取/);
  assert.equal(result.errorCode, "service_unavailable");
  assert.equal(result.failureStage, "document_body");
});

test("知识库他人更新只作背景，不读取正文也不冒充本人工作", async () => {
  const commands: string[] = [];
  const result = await wikiCollector.collect(input(async (args) => {
    const command = args.join(" ");
    commands.push(command);
    if (command.includes("wiki +space-list")) {
      return { data: { spaces: [{ workspaceId: "workspace-1" }] }, complete: true };
    }
    if (command.includes("wiki +feed-list")) {
      return {
        data: {
          feeds: [{
            id: "wiki-other",
            content: JSON.stringify({
              doc: { dentryUuid: "other-node", extension: "adoc", name: "销售制度" },
              users: [{ id: "other-user", nick: "其他员工" }],
            }),
            time: Date.parse("2026-08-25T10:00:00+08:00"),
          }],
        },
        complete: true,
      };
    }
    throw new Error(`unexpected: ${command}`);
  }));
  assert.equal(result.status, "complete");
  assert.equal(result.evidences.length, 1);
  assert.equal(result.evidences[0].relationToSelf, "others");
  assert.equal(result.evidences[0].workUse, "background_only");
  assert.equal(result.evidences[0].resultEligible, false);
  assert.equal(commands.some((command) => command.includes("doc +fetch")), false);
});

test("权限错误转换为来源级失败且不会返回原始错误正文", async () => {
  const result = await wikiCollector.collect(
    input(async () => {
      throw new Error("403 permission denied: secret detail");
    }),
  );
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "permission_denied");
  assert.equal(result.errorMessage, "当前账号无权限读取");
  assert.doesNotMatch(result.errorMessage ?? "", /secret/);
});

test("DWS 结构化参数错误归一为 schema_error，且只重试显式可重试错误", async () => {
  const classified = classifyDwsFailure(
    { error: { category: "validation", subtype: "unknown_flag", stage: "argument_validation", message: "secret raw detail" } },
    new Error("exit 1"),
  );
  assert.deepEqual(classified, {
    safeCode: "schema_error",
    stage: "argument_validation",
    retryable: false,
    retryAfterMs: 0,
  });

  let attempts = 0;
  const payload = await runCommand(input(async () => {
    attempts += 1;
    if (attempts <= 2) {
      throw Object.assign(new Error("temporary"), {
        safeCode: "rate_limited",
        failureStage: "upstream",
        retryable: true,
        retryAfterMs: 0,
      });
    }
    return { conversations: [] };
  }), ["chat", "+conversation-list", "--page-all", "--page-limit", "50"]);
  assert.deepEqual(payload, { conversations: [] });
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(() => runCommand(input(async () => {
    attempts += 1;
    throw Object.assign(new Error("invalid"), { safeCode: "schema_error", retryable: false });
  }), ["chat", "+conversation-list", "--page-all", "--page-limit", "50"]));
  assert.equal(attempts, 1);
});

test("聊天会话按 raw nextCursor、消息按 page-all 完整采集，并跨页去重", async () => {
  const commands: string[] = [];
  const conversations = Array.from({ length: 10 }, (_, index) => ({
    openConversationId: `group-${index}`,
    title: `会话${index}`,
    singleChat: false,
  }));
  const result = await chatCollector.collect(input(async (args) => {
    const command = args.join(" ");
    commands.push(command);
    if (command.includes("chat list-all-conversations")) {
      if (command.includes("--cursor 0")) {
        return {
          result: { conversations: conversations.slice(0, 5), hasMore: true, nextCursor: 91 },
        };
      }
      assert.match(command, /--cursor 91/);
      return {
        result: { conversations: conversations.slice(5), hasMore: false, nextCursor: 0 },
      };
    }
    const group = command.match(/--group (group-\d+)/)?.[1];
    if (!group) throw new Error(`unexpected command: ${command}`);
    if (group !== "group-0") {
      return {
        messages: [{ id: `${group}-message`, content: `完成${group}工作`, senderId: "user-1", sendTime: "2026-08-25T09:00:00+08:00" }],
        complete: true,
        hasMore: false,
        pagesFetched: 1,
      };
    }
    const messages = Array.from({ length: 55 }, (_, index) => ({
      id: `message-${index}`,
      content: `第${index}条工作消息`,
      senderId: "user-1",
      sendTime: `2026-08-25T${String(8 + Math.floor(index / 10)).padStart(2, "0")}:${String(index % 10).padStart(2, "0")}:00+08:00`,
    }));
    return {
      messages: [
        { id: "before", content: "前一天", senderId: "user-1", sendTime: "2026-08-24T17:29:59+08:00" },
        ...messages,
        messages[50],
        { id: "next", content: "次日", senderId: "user-1", sendTime: "2026-08-26T00:00:00+08:00" },
      ],
      complete: true,
      hasMore: false,
      pagesFetched: 2,
      count: 58,
    };
  }));

  assert.equal(result.status, "complete");
  assert.equal(result.evidences.length, 64, "10 个会话均读取，跨页重复和日期边界消息被去除");
  assert.equal(commands.filter((command) => command.includes("chat +chat-messages")).length, 10);
  assert.equal(result.completeness?.complete, true);
  assert.equal(result.completeness?.pagesFetched, 13);
  assert.equal(result.completeness?.itemCount, 64);
  assert.equal(result.completeness?.details?.length, 10);
  assert.deepEqual(result.completeness?.details?.[0], {
    kind: "chat_conversation",
    conversationId: "group-0",
    conversationType: "group",
    pagesFetched: 2,
    messagesFetched: 55,
    complete: true,
    hasMore: false,
    stopReason: undefined,
    failures: 0,
    failedPages: [],
  });
  assert.equal(result.evidences.every((evidence) => evidence.sourceCompleteness === "complete"), true);
  assert.equal(commands.filter((command) => command.includes("chat list-all-conversations")).length, 2);
});

test("聊天会话列表 hasMore=true 却缺少 nextCursor 时保留首屏并标记 partial", async () => {
  const commands: string[] = [];
  const result = await chatCollector.collect(input(async (args) => {
    const command = args.join(" ");
    commands.push(command);
    if (command.includes("chat list-all-conversations")) {
      return {
        result: {
          conversations: [{ openConversationId: "group-first-page", title: "首屏群", singleChat: false }],
          hasMore: true,
        },
      };
    }
    if (command.includes("chat +chat-messages")) {
      return {
        messages: [{ id: "message-first-page", content: "今天完成首屏工作", senderId: "user-1", sendTime: "2026-08-25T09:00:00+08:00" }],
        complete: true,
        hasMore: false,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  }));

  assert.equal(result.status, "partial");
  assert.equal(result.evidences.length, 1);
  assert.equal(result.completeness?.complete, false);
  assert.equal(result.completeness?.hasMore, true);
  assert.equal(result.completeness?.stopReason, "pagination_cursor_missing");
  assert.equal(commands.filter((command) => command.includes("chat list-all-conversations")).length, 1);
});

test("聊天任一会话分页未完成时保存 ledger 并标记 partial", async () => {
  const result = await chatCollector.collect(input(async (args) => {
    const command = args.join(" ");
    if (command.includes("chat list-all-conversations")) {
      return {
        result: {
          conversations: [{ openConversationId: "group-1", singleChat: false }],
          hasMore: false,
          nextCursor: 0,
        },
      };
    }
    return {
      messages: [{ id: "message-1", content: "已取得的工作消息", senderId: "user-1", sendTime: "2026-08-25T09:00:00+08:00" }],
      complete: false,
      hasMore: true,
      failures: [{ page: 2, code: "rate_limited" }],
      pagesFetched: 1,
      stopReason: "rate_limited",
    };
  }));

  assert.equal(result.status, "partial");
  assert.equal(result.completeness?.complete, false);
  assert.equal(result.completeness?.hasMore, true);
  assert.equal(result.completeness?.failures, 1);
  assert.equal(result.completeness?.stopReason, "rate_limited");
  assert.equal(result.completeness?.details?.[0]?.complete, false);
  assert.equal(result.completeness?.details?.[0]?.messagesFetched, 1);
  assert.deepEqual(result.completeness?.details?.[0]?.failedPages, [2]);
  assert.equal(result.evidences[0].sourceCompleteness, "partial");
});
