/**
 * 汇总聚合：主管首页 / 项目 / 分类 / 员工 / 部门日常。
 * 统计口径由 SQL 实算；「重要进展 / 卡点」由 LLM 跨日期关联生成（带引用），失败时回落确定性规则。
 * 结果缓存于 agg_cache，任何提交/修改/删除即整体失效（invalidateAggCache）。
 */
import { getDb, nowIso } from "../infra/db";
import { chatJson, llmAvailable } from "../llm/client";
import { logStructured } from "../infra/logger";
import { lastCompleteWorkday, recentWorkdays, todayYmd } from "../infra/workcal";
import { fetchSubmittedItems, listCategories, listProjects, type SubmittedItem } from "./store";

export interface InsightRef {
  itemId: number;
  emp: string;
  date: string;
  excerpt: string;
}

export interface InsightEntry {
  text: string;
  aff: string;
  affName: string;
  people: string[];
  origin: "fact" | "analysis";
  hours: number;
  /** 引用日志事项自带的来源标签，不是对汇总文字重新分类。 */
  cats: Array<{ id: number; name: string; confirmed?: boolean; manual?: boolean }>;
  concl?: boolean;
  status?: "new" | "ongoing";
  days?: number;
  refs: InsightRef[];
}

export interface Insights {
  progress: InsightEntry[];
  blockers: InsightEntry[];
  source: "llm" | "rules";
}

export function invalidateAggCache(): void {
  getDb().prepare("DELETE FROM agg_cache").run();
}

