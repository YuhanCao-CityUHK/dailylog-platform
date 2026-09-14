import { ASSISTANT_REPORTING_WINDOW_INSTRUCTION } from "../assistant/reporting-window";
import { DRAFT_OPERATION_NAMES } from "./types";

export const DAILY_AGENT_PROMPT_REVISION = "task4.1-v2-closed-world-writes";

export const DAILY_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_report_state",
      description: "重新读取当前权威草稿投影、缺口和 revision。通常无需调用；只在 revision 冲突后使用。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "find_work_evidence",
      description: "按关键词查找当前员工当天仍有效的本人证据或明确指向本人的线索。结果只作事实参考，不会自动写草稿。",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_projects",
      description: "搜索员工可见的正式项目。不会创建项目。",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_draft_patch",
      description: [
        "原子执行一组草稿修改，任一操作失败则整组不生效。一个用户消息里的多个明确意图放进同一次调用。",
        "add_item 只用于员工今天已经做过或正在做的全新工作；员工明确说‘明天/后续/下一步’的动作不是今天的新事项。若投影中已有相关事项，必须 set_tomorrow_plan，禁止 add_item。",
        "set_hours 只允许两种情况：员工明确把数值分配给某个具体事项；或 lastFocus.field=hours 且本轮只是回答该焦点事项的纯时长。‘总工时/一共/合计’是跨事项聚合值，不是任何单项的 hours，出现聚合值时 operations 中禁止 set_hours，只能询问各项如何分配。",
        "项目已有可选财务编码时必须设置 financeCodeId，且只能来自投影中该项目的可选值；项目尚未配置编码时保留为空并允许提交，不得虚构编码。改项目后按新项目的可选值处理。",
        "merge_items 会完整迁移被合并事项字段，禁止用 delete_item/update_summary 模拟。",
        "itemId 只能使用投影中的稳定 id，projectId 只能使用可见项目 id 或 null。",
      ].join(""),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          expectedRevision: { type: "integer" },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: DRAFT_OPERATION_NAMES },
                itemId: { type: "string" },
                itemIds: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string", enum: ["all"] }] },
                summary: { type: "string" },
                result: { type: "string" },
                hours: { type: "number", minimum: 0, maximum: 24 },
                projectId: { anyOf: [{ type: "integer" }, { type: "null" }] },
                financeCodeId: { type: "integer", minimum: 1 },
                status: { type: "string", enum: ["completed", "in_progress", "blocked", "no_progress"] },
                blocker: { type: "string" },
                nextAction: { type: "string" },
                supportNeeded: { type: "string" },
                supportPeople: { type: "array", items: { type: "string" } },
                tomorrowPlan: { type: "string" },
                summaries: { type: "array", items: { type: "string" } },
                reason: { type: "string" },
              },
              required: ["op"],
            },
          },
        },
        required: ["expectedRevision", "operations"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_draft_change",
      description: "撤销最近一次或指定 changeId 的可逆草稿变更。用户只表达撤销时，本轮唯一写操作必须是撤销。",
      parameters: { type: "object", properties: { changeId: { type: "string" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_submission",
      description: "草稿无缺口时固化当前 revision。仅当上一轮 reply.focus.field=submit 且当前消息为肯定答复时可调用；用户本轮首次直接要求提交时禁止调用，必须先 reply 并设置 submit focus。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_report",
      description: "正式提交日报，不可撤销。仅当上一轮 reply.focus.field=submit 且当前消息为肯定答复时，使用本轮 prepare_submission 返回的 preparedHash 和当前用户消息 id 调用；首次直接要求提交时禁止调用。",
      parameters: {
        type: "object",
        properties: { preparedHash: { type: "string" }, authorizationMessageId: { type: "integer" } },
        required: ["preparedHash", "authorizationMessageId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply",
      description: "结束本轮并对员工说话。message 只写提问、解释或澄清，不复述系统回执。一轮只问一个最有价值的问题。询问或等待确认时 focus 必须是非 null 嵌套 JSON 对象，绝不能把对象编码成字符串。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message: { type: "string", maxLength: 600 },
          focus: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  itemId: { anyOf: [{ type: "string" }, { type: "null" }] },
                  field: { type: "string", enum: ["today", "result", "hours", "project", "finance_code", "status", "blocker", "next_action", "support", "person", "tomorrow_plan", "outside_work", "submit", "clarify_target"] },
                  questionKind: { type: "string", enum: ["ask_missing", "clarify", "confirm_submit", "none"] },
                },
                required: ["itemId", "field", "questionKind"],
              },
              { type: "null" },
            ],
          },
          options: { type: "array", items: { type: "string" }, maxItems: 4 },
        },
        required: ["message", "focus"],
      },
    },
  },
] as const;

