import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG } from "../src/infra/config";
import { DAILY_AGENT_TOOLS } from "../src/assistant-v2/prompt";
import {
  OpenAiCompatibleAssistantProvider,
  toolResultMessage,
  type AssistantModelProvider,
  type ProviderMessage,
  type ProviderToolCall,
} from "../src/assistant-v2/provider-adapter";
import { parseReplyArguments } from "../src/assistant-v2/schema";

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
  latencyMs: number;
}

const replyTool = DAILY_AGENT_TOOLS.find((tool) => tool.function.name === "reply")!;
const probeTool = {
  type: "function",
  function: {
    name: "read_probe",
    description: "读取服务端探针值。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
} as const;
const recordTool = {
  type: "function",
  function: {
    name: "record_note",
    description: "记录测试备注。",
    parameters: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
  },
} as const;

function assistantMessage(content: string, toolCalls: ProviderToolCall[]): ProviderMessage {
  return { role: "assistant", content: content || null, tool_calls: toolCalls };
}

async function check(name: string, work: () => Promise<string>): Promise<CheckResult> {
  const started = Date.now();
  try {
    return { name, pass: true, detail: await work(), latencyMs: Date.now() - started };
  } catch (error) {
    return { name, pass: false, detail: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started };
  }
}

async function runProvider(provider: AssistantModelProvider): Promise<CheckResult[]> {
  const requiredReply = await check("required + reply/focus", async () => {
    const response = await provider.call({
      messages: [
        { role: "system", content: "你在执行接口一致性测试，只按要求调用工具。" },
        { role: "user", content: "请调用 reply 询问‘要现在提交吗？’，focus.field=submit、questionKind=confirm_submit、itemId=null。" },
      ],
      tools: [replyTool],
      toolChoice: "required",
    });
    const call = response.toolCalls.find((candidate) => candidate.function.name === "reply");
    if (!call) throw new Error("没有调用 reply");
    const parsed = parseReplyArguments(call.function.arguments);
    if (parsed.focus?.field !== "submit") throw new Error(`focus.field=${parsed.focus?.field ?? "null"}`);
    return parsed.normalizedStringFocus ? "通过；Provider 返回字符串化 focus，Adapter 已严格归一化" : "通过；原生嵌套 focus";
  });

  const correlation = await check("多轮 tool result 关联", async () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "你在执行接口一致性测试。第一轮只调用 read_probe；得到工具结果后再调用 reply，message 必须原样包含 probeValue。" },
      { role: "user", content: "开始测试。" },
    ];
    const first = await provider.call({ messages, tools: [probeTool, replyTool], toolChoice: "required" });
    const probe = first.toolCalls.find((candidate) => candidate.function.name === "read_probe");
    if (!probe) throw new Error("第一轮没有调用 read_probe");
    messages.push(assistantMessage(first.content, first.toolCalls));
    for (const call of first.toolCalls) {
      messages.push(toolResultMessage(call.id, call.id === probe.id ? { ok: true, probeValue: "probe-7319" } : { ok: false, error: "第一轮不得结束" }));
    }
    const second = await provider.call({ messages, tools: [replyTool], toolChoice: "required" });
    const reply = second.toolCalls.find((candidate) => candidate.function.name === "reply");
    if (!reply) throw new Error("第二轮没有调用 reply");
    const parsed = parseReplyArguments(reply.function.arguments);
    if (!parsed.message.includes("probe-7319")) throw new Error(`reply 未关联工具结果：${parsed.message}`);
    return "通过；tool_call_id 与第二轮结果关联正确";
  });

  const parallel = await check("并行写工具 + reply", async () => {
    const response = await provider.call({
      messages: [
        { role: "system", content: "你在执行接口一致性测试。必须在同一个响应中同时调用 record_note 和 reply，不能分两轮。" },
        { role: "user", content: "记录 note=parallel-ok，并用 reply 说测试完成，focus=null。" },
      ],
      tools: [recordTool, replyTool],
      toolChoice: "required",
    });
    const names = response.toolCalls.map((candidate) => candidate.function.name);
    if (!names.includes("record_note") || !names.includes("reply")) throw new Error(`同一响应工具=${names.join(",")}`);
    const reply = response.toolCalls.find((candidate) => candidate.function.name === "reply")!;
    parseReplyArguments(reply.function.arguments);
    return "通过；同响应返回写工具与唯一 reply";
  });

  const repair = await check("非法参数错误后的 Schema 修复", async () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "你在执行接口一致性测试。先调用 reply；如果工具返回参数错误，下一轮必须按错误修正。" },
      { role: "user", content: "请询问是否继续，focus.field=result、questionKind=ask_missing、itemId=null。" },
    ];
    const first = await provider.call({ messages, tools: [replyTool], toolChoice: "required" });
    const firstReply = first.toolCalls.find((candidate) => candidate.function.name === "reply");
    if (!firstReply) throw new Error("第一轮没有 reply");
    messages.push(assistantMessage(first.content, first.toolCalls));
    for (const call of first.toolCalls) {
      messages.push(toolResultMessage(call.id, { ok: false, error: "conformance 注入错误：请重新调用 reply，并保持 focus 为嵌套对象" }));
    }
    const second = await provider.call({ messages, tools: [replyTool], toolChoice: "required" });
    const secondReply = second.toolCalls.find((candidate) => candidate.function.name === "reply");
    if (!secondReply) throw new Error("错误返回后没有重新调用 reply");
    const parsed = parseReplyArguments(secondReply.function.arguments);
    if (parsed.focus?.field !== "result") throw new Error("修复后的 focus 不正确");
    return "通过；同一模型在错误结果后重新发出合法 reply";
  });

  return [requiredReply, correlation, parallel, repair];
}

async function main(): Promise<void> {
  const models = [CONFIG.assistant.primaryModel, CONFIG.assistant.backupModel];
  const results: Array<{ model: string; checks: CheckResult[] }> = [];
  for (const model of models) {
    const provider = new OpenAiCompatibleAssistantProvider({
      baseUrl: CONFIG.llm.primary.baseUrl,
      apiKey: CONFIG.llm.primary.apiKey,
      model,
      timeoutMs: CONFIG.assistant.modelTimeoutMs,
    });
    const checks = await runProvider(provider);
    results.push({ model, checks });
    for (const result of checks) console.log(`${result.pass ? "PASS" : "FAIL"} ${model} · ${result.name} · ${result.latencyMs}ms · ${result.detail}`);
  }
  const outDir = resolve("output/assistant-v2-conformance");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const jsonPath = resolve(outDir, `conformance-${stamp}.json`);
  const markdownPath = resolve(outDir, `conformance-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2), "utf8");
  const lines = ["# Assistant V2 Provider conformance", "", "| 模型 | 检查 | 结果 | 延迟 | 说明 |", "|---|---|---:|---:|---|"];
  for (const entry of results) for (const result of entry.checks) lines.push(`| ${entry.model} | ${result.name} | ${result.pass ? "PASS" : "FAIL"} | ${result.latencyMs}ms | ${result.detail.replace(/\|/g, "\\|")} |`);
  writeFileSync(markdownPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`报告：${markdownPath}`);
  if (results.some((entry) => entry.checks.some((result) => !result.pass))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