function cacheGet<T>(kind: string, key: string): T | null {
  const row = getDb()
    .prepare("SELECT payload FROM agg_cache WHERE kind = ? AND cache_key = ?")
    .get(kind, key) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

function cachePut(kind: string, key: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO agg_cache (kind, cache_key, payload, generated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, cache_key) DO UPDATE SET payload = excluded.payload, generated_at = excluded.generated_at`,
    )
    .run(kind, key, JSON.stringify(payload), nowIso());
}

const BLOCKER_RE = /卡点|风险|超标|渗漏|延误|未解决|没解决|瓶颈|超差|失败|阻塞|可能影响|影响[^。；]*(进度|排期|安排)/;
const CONCL_RE = /结论|首次|新方法|新想法|可复用|验证通过|推广|突破/;

function excerptOf(text: string, len = 80): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > len ? `${t.slice(0, len)}…` : t;
}

/** 确定性兜底：近 N 日事项直接映射为进展/卡点条目。 */
function ruleBasedInsights(items: SubmittedItem[], dates: string[]): Insights {
  const latestDate = dates[dates.length - 1] ?? "";
  const progress: InsightEntry[] = [];
  const blockers: InsightEntry[] = [];
  /** 卡点：按关键词，跨日按前 12 字近似聚类算持续天数 */
  const blockerDays = new Map<string, Set<string>>();
  for (const it of items) {
    if (BLOCKER_RE.test(it.text)) {
      const key = `${it.aff}:${it.text.slice(0, 12)}`;
      const set = blockerDays.get(key) ?? new Set<string>();
      set.add(it.date);
      blockerDays.set(key, set);
    }
  }
  const seenBlocker = new Set<string>();
  for (const it of [...items].reverse()) {
    if (!BLOCKER_RE.test(it.text)) continue;
    const key = `${it.aff}:${it.text.slice(0, 12)}`;
    if (seenBlocker.has(key)) continue;
    seenBlocker.add(key);
    const days = blockerDays.get(key)?.size ?? 1;
    blockers.push({
      text: excerptOf(it.text, 120),
      aff: it.aff,
      affName: it.affName,
      people: [it.empName],
      origin: "fact",
      hours: it.hours,
      cats: it.cats.map((c) => ({
        id: c.id,
        name: c.name,
        confirmed: c.confirmed,
        manual: c.manual,
      })),
      status: it.date === latestDate && days <= 1 ? "new" : "ongoing",
      days,
      refs: [{ itemId: it.itemId, emp: it.empName, date: it.date, excerpt: excerptOf(it.text) }],
    });
    if (blockers.length >= 6) break;
  }
  const latestItems = items.filter((i) => i.date === latestDate && !BLOCKER_RE.test(i.text));
  const sorted = [...latestItems].sort((a, b) => b.text.length - a.text.length).slice(0, 6);
  for (const it of sorted) {
    progress.push({
      text: excerptOf(it.text, 120),
      aff: it.aff,
      affName: it.affName,
      people: [it.empName],
      origin: "fact",
      hours: it.hours,
      cats: it.cats.map((c) => ({
        id: c.id,
        name: c.name,
        confirmed: c.confirmed,
        manual: c.manual,
      })),
      concl: CONCL_RE.test(it.text) || undefined,
      refs: [{ itemId: it.itemId, emp: it.empName, date: it.date, excerpt: excerptOf(it.text) }],
    });
  }
  return { progress, blockers, source: "rules" };
}

/** LLM 跨日期关联（带引用编号校验）。 */
async function llmInsights(items: SubmittedItem[], dates: string[], scopeDesc: string): Promise<Insights> {
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const lines = items
    .map(
      (i) =>
        `#${i.itemId} | ${i.date} | ${i.empName} | 归属:${i.affName} | 工时:${i.hours}h | 分类:${i.cats.map((c) => c.name).join(",") || "无"} | ${i.text.replace(/\n/g, " ")}`,
    )
    .join("\n");
  const system = `你是工作日志平台的汇总分析引擎。基于给定的已提交日志事项（每条有唯一编号 #id），产出「重要进展」和「卡点」两组条目。要求：
- 跨日期关联：同一件事多天出现要合并成一条，卡点要给出已持续的工作日天数（days，按出现过的不同日期数），并判断 status："new"（最新一天新出现）或 "ongoing"（多天持续）。
- 每条注明 origin："fact"（直接转述单条/多条日志的事实）或 "analysis"（跨多条日志的归纳判断）。
- 含新结论/新方法/可复用沉淀的条目标 concl:true。
- refs 必须给出支撑该条目的日志事项编号数组（用 # 后的数字），不得编造编号。
- text 用简洁中文一两句话写清楚（对象、结果、数据）。people 为相关员工姓名数组。aff 用条目主要归属的名称原文。
- 进展最多 6 条、卡点最多 6 条，按重要性排序。没有卡点就返回空数组，不要硬凑。
只输出 JSON：{"progress":[{"text":"…","aff":"…","people":["…"],"origin":"fact","concl":false,"refs":[123]}],"blockers":[{"text":"…","aff":"…","people":["…"],"origin":"analysis","status":"ongoing","days":3,"refs":[124]}]}`;
  const result = await chatJson(
    [
      { role: "system", content: system },
      { role: "user", content: `范围：${scopeDesc}；覆盖工作日：${dates.join("、")}\n\n日志事项：\n${lines}` },
    ],
    (obj) => {
      const o = obj as { progress?: unknown[]; blockers?: unknown[] };
      const parseEntry = (raw: unknown, isBlocker: boolean): InsightEntry | null => {
        const e = (raw ?? {}) as Record<string, unknown>;
        const refIds = (Array.isArray(e.refs) ? e.refs : [])
          .map((x) => Number(String(x).replace(/^#/, "")))
          .filter((x) => byId.has(x));
        if (refIds.length === 0) return null;
        const refItems = refIds.map((id) => byId.get(id)!);
        const affName = String(e.aff ?? refItems[0].affName) || refItems[0].affName;
        const affId = refItems.find((r) => r.affName === affName)?.aff ?? refItems[0].aff;
        const catSet = new Map<
          number,
          { name: string; confirmed: boolean; manual: boolean }
        >();
        for (const r of refItems) {
          for (const c of r.cats) {
            const previous = catSet.get(c.id);
            catSet.set(c.id, {
              name: c.name,
              confirmed: previous ? previous.confirmed && c.confirmed : c.confirmed,
              manual: previous ? previous.manual || c.manual : c.manual,
            });
          }
        }
        const hours = Math.round(refItems.reduce((s, r) => s + r.hours, 0) * 10) / 10;
        const people = (Array.isArray(e.people) ? e.people.map(String) : []).filter(Boolean);
        return {
          text: String(e.text ?? "").trim() || excerptOf(refItems[0].text, 120),
          aff: affId,
          affName,
          people: people.length > 0 ? people : [...new Set(refItems.map((r) => r.empName))],
          origin: e.origin === "analysis" ? "analysis" : "fact",
          hours,
          cats: [...catSet.entries()].map(([id, c]) => ({ id, ...c })),
          concl: e.concl === true || undefined,
          ...(isBlocker
            ? {
                status: e.status === "ongoing" ? ("ongoing" as const) : ("new" as const),
                days: Math.max(1, Number(e.days) || 1),
              }
            : {}),
          refs: refItems.map((r) => ({ itemId: r.itemId, emp: r.empName, date: r.date, excerpt: excerptOf(r.text) })),
        };
      };
      const progress = (Array.isArray(o.progress) ? o.progress : [])
        .map((x) => parseEntry(x, false))
        .filter((x): x is InsightEntry => Boolean(x))
        .slice(0, 6);
      const blockers = (Array.isArray(o.blockers) ? o.blockers : [])
        .map((x) => parseEntry(x, true))
        .filter((x): x is InsightEntry => Boolean(x))
        .slice(0, 6);
      return { progress, blockers, source: "llm" as const };
    },
    { tier: "strong", maxTokens: 2600, timeoutMs: 60000 },
  );
  return result;
}

export async function computeInsights(
  items: SubmittedItem[],
  dates: string[],
  scopeDesc: string,
  cacheKey: string,
): Promise<Insights> {
  if (items.length === 0) return { progress: [], blockers: [], source: "rules" };
  // v2 carries source-tag confirmation state so the UI can distinguish
  // employee-confirmed tags from system suggestions. Keep legacy cache rows
  // untouched and regenerate them lazily after this release.
  const cacheKind = "insights-v2";
  const cached = cacheGet<Insights>(cacheKind, cacheKey);
  if (cached) return cached;
  let result: Insights;
  if (llmAvailable()) {
    try {
      result = await llmInsights(items, dates, scopeDesc);
    } catch (err) {
      logStructured({ evt: "insights_llm_failed", scope: scopeDesc, error: String(err) });
      result = ruleBasedInsights(items, dates);
    }
  } else {
    result = ruleBasedInsights(items, dates);
  }
  cachePut(cacheKind, cacheKey, result);
  return result;
}

/* ---------------- 通用统计 ---------------- */

export interface SubmissionStatus {
  total: number;
  submitted: number;
  missingNames: string[];
  date: string;
}

export function submissionStatus(date: string, userIds: number[] | null): SubmissionStatus {
  const db = getDb();
  const users = (
    userIds === null
      ? (db
          .prepare("SELECT id, name FROM users WHERE active = 1 AND should_submit = 1")
          .all() as unknown as Array<{ id: number; name: string }>)
      : (db
          .prepare(
            `SELECT id, name FROM users WHERE active = 1 AND should_submit = 1 AND id IN (${userIds.map(() => "?").join(",") || "0"})`,
          )
          .all(...(userIds as never[])) as unknown as Array<{ id: number; name: string }>)
  );
  const submitted = new Set(
    (
      db
        .prepare("SELECT user_id FROM logs WHERE date = ? AND status = 'submitted'")
        .all(date) as unknown as Array<{ user_id: number }>
    ).map((r) => r.user_id),
  );
  const missing = users.filter((u) => !submitted.has(u.id));
  return {
    total: users.length,
    submitted: users.length - missing.length,
    missingNames: missing.map((m) => m.name),
    date,
  };
}

export interface RiskWatchRow {
  catId: number;
  name: string;
  week: number;
  projects: number;
  maxDays: number;
  trend: number[];
  up: boolean;
}

export interface HourDistRow {
  catId: number | null;
  name: string;
  pc: number;
  warm?: boolean;
  gray?: boolean;
}

export function riskWatch(items: SubmittedItem[], dates: string[]): RiskWatchRow[] {
  const riskCats = listCategories().filter((c) => c.risk === 1);
  const out: RiskWatchRow[] = [];
  const last5 = dates.slice(-5);
  for (const cat of riskCats) {
    const hit = items.filter((i) => i.cats.some((c) => c.id === cat.id));
    if (hit.length === 0) continue;
    const week = hit.length;
    const projects = new Set(hit.map((i) => i.aff)).size;
    const daySet = new Set(hit.map((i) => i.date));
    const trend = last5.map((d) => hit.filter((i) => i.date === d).length);
    const half = Math.floor(trend.length / 2);
    const first = trend.slice(0, half).reduce((a, b) => a + b, 0);
    const second = trend.slice(half).reduce((a, b) => a + b, 0);
    out.push({
      catId: cat.id,
      name: cat.name,
      week,
      projects,
      maxDays: daySet.size,
      trend,
      up: second > first,
    });
  }
  return out.sort((a, b) => b.week - a.week);
}

export function hourDist(items: SubmittedItem[]): HourDistRow[] {
  const cats = listCategories();
  const warmSet = new Set(cats.filter((c) => c.warm === 1).map((c) => c.id));
  const totals = new Map<number, number>();
  let other = 0;
  let total = 0;
  for (const it of items) {
    total += it.hours;
    if (it.cats.length === 0) {
      other += it.hours;
      continue;
    }
    const share = it.hours / it.cats.length;
    for (const c of it.cats) totals.set(c.id, (totals.get(c.id) ?? 0) + share);
  }
  if (total <= 0) return [];
  const nameOf = new Map(cats.map((c) => [c.id, c.name]));
  const rows: HourDistRow[] = [...totals.entries()]
    .map(([catId, h]) => ({
      catId,
      name: nameOf.get(catId) ?? String(catId),
      pc: Math.round((h / total) * 100),
      warm: warmSet.has(catId) || undefined,
    }))
    .filter((r) => r.pc > 0)
    .sort((a, b) => b.pc - a.pc)
    .slice(0, 6);
  const otherPc = Math.round((other / total) * 100);
  if (otherPc > 0) rows.push({ catId: null, name: "其他", pc: otherPc, gray: true });
  return rows;
}

/** 近 7 个工作日窗口（含参考日）。各视角默认到今天（含今日已提交数据）；主管首页显式传最近完整工作日。 */
export function windowDates(endYmd?: string): string[] {
  return recentWorkdays(7, endYmd ?? todayYmd());
}

export function homeDefaultDate(): string {
  return lastCompleteWorkday();
}

export function hoursByDate(items: SubmittedItem[], dates: string[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const d of dates) map.set(d, 0);
  for (const it of items) map.set(it.date, (map.get(it.date) ?? 0) + it.hours);
  return dates.map((d) => [d.slice(5), Math.round((map.get(d) ?? 0) * 10) / 10]);
}

export function itemsCacheStamp(items: SubmittedItem[]): string {
  let maxId = 0;
  for (const it of items) if (it.itemId > maxId) maxId = it.itemId;
  return `${items.length}-${maxId}-${todayYmd()}`;
}

export { fetchSubmittedItems, listProjects };
