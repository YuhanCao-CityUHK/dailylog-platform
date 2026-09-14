import assert from "node:assert/strict";
import test from "node:test";
import type { CollectorInput, JsonObject } from "../src/assistant/schema";
import { inspectDwsConnection } from "../src/dws/client";
import { chatCollector } from "../src/dws/collectors/chat-collector";
import { todoCollector } from "../src/dws/collectors/todo-collector";
import { looksLikeWorkAssignment } from "../src/dws/collectors/shared";

function collectorInput(run: CollectorInput["run"]): CollectorInput {
  return {
    platformUserId: 7,
    ddUserid: "user-1",
    selfUserIds: ["user-1", "open-self"],
    displayName: "杨楚榛",
    profile: "corp:user-1",
    workDate: "2026-09-02",
    historyWorkDates: [],
    now: new Date("2026-09-02T04:00:00.000Z"),
    run,
  };
}

test("常见省略主语的工作指令进入高召回任务预筛，纯寒暄不进入", () => {
  for (const text of ["张三跟进一下", "下班前把报价回复掉", "今天需要整理评审数据", "本周推进电脑采购"]) {
    assert.equal(looksLikeWorkAssignment(text), true, text);
  }
  for (const text of ["收到，谢谢", "今天下午天气不错", "这个方案看起来挺好"]) {
    assert.equal(looksLikeWorkAssignment(text), false, text);
  }
});

