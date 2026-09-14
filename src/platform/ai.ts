/**
 * AI 三件套（提交前检查 / 自动归类 / 质量评价）。
 * LLM 优先（文案风格对齐规格 §8），失败时回落规格 §8.1/8.2/8.3 的确定性规则（规格明确允许作为兜底）。
 */
import { chatJson, llmAvailable } from "../llm/client";
import { logStructured } from "../infra/logger";
import type { CategoryRow, DraftAffiliation } from "./store";

/* ---------------- 确定性兜底规则（规格 §8.1） ---------------- */

const RESULT_RE = /完成|达到|结果|已|提升|通过|结论|确认|定位|输出|出具|稳定|降到|降低|复测|闭环|归档|对齐/;
const BLOCKER_RE = /卡点|风险|超标|渗漏|延误|未解决|没解决|瓶颈|超差|可能影响|影响[^。；]*(进度|排期|安排)/;
const SUPPORT_RE = /需要|协助|支持|申请|已报|已要求|建议/;

export interface CheckSuggestion {
  itemIndex: number; // 跨归属全局序号（1 起）
  text: string;
}

export function ruleBasedSuggestions(affiliations: DraftAffiliation[]): CheckSuggestion[] {
  const out: CheckSuggestion[] = [];
  let g = 0;
  for (const aff of affiliations) {
    for (const it of aff.items) {
      g += 1;
      const text = String(it.text ?? "").trim();
      if (!text) {
        out.push({ itemIndex: g, text: `事项 ${g}：正文为空，请补充工作内容或删除该事项。` });
        continue;
      }
      if (text.length < 15) {
        const head = text.slice(0, 8) + (text.length > 8 ? "…" : "");
        out.push({
          itemIndex: g,
          text: `事项 ${g}：只写了“${head}”，缺少调整对象、采取的行动以及结果或当前状态。`,
        });
      } else {
        if (!/\d/.test(text)) {
          out.push({
            itemIndex: g,
            text: `事项 ${g}：未看到量化结果或关键数据（如指标值、样本量、通过率），建议补充。`,
          });
        }
        if (!RESULT_RE.test(text)) {
          out.push({
            itemIndex: g,
            text: `事项 ${g}：看不出结果或当前状态，建议补充该项工作的结论或进展程度。`,
          });
        }
      }
      if (BLOCKER_RE.test(text) && !SUPPORT_RE.test(text)) {
        out.push({
          itemIndex: g,
          text: `事项 ${g}：提到卡点，但未说明原因及需要的支持（如协助人、资源或时间要求）。`,
        });
      }
      if (!it.hours) {
        out.push({ itemIndex: g, text: `事项 ${g}：尚未填写工时，工时需记录到每一项具体工作。` });
      }
    }
  }
  return out.slice(0, 4);
}

/* ---------------- 确定性兜底归类（规格 §8.2） ---------------- */

const CAT_RULES: Array<{ name: string; keywords: string[] }> = [
  { name: "实验验证", keywords: ["实验", "测试", "验证", "校准", "样"] },
  { name: "参数优化", keywords: ["参数", "调参", "优化", "仿真"] },
  { name: "交付风险", keywords: ["风险", "延误", "超标", "渗漏", "卡点", "影响", "超差"] },
  { name: "跨部门协同", keywords: ["协同", "对接", "评审", "讨论", "沟通", "跨部门"] },
  { name: "注册申报", keywords: ["注册", "检验", "申报", "型检", "灭菌"] },
  { name: "文献调研", keywords: ["文献", "专利", "调研", "交底书"] },
  { name: "供应商沟通", keywords: ["供应商", "采购", "交期", "到货"] },
  { name: "算法开发", keywords: ["算法", "帧率", "伪影", "模型"] },
  { name: "样机调试", keywords: ["样机", "工装", "调试", "装调"] },
  { name: "问题复盘", keywords: ["复盘", "总结"] },
];

export function ruleBasedCategorize(text: string, pool: CategoryRow[]): number[] {
  const byName = new Map(pool.map((c) => [c.name, c.id]));
  const hits: number[] = [];
  for (const rule of CAT_RULES) {
    const id = byName.get(rule.name);
    if (!id) continue;
    if (rule.keywords.some((k) => text.includes(k))) hits.push(id);
    if (hits.length >= 2) break;
  }
  return hits;
}

/* ---------------- 确定性兜底质量评价（规格 §8.3） ---------------- */

const CONCL_RE = /结论|首次|新方法|新想法|可复用|验证通过|推广|突破/;

export function ruleBasedQuality(affiliations: DraftAffiliation[]): "ex" | "vg" | "good" | "normal" {
  let total = 0;
  let hasNum = false;
  let hasConcl = false;
  let allClear = true;
  for (const aff of affiliations) {
    for (const it of aff.items) {
      const t = String(it.text ?? "").trim();
      total += t.length;
      if (/\d/.test(t)) hasNum = true;
      if (CONCL_RE.test(t)) hasConcl = true;
      if (t.length < 15) allClear = false;
    }
  }
  if (hasConcl && hasNum && total >= 120) return "ex";
  if (hasNum && total >= 80 && allClear) return "vg";
  if (total >= 40) return "good";
  return "normal";
}

/* ---------------- LLM 主路 ---------------- */