export const DAILY_AGENT_SYSTEM_PROMPT = `${ASSISTANT_REPORTING_WINDOW_INSTRUCTION}

你是「日报助手」，帮助员工用自然对话整理当天日报。员工说话可能省略、指代、否定、纠正或同时包含多个意图。结合当前权威投影和最近对话理解本轮消息，只通过工具修改草稿，并且每轮必须以 reply 结束。

规则：
1. 投影的 itemId 是稳定 id；“第二个/后面那个/客户现场那项”按 displayAlias 和内容解析。短答结合 lastFocus 理解。
2. 只记录员工明确说出的事实，不推断工时、状态、结果、项目或人员。他人的工作不能写成本人成果。
3. 明确修改直接调用一次 apply_draft_patch；语义不明且会影响结果时不写，只问一个最小澄清问题。
4. 未提到的事项保持原样。事项不是今天、昨天已完成或不是本人做的，才从今天草稿删除。员工明确说某项“没有进展”且今天没有做任何排查、协调或其他动作时，该项不属于今天的有效工作，必须 delete_item；只有做过排查/协调或形成新阻塞结论时才保留为 no_progress。
5. 只能使用可见项目 id；没有匹配项目时让员工选择，不能创建项目。null 表示部门日常。项目没有配置财务编码时允许 financeCodeId 为空，不要编造编码。
6. 修改事项自动确认；confirm_items 只确认员工在当前消息中明确肯定为今天的范围，不得扩大范围。用户只否定或删除某一项时，唯一写操作就是 delete_item 该项；其余事项只是保持原样，禁止顺手 confirm_items。用户只修改某一项时，也禁止确认未提到的其他事项。
7. 按缺口优先处理，每轮只问一个最有价值的问题；已完成事项不问明日计划，没有阻塞不问阻塞。
8. 模糊时段（如“一整天/半天/大半天”）不是精确工时。只给“总工时”但没有说明每项如何分配时，不得把总数写到任何单项，即使当前焦点只有一项或其他事项已有工时；必须只询问如何分配。
9. 单独的“嗯/哦/好像吧”不表示“没有其他工作”；只有明确“没有了/没了”才能 mark_no_outside_work。
10. 合并必须且只能对明确点到的事项调用一次 merge_items，不额外删除、改摘要或处理未点到事项。
11. 明确说“明天/后续/下一步”要做的动作属于现有相关事项的 tomorrowPlan，不是今天新增工作。即使用户说“补上”，只要内容明确发生在明天，也禁止 add_item。
12. 提交必须严格两步：若上一轮 lastFocus.field 不是 submit，即使当前消息是“可以提交了/提交吧/确认提交”，本轮也禁止 prepare_submission 和 submit_report，只能展示最终草稿并 reply(focus.field=submit, questionKind=confirm_submit) 询问一次；只有上一轮 lastFocus.field=submit 且当前消息为肯定答复时，才 prepare_submission → submit_report。“好的/就这样吧”在没有 submit 焦点时不是授权。
13. reply.message 不复述已执行修改；系统会展示真实回执。任何问题都必须设置非 null focus；询问提交使用 field=submit、questionKind=confirm_submit。
14. 工具失败时按精确错误修正一次；没有成功回执不能声称已修改。禁止把 focus 对象 JSON.stringify 成字符串。
15. 用户只确认一部分事项属于今天时，只 confirm_items 该明确部分；没有明确否定的其余事项保持不变并逐一追问，禁止因为它们未被一并确认就 delete_item。确认子集不等于否定补集。

工时示例：当前两项分别 3 小时和 2 小时，员工只说“总工时改成 6 小时” → 不写任何 set_hours，reply 询问 6 小时如何分配到两项；员工说“第一项改 4 小时” → set_hours(第一项, 4)。

执行写工具前检查：最终 operations 必须是本轮明确意图所需的最小集合；只撤销时只调用 undo；不确定不等于删除；没有明确删除意图不能 delete_item；未授权绝不提交。`;
