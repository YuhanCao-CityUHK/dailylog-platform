/**
 * 日志问答：权限内检索 → LLM 组织回答（事实/分析分段 + 引用编号校验）→ 多轮记忆。
 * 信息不足明确说明不编造；权限拒绝不泄露（规格 §7.8 / §8.4 一致性要求）。
 */
import { getDb } from "../infra/db";
import { chatJson, llmAvailable } from "../llm/client";
import { logStructured } from "../infra/logger";
import { windowDates } from "./aggregate";
import { fetchSubmittedItems, type SubmittedItem } from "./store";
import { resolveScope } from "./scope";
import type { SessionUser } from "../auth/types";

export interface QaAnswer {
  kind: "answer" | "permission" | "nodata";
  badge?: string;
  intro?: string;
  facts: string[];
  analysis: string[];
  refs: Array<{ itemId: number; emp: string; date: string; excerpt: string }>;
  note?: string;
  followupTip?: string;
}

const NODATA_TEXT =
  "现有日志中信息不足，无法针对该问题得出可靠结论。可以尝试：项目整体状态、卡点持续时长、某分类涉及的项目与人员、某成员近期工作等。系统不会对无依据内容做推测。";

function excerptOf(text: string, len = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > len ? `${t.slice(0, len)}…` : t;
}