test("真实会话字段与身份别名被归一，未知会话类型不猜成私聊", async () => {
  const commands: string[] = [];
  const result = await chatCollector.collect(collectorInput(async (args): Promise<JsonObject> => {
    const command = args.join(" ");
    commands.push(command);
    if (command.includes("chat list-all-conversations")) {
      return {
        result: {
          conversations: [{
            openConversationId: "cid-1",
            title: "项目大群",
            peerUserId: "peer-should-not-imply-private",
            members: Array.from({ length: 12 }, (_, index) => ({ userId: `member-${index}` })),
          }],
          hasMore: false,
          nextCursor: 0,
        },
      };
    }
    if (command.includes("chat +chat-messages")) {
      return {
        messages: [
          {
            id: "self-alias",
            content: "已整理活动照片",
            sender: { name: "杨楚榛", userId: "opaque-self", openDingTalkId: "open-self" },
            sendTime: "2026-09-02T09:00:00+08:00",
          },
          {
            id: "top-level-sender",
            content: "请处理活动照片并发布公司大群",
            sender: "李咏赋",
            senderUserId: "other-1",
            sendTime: "2026-09-02T09:01:00+08:00",
          },
          {
            id: "at-alias",
            content: "跟进供应商报价回复",
            senderUserId: "other-2",
            atUsers: [{ userId: "opaque-at", staffId: "user-1" }],
            sendTime: "2026-09-02T09:02:00+08:00",
          },
          {
            id: "assignee-alias",
            content: "准备评审资料",
            senderUserId: "other-3",
            assignees: [{ openId: "open-self" }],
            sendTime: "2026-09-02T09:03:00+08:00",
          },
          {
            id: "ordinary-other",
            content: "我完成了客户报价修订",
            sender: "张三",
            senderUserId: "other-4",
            sendTime: "2026-09-02T09:04:00+08:00",
          },
        ],
        complete: true,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  }));

  assert.equal(result.status, "complete");
  assert.equal(commands.some((command) => command.includes("--group cid-1")), true);
  assert.equal(commands.some((command) => command.includes("--user peer-should-not-imply-private")), false);
  const byId = new Map(result.evidences.map((item) => [item.externalId, item]));
  assert.deepEqual([
    byId.get("self-alias")?.sourceType,
    byId.get("self-alias")?.title,
    byId.get("self-alias")?.relationToSelf,
    byId.get("self-alias")?.workUse,
  ], ["chat_group", "项目大群", "self", "direct_work"]);
  assert.deepEqual(byId.get("self-alias")?.actorUserIds, ["opaque-self", "open-self"]);
  assert.deepEqual([
    byId.get("top-level-sender")?.actorNames,
    byId.get("top-level-sender")?.relationToSelf,
    byId.get("top-level-sender")?.workUse,
  ], [["李咏赋"], "others", "background_only"], "群内未明确指向本人的指令不能算作本人的任务");
  assert.deepEqual([
    byId.get("at-alias")?.relationToSelf,
    byId.get("at-alias")?.workUse,
    byId.get("assignee-alias")?.relationToSelf,
    byId.get("assignee-alias")?.workUse,
  ], ["addressed", "task_signal", "addressed", "task_signal"]);
  assert.equal(byId.get("ordinary-other")?.workUse, "background_only");
  assert.deepEqual(byId.get("top-level-sender")?.projectSignals, ["请处理活动照片并发布公司大群"]);
  assert.equal(byId.get("top-level-sender")?.projectSignals.includes("项目大群"), false);
});

test("私聊中的真人入站消息直接进入语义分类，bot 与未知发送者仍保守", async () => {
  const result = await chatCollector.collect(collectorInput(async (args): Promise<JsonObject> => {
    const command = args.join(" ");
    if (command.includes("chat list-all-conversations")) {
      // Raw DWS v1.0.59 list shape retains singleChat; the shortcut projection does not.
      return {
        result: {
          conversations: [{
            singleChat: true,
            openConversationId: "cid-private",
            title: "李咏赋",
          }],
          hasMore: false,
          nextCursor: 0,
        },
      };
    }
    if (command.includes("chat +chat-messages")) {
      assert.match(command, /--group cid-private/);
      return {
        messages: [
          {
            id: "private-task",
            content: "下班前把供应商报价回复掉",
            senderUserId: "peer-1",
            senderName: "李咏赋",
            sendTime: "2026-09-02T10:00:00+08:00",
          },
          {
            id: "private-followup",
            content: "杨工这个咋说了",
            senderUserId: "peer-1",
            senderName: "李咏赋",
            sendTime: "2026-09-02T10:01:00+08:00",
          },
          {
            id: "private-bot",
            content: "系统通知",
            senderUserId: "robot-1",
            senderType: "bot",
            sendTime: "2026-09-02T10:02:00+08:00",
          },
          {
            id: "private-unknown",
            content: "这个咋说了",
            sendTime: "2026-09-02T10:03:00+08:00",
          },
        ],
        complete: true,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  }));
  const task = result.evidences.find((item) => item.externalId === "private-task");
  assert.equal(task?.sourceType, "chat_private");
  assert.equal(task?.relationToSelf, "addressed");
  assert.equal(task?.workUse, "task_signal");
  const followup = result.evidences.find((item) => item.externalId === "private-followup");
  assert.equal(followup?.relationToSelf, "addressed");
  assert.equal(followup?.workUse, "task_signal");
  assert.equal(result.evidences.find((item) => item.externalId === "private-bot")?.workUse, "background_only");
  assert.equal(result.evidences.find((item) => item.externalId === "private-unknown")?.workUse, "background_only");
});

test("仅当日待办进入 task_signal，历史或未来待办继续作为背景", async () => {
  const result = await todoCollector.collect(collectorInput(async (args): Promise<JsonObject> => {
    const command = args.join(" ");
    if (command.includes("--status false")) {
      return {
        todoCards: [
          { id: "created-today", title: "整理活动照片", createdAt: "2026-09-02T08:30:00+08:00", dueTime: "2026-09-05T18:00:00+08:00" },
          { id: "due-today", title: "回复供应商报价", createdAt: "2026-09-01T08:30:00+08:00", dueTime: "2026-09-02T18:00:00+08:00" },
          // +get-my-tasks may expose its due date under these normalized aliases.
          { id: "plan-finish-today", title: "提交审批材料", createdAt: "2026-09-01T08:30:00+08:00", planFinishDate: "2026-09-02T17:00:00+08:00" },
          { id: "due-alias-today", title: "确认设备租赁", createdAt: "2026-09-01T08:30:00+08:00", due: "2026-09-02T16:00:00+08:00" },
          { id: "future", title: "下周培训", createdAt: "2026-09-01T08:30:00+08:00", dueTime: "2026-09-08T18:00:00+08:00" },
          { id: "old-plan-finish", title: "旧待办", createdAt: "2026-09-01T08:30:00+08:00", planFinishDate: "2026-09-01T17:00:00+08:00" },
        ],
        complete: true,
      };
    }
    if (command.includes("--status true")) {
      return {
        todos: [{ id: "done-today", title: "完成设备维修", finishTime: "2026-09-02T11:00:00+08:00" }],
        complete: true,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  }));

  const byId = new Map(result.evidences.map((item) => [item.externalId, item]));
  assert.equal(byId.get("created-today")?.workUse, "task_signal");
  assert.match(byId.get("created-today")?.occurredAt ?? "", /^2026-09-02/);
  assert.equal(byId.get("due-today")?.workUse, "background_only");
  assert.equal(byId.get("plan-finish-today")?.workUse, "task_signal");
  assert.equal(byId.get("due-alias-today")?.workUse, "task_signal");
  assert.equal(byId.get("done-today")?.workUse, "task_signal");
  assert.equal(byId.get("future")?.workUse, "background_only");
  assert.equal(byId.get("old-plan-finish")?.workUse, "background_only");
});

test("DWS 身份校验接受同一员工的稳定 ID 别名并向下保留", async () => {
  const status = await inspectDwsConnection({
    platformUserId: 7,
    corpId: "corp",
    ddUserid: "staff-self",
  }, async (args) => {
    const command = args.join(" ");
    if (command === "profile list --format json") {
      return JSON.stringify({ profiles: [{ profile: "corp:staff-self", corpId: "corp", status: "active" }] });
    }
    if (command.includes("auth status")) {
      return JSON.stringify({ authenticated: true, token_valid: true });
    }
    if (command.includes("contact user get-self")) {
      return JSON.stringify({
        result: [{ orgEmployeeModel: {
          corpId: "corp",
          userId: "opaque-user",
          staffId: "staff-self",
          openDingTalkId: "open-dingtalk-self",
          openId: "open-self",
          orgUserName: "杨楚榛",
        } }],
      });
    }
    throw new Error(`unexpected command: ${command}`);
  }, true);

  assert.equal(status.state, "connected");
  assert.deepEqual(status.identity?.userIds, ["opaque-user", "staff-self", "open-dingtalk-self", "open-self"]);
});
