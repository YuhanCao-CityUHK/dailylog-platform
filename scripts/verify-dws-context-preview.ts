/** DWS 上下文与全员开放规则的确定性验证；只使用模拟 JSON。 */
import assert from "node:assert/strict";
import { canUseDwsAssistant } from "../src/auth/types";
import { collectDwsContextPreview, type DwsJsonRunner } from "../src/dws/context-preview";

const profile = "ding-test:user-1";
const now = new Date("2026-08-21T02:00:00.000Z");

function fixtureRunner(failTodo = false): DwsJsonRunner {
  return async (args) => {
    const command = args.join(" ");
    assert.match(command, /^--profile ding-test:user-1 /);
    assert.match(command, / --format json$/);
    if (command.includes("todo task list")) {
      if (failTodo) throw new Error("permission denied");
      return {
        todos: [
          { id: "todo-1", title: "完成日志助手上下文预览", priority: 40, dueTime: "2026-08-21T18:00:00+08:00" },
          { id: "todo-2", title: "准备试点说明", priority: 20 },
        ],
      };
    }
    if (command.includes("report outbox list")) {
      assert.match(command, /--start 2026-08-15T00:00:00\+08:00/);
      assert.match(command, /--end 2026-08-21T23:59:59\+08:00/);
      return { result: [{
          reportId: "report-1",
          report_name: "8月20日日报",
          createTime: "2026-08-20T18:10:00+08:00",
          url: "dingtalk://report/1",
          report_content: [
            { key: "今日完成", value: "完成 DWS 用户隔离和首次授权流程" },
            { key: "明日计划", value: "开始上下文预览" },
          ],
        }] };
    }
    if (command.includes("minutes list all")) {
      return {
        itemList: [{ taskUuid: "minute-1", title: "日报助手方案讨论", createTime: "2026-08-21T09:30:00+08:00" }],
      };
    }
    if (command.includes("minutes get summary")) {
      return { result: { summary: "确定先做待办、近期日志和 AI 听记的只读预览。" } };
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

const preview = await collectDwsContextPreview(profile, fixtureRunner(), now);
assert.equal(preview.date, "2026-08-21");
assert.equal(preview.status, "complete");
assert.equal(preview.sources.todos.items.length, 2);
assert.equal(preview.sources.reports.items[0].id, "report-1");
assert.match(preview.sources.reports.items[0].summary, /DWS 用户隔离/);
assert.equal(preview.sources.reports.items[0].link, "dingtalk://report/1");
assert.equal(preview.sources.minutes.items[0].id, "minute-1");

const partial = await collectDwsContextPreview(profile, fixtureRunner(true), now);
assert.equal(partial.status, "partial");
assert.equal(partial.sources.todos.status, "error");
assert.equal(partial.sources.todos.error, "当前账号无权限读取");

const pilots = ["example-user-5", "example-user-2"];
assert.equal(canUseDwsAssistant({ kind: "dingtalk", ddUserid: "example-user-5" }, pilots, true), true);
assert.equal(canUseDwsAssistant({ kind: "dingtalk", ddUserid: "example-user-2" }, pilots, true), true);
assert.equal(canUseDwsAssistant({ kind: "dingtalk", ddUserid: "other-user" }, pilots, true), true);
assert.equal(canUseDwsAssistant({ kind: "local" }, pilots, true), false);

console.log(JSON.stringify({ contextNormalized: true, partialFailurePreserved: true, allDingTalkEmployeesEnabled: true }));
