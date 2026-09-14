/** 问答 API */
import { readJson, sendJson, type Ctx, type Router } from "../infra/http";
import {
  answerQuestion,
  appendMessage,
  createConvo,
  getConvoMessages,
  listConvos,
  maybeRetitle,
  scopeLabelOf,
} from "./qa";

function requireUser(ctx: Ctx): boolean {
  if (!ctx.user) {
    sendJson(ctx.res, 401, { ok: false, error: "未登录" });
    return false;
  }
  return true;
}

const EXAMPLE_QS = [
  "我负责的项目当前整体状态是什么？",
  "最近的卡点持续了多久？",
  "某个分类最近 7 个工作日涉及哪些项目和人员？",
  "最近形成了哪些新结论、新方法或新想法？",
  "某位同事最近一周主要在推进什么？",
  "各项目最近一周的工时分布如何？",
];

export function registerQaRoutes(router: Router): void {
  router.get("/api/qa/meta", (ctx) => {
    if (!requireUser(ctx)) return;
    sendJson(ctx.res, 200, {
      ok: true,
      scope: scopeLabelOf(ctx.user!),
      examples: EXAMPLE_QS,
      convos: listConvos(ctx.user!.id),
    });
  });

  router.post("/api/qa/convos", (ctx) => {
    if (!requireUser(ctx)) return;
    sendJson(ctx.res, 200, { ok: true, convo: createConvo(ctx.user!.id) });
  });

  router.get("/api/qa/convos/:id", (ctx) => {
    if (!requireUser(ctx)) return;
    const msgs = getConvoMessages(ctx.user!.id, Number(ctx.params.id) || 0);
    if (!msgs) {
      sendJson(ctx.res, 404, { ok: false, error: "对话不存在" });
      return;
    }
    sendJson(ctx.res, 200, { ok: true, messages: msgs });
  });

  router.post("/api/qa/ask", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ convoId?: number; question?: string }>(ctx.req);
    const question = String(body.question ?? "").trim();
    let convoId = Number(body.convoId) || 0;
    if (!question) {
      sendJson(ctx.res, 400, { ok: false, error: "请输入问题" });
      return;
    }
    if (!convoId) convoId = createConvo(ctx.user!.id).id;
    const existing = getConvoMessages(ctx.user!.id, convoId);
    if (!existing) {
      sendJson(ctx.res, 404, { ok: false, error: "对话不存在" });
      return;
    }
    const history = existing.map((m) => {
      const c = m.content as { text?: string; intro?: string; facts?: string[] };
      return {
        role: m.role as "user" | "assistant",
        text: m.role === "user" ? String(c.text ?? "") : [c.intro, ...(c.facts ?? [])].filter(Boolean).join("；"),
      };
    });
    appendMessage(convoId, "user", { text: question });
    maybeRetitle(convoId, question);
    const answer = await answerQuestion(ctx.user!, question, history);
    appendMessage(convoId, "assistant", answer);
    sendJson(ctx.res, 200, { ok: true, convoId, answer, convos: listConvos(ctx.user!.id) });
  });
}