export interface AiCheckResult {
  suggestions: CheckSuggestion[];
  /** itemIndex(1 起) → 分类 id 列表（最多 2 个） */
  cats: Map<number, number[]>;
  quality: "ex" | "vg" | "good" | "normal";
  source: "llm" | "rules";
}

interface ItemForLlm {
  g: number;
  aff: string;
  text: string;
  hours: number;
  locked: boolean;
}

function flattenItems(affiliations: DraftAffiliation[], affNames: Map<string, string>): ItemForLlm[] {
  const items: ItemForLlm[] = [];
  let g = 0;
  for (const aff of affiliations) {
    for (const it of aff.items) {
      g += 1;
      const locked = (it.cats ?? []).some((c) => c && (c.confirmed || c.manual));
      items.push({
        g,
        aff: affNames.get(aff.affId) ?? (aff.affId === "dept" ? "部门日常" : aff.affId),
        text: String(it.text ?? "").trim(),
        hours: Number(it.hours) || 0,
        locked,
      });
    }
  }
  return items;
}

/**
 * 一次 LLM 调用同时产出：检查建议 + 自动归类 + 质量评价（对齐规格：检查与归类同阶段统一执行）。
 */
export async function runAiCheck(
  affiliations: DraftAffiliation[],
  pool: CategoryRow[],
  affNames: Map<string, string>,
): Promise<AiCheckResult> {
  const items = flattenItems(affiliations, affNames);
  const fallback = (): AiCheckResult => {
    const cats = new Map<number, number[]>();
    for (const it of items) {
      if (it.locked || !it.text) continue;
      cats.set(it.g, ruleBasedCategorize(it.text, pool));
    }
    return {
      suggestions: ruleBasedSuggestions(affiliations),
      cats,
      quality: ruleBasedQuality(affiliations),
      source: "rules",
    };
  };
  if (!llmAvailable()) return fallback();

  const poolStr = pool.map((c) => `${c.id}:${c.name}`).join("、");
  const itemsStr = items
    .map(
      (it) =>
        `事项${it.g}（归属：${it.aff}；工时：${it.hours || "未填"}${it.locked ? "；分类已由员工确认，勿再归类" : ""}）：${it.text || "（空）"}`,
    )
    .join("\n");
  const system = `你是公司工作日志平台的 AI 检查助手。你的职责（严格遵守）：
1. 检查建议：只指出信息缺口，绝不改写员工的文字。检查维度：工作对象是否明确、行动是否具体、是否有结果或当前状态、是否有量化数据、提到卡点/风险时是否说明原因和需要的支持、工时是否填写。建议要少而关键（全篇最多 4 条），每条格式：「事项 N：具体建议」。写得清楚的事项不要提建议。
2. 自动归类：从公司分类池中为每条未锁定的事项选择 0-2 个最贴切的分类（返回分类 id 数字）。每条事项必须独立判断，仅在该事项正文中有明确语义证据时选择；不得因为项目名称、同篇日志的其他事项或常见搭配扩散标签。没有足够证据可返回空数组。优先复用已有分类，不要生造。
3. 质量评价：对整篇日志给出 ex（Excellent，含新结论/新方法且有量化数据且信息量充足）/ vg（Very Good，有量化数据、各事项都写清楚）/ good（Good，基本清楚）/ normal（一般）。不因文字长给高等级。
只输出 JSON：{"suggestions":[{"itemIndex":1,"text":"事项 1：…"}],"cats":{"1":[3,5]},"quality":"vg"}`;
  try {
    const result = await chatJson(
      [
        { role: "system", content: system },
        { role: "user", content: `公司分类池（id:名称）：${poolStr}\n\n今日日志事项：\n${itemsStr}` },
      ],
      (obj) => {
        const o = obj as {
          suggestions?: Array<{ itemIndex?: number; text?: string }>;
          cats?: Record<string, number[]>;
          quality?: string;
        };
        if (!o || typeof o !== "object") throw new Error("非对象");
        const suggestions = (Array.isArray(o.suggestions) ? o.suggestions : [])
          .map((s) => ({ itemIndex: Number(s.itemIndex) || 0, text: String(s.text ?? "").trim() }))
          .filter((s) => s.text)
          .slice(0, 4);
        const cats = new Map<number, number[]>();
        const validIds = new Set(pool.map((c) => c.id));
        for (const [k, v] of Object.entries(o.cats ?? {})) {
          const g = Number(k);
          if (!Number.isFinite(g)) continue;
          const ids = (Array.isArray(v) ? v : []).map(Number).filter((x) => validIds.has(x)).slice(0, 2);
          cats.set(g, ids);
        }
        const q = ["ex", "vg", "good", "normal"].includes(String(o.quality)) ? (o.quality as never) : null;
        if (!q) throw new Error("quality 非法");
        return { suggestions, cats, quality: q as "ex" | "vg" | "good" | "normal" };
      },
      { tier: "fast", maxTokens: 1200 },
    );
    /** 锁定事项不接受 LLM 归类 */
    for (const it of items) {
      if (it.locked) result.cats.delete(it.g);
    }
    return { ...result, source: "llm" };
  } catch (err) {
    logStructured({ evt: "ai_check_llm_failed", error: String(err) });
    return fallback();
  }
}