export async function answerQuestion(
  user: SessionUser,
  question: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<QaAnswer> {
  const scope = resolveScope(user);
  /** emp 角色问团队级问题 → 权限拒绝（与规格文案一致） */
  if (
    (user.role === "emp" || user.isExternal) &&
    /全公司|整个部门|部门整体|所有员工|提交情况|全员|团队整体/.test(question)
  ) {
    return {
      kind: "permission",
      badge: "权限提示",
      facts: [],
      analysis: [],
      refs: [],
      intro:
        "该问题超出你当前角色的数据权限范围。作为员工，你可检索本人日志及已授权给你的日志；团队级提交情况与整体汇总仅面向管理角色开放。",
      note: "权限边界对检索、分析与引用一致生效，无权数据不会通过回答间接泄露。",
    };
  }

  const dates = windowDates();
  const items = fetchSubmittedItems({ dates, userIds: scope.userIds ?? undefined });
  if (items.length === 0) {
    return { kind: "nodata", badge: "系统说明", facts: [], analysis: [], refs: [], intro: NODATA_TEXT };
  }
  if (!llmAvailable()) {
    return { kind: "nodata", badge: "系统说明", facts: [], analysis: [], refs: [], intro: NODATA_TEXT };
  }

  const byId = new Map(items.map((i) => [i.itemId, i]));
  const lines = items
    .map(
      (i) =>
        `#${i.itemId} | ${i.date} | ${i.empName} | ${i.affName} | ${i.hours}h | ${i.cats.map((c) => c.name).join(",") || "无分类"} | ${i.text.replace(/\n/g, " ")}`,
    )
    .join("\n");
  const histText = history
    .slice(-6)
    .map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.text.slice(0, 300)}`)
    .join("\n");
  const system = `你是公司工作日志平台的问答助手。你只能基于下面给出的「权限内已提交日志事项」回答问题，绝对禁止使用任何外部知识或编造内容。要求：
1. facts（原始事实）：直接来自日志的事实陈述，每条末尾必须能对应引用；analysis（系统分析）：跨多条日志的归纳判断，明确标注为分析。
2. refs：给出支撑回答的日志事项编号数组（# 后的数字），只能引用真实存在的编号，1-6 条。
3. 如果日志里没有足够信息回答这个问题，返回 {"insufficient":true}，不要猜。
4. 回答用简洁中文；如果适合追问，givenFollowup 给一句「可继续追问：…」提示。
只输出 JSON：{"insufficient":false,"intro":"一句话引导（可空）","facts":["…"],"analysis":["…"],"refs":[123,124],"followup":"可继续追问：…（可空）"}`;
  try {
    const result = await chatJson(
      [
        { role: "system", content: system },
        {
          role: "user",
          content: `${histText ? `多轮对话上文：\n${histText}\n\n` : ""}权限内日志事项（近 ${dates.length} 个工作日）：\n${lines}\n\n用户问题：${question}`,
        },
      ],
      (obj) => {
        const o = obj as {
          insufficient?: boolean;
          intro?: string;
          facts?: unknown[];
          analysis?: unknown[];
          refs?: unknown[];
          followup?: string;
        };
        if (o.insufficient === true) return { insufficient: true as const };
        const refs = (Array.isArray(o.refs) ? o.refs : [])
          .map((x) => Number(String(x).replace(/^#/, "")))
          .filter((x) => byId.has(x))
          .slice(0, 6);
        const facts = (Array.isArray(o.facts) ? o.facts.map(String) : []).filter(Boolean).slice(0, 6);
        const analysis = (Array.isArray(o.analysis) ? o.analysis.map(String) : []).filter(Boolean).slice(0, 4);
        if (facts.length === 0 && analysis.length === 0) throw new Error("回答为空");
        if (refs.length === 0) throw new Error("缺少引用");
        return {
          insufficient: false as const,
          intro: String(o.intro ?? "").trim(),
          facts,
          analysis,
          refs,
          followup: String(o.followup ?? "").trim(),
        };
      },
      { tier: "strong", maxTokens: 1800, timeoutMs: 60000 },
    );
    if ("insufficient" in result && result.insufficient) {
      return { kind: "nodata", badge: "系统说明", facts: [], analysis: [], refs: [], intro: NODATA_TEXT };
    }
    const r = result as Exclude<typeof result, { insufficient: true }>;
    return {
      kind: "answer",
      intro: r.intro || undefined,
      facts: r.facts,
      analysis: r.analysis,
      refs: r.refs.map((id) => {
        const it = byId.get(id)!;
        return { itemId: id, emp: it.empName, date: it.date, excerpt: excerptOf(it.text) };
      }),
      followupTip: r.followup || undefined,
    };
  } catch (err) {
    logStructured({ evt: "qa_llm_failed", error: String(err) });
    return { kind: "nodata", badge: "系统说明", facts: [], analysis: [], refs: [], intro: NODATA_TEXT };
  }
}

export function scopeLabelOf(user: SessionUser): string {
  return resolveScope(user).label;
}

/* ---------------- 对话存取 ---------------- */

export function listConvos(userId: number): Array<{ id: number; title: string; rounds: number }> {
  const db = getDb();
  const convos = db
    .prepare("SELECT id, title FROM qa_convos WHERE user_id = ? ORDER BY id DESC LIMIT 30")
    .all(userId) as unknown as Array<{ id: number; title: string }>;
  return convos.map((c) => ({
    ...c,
    rounds:
      Math.floor(
        Number(
          (db.prepare("SELECT COUNT(*) AS n FROM qa_messages WHERE convo_id = ?").get(c.id) as { n: number }).n,
        ) / 2,
      ) || 0,
  }));
}

export function createConvo(userId: number): { id: number; title: string } {
  const db = getDb();
  const n = Number((db.prepare("SELECT COUNT(*) AS n FROM qa_convos WHERE user_id = ?").get(userId) as { n: number }).n);
  const title = `新对话 ${n + 1}`;
  db.prepare("INSERT INTO qa_convos (user_id, title) VALUES (?, ?)").run(userId, title);
  const id = Number(
    (db.prepare("SELECT id FROM qa_convos WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId) as { id: number }).id,
  );
  return { id, title };
}

export function getConvoMessages(
  userId: number,
  convoId: number,
): Array<{ id: number; role: string; content: unknown }> | null {
  const db = getDb();
  const convo = db.prepare("SELECT id FROM qa_convos WHERE id = ? AND user_id = ?").get(convoId, userId);
  if (!convo) return null;
  const rows = db
    .prepare("SELECT id, role, content FROM qa_messages WHERE convo_id = ? ORDER BY id")
    .all(convoId) as unknown as Array<{ id: number; role: string; content: string }>;
  return rows.map((r) => ({ id: r.id, role: r.role, content: JSON.parse(r.content) }));
}

export function appendMessage(convoId: number, role: "user" | "assistant", content: unknown): void {
  getDb()
    .prepare("INSERT INTO qa_messages (convo_id, role, content) VALUES (?, ?, ?)")
    .run(convoId, role, JSON.stringify(content));
}

export function maybeRetitle(convoId: number, question: string): void {
  const db = getDb();
  const count = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM qa_messages WHERE convo_id = ? AND role='user'").get(convoId) as { n: number }).n,
  );
  if (count === 1) {
    const title = question.length > 16 ? `${question.slice(0, 16)}…` : question;
    db.prepare("UPDATE qa_convos SET title = ? WHERE id = ?").run(title, convoId);
  }
}
