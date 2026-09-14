/** 填写链路：草稿、AI 检查、提交、我的日志、补填/修改、删除、附件、项目/分类池。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { getDb, audit, nowIso } from "../infra/db";
import { CONFIG } from "../infra/config";
import { readBody, readJson, sendJson, type Ctx, type Router } from "../infra/http";
import { dateLabel, isWorkday, prevWorkday, todayYmd, wdLabel } from "../infra/workcal";
import {
  bumpAdopt,
  bumpCategoryUse,
  createCategory,
  deleteDraft,
  getAdopt,
  getDefaultProjectId,
  getLog,
  listCategories,
  listProjects,
  loadDraft,
  saveDraft,
  strSimilar,
  type DraftAffiliation,
  type DraftPayload,
} from "./store";
import { runAiCheck } from "./ai";
import { canUseDwsAssistant, canUsePersonalLogs, type SessionUser } from "../auth/types";
import { invalidateAggCache } from "./aggregate";
import { resolveScope } from "./scope";
import { canReportToProject, canViewProjectReports } from "../projects/permissions";
import { readFormalReport } from "../reports/service";
import { exportOriginalReport } from "../reports/original-export";
import { recordReportVersion } from "../reports/versions";
import type { DatabaseSync } from "node:sqlite";
import { getFinanceProjectCode, listFinanceProjectCodes } from "./finance-project-codes";

export function isEditableReportDate(date: string, today = todayYmd(), previous = prevWorkday(today)): boolean {
  return date === today || date === previous;
}

export function canEditReportDate(
  user: Pick<SessionUser, "kind" | "ddUserid">,
  date: string,
  today = todayYmd(),
  previous = prevWorkday(today),
): boolean {
  return !canUseDwsAssistant(user) || isEditableReportDate(date, today, previous);
}

function requireUser(ctx: Ctx): boolean {
  if (!ctx.user) {
    sendJson(ctx.res, 401, { ok: false, error: "未登录" });
    return false;
  }
  return true;
}

function requireFillAllowed(ctx: Ctx): boolean {
  if (!requireUser(ctx)) return false;
  if (!canUsePersonalLogs(ctx.user!)) {
    sendJson(ctx.res, 403, { ok: false, error: "一期主管不填写日志（PRD 5.2），该入口对管理角色关闭" });
    return false;
  }
  return true;
}

function blankAffiliations(userId: number): DraftAffiliation[] {
  const defaultProjectId = getDefaultProjectId(userId);
  return [
    {
      affId: defaultProjectId ? String(defaultProjectId) : "dept",
      items: [{ text: "", hours: 0, cats: [], atts: [] }],
    },
  ];
}

function normalizeAffiliations(raw: unknown): DraftAffiliation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const items = Array.isArray(o.items) ? o.items : [];
      return {
        affId: String(o.affId ?? "").trim(),
        financeCodeId: Number(o.financeCodeId) > 0 ? Number(o.financeCodeId) : undefined,
        items: items.map((it) => {
          const i = (it ?? {}) as Record<string, unknown>;
          const cats = Array.isArray(i.cats) ? i.cats : [];
          const atts = Array.isArray(i.atts) ? i.atts : [];
          let hours = Number(i.hours) || 0;
          if (hours < 0) hours = 0;
          if (hours > 24) hours = 24;
          return {
            text: String(i.text ?? ""),
            hours: Math.round(hours * 2) / 2,
            cats: cats
              .map((c) => {
                const cc = (c ?? {}) as Record<string, unknown>;
                return {
                  id: Number(cc.id) || 0,
                  confirmed: Boolean(cc.confirmed),
                  manual: Boolean(cc.manual),
                };
              })
              .filter((c) => c.id > 0),
            atts: atts
              .map((x) => {
                const aa = (x ?? {}) as Record<string, unknown>;
                return { id: Number(aa.id) || undefined, name: String(aa.name ?? "").trim() };
              })
              .filter((x) => x.name),
          };
        }),
      };
    })
    .filter((a) => a.affId);
}

/** 试点人员仅可改最近两天；其余人员沿用“已提交历史可修改”的原规则。 */
function resolveEditableDate(user: SessionUser, requested: string | undefined): { date: string; mode: "today" | "retro" | "edit" } | { error: string } {
  const today = todayYmd();
  const date = (requested ?? today).trim() || today;
  if (date === today) return { date, mode: getLog(user.id, date) ? "edit" : "today" };
  if (!canUseDwsAssistant(user) && getLog(user.id, date)) return { date, mode: "edit" };
  if (date === prevWorkday(today)) return { date, mode: getLog(user.id, date) ? "edit" : "retro" };
  if (!canUseDwsAssistant(user)) {
    return { error: `仅可补填前一个工作日（${prevWorkday(today)}）；更早日期不可补填，但已提交日志仍可修改` };
  }
  return { error: `仅可修改当天或前一个工作日（${prevWorkday(today)}）；更早日报只读` };
}

export function assistantDraftAffiliations(userId: number, date: string, db: DatabaseSync = getDb()): DraftAffiliation[] | null {
  const session = db
    .prepare("SELECT id FROM assistant_sessions WHERE user_id = ? AND work_date = ?")
    .get(userId, date) as { id: number } | undefined;
  if (!session) return null;
  const items = db
    .prepare(
      `SELECT scope_type, project_id, work_summary, result_text, hours
         FROM assistant_session_items
        WHERE session_id = ? AND deleted = 0 ORDER BY ord, id`,
    )
    .all(session.id) as unknown as Array<{
    scope_type: string;
    project_id: number | null;
    work_summary: string;
    result_text: string;
    hours: number | null;
  }>;
  if (!items.length) return null;
  const byAff = new Map<string, DraftAffiliation>();
  for (const item of items) {
    const affId = item.scope_type === "project" && item.project_id ? String(item.project_id) : "dept";
    const affiliation = byAff.get(affId) ?? { affId, items: [] };
    affiliation.items.push({
      text: String(item.result_text || item.work_summary).trim(),
      hours: item.hours ?? 0,
      cats: [],
      atts: [],
    });
    byAff.set(affId, affiliation);
  }
  return [...byAff.values()];
}

function affNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  map.set("dept", "部门日常");
  for (const p of listProjects(true)) map.set(String(p.id), p.name);
  return map;
}

function financeCodeMap(projects: Array<{ id: number }>, db: DatabaseSync): Record<string, Array<{ id: number; code: string; name: string }>> {
  return Object.fromEntries(
    projects.map((project) => [
      String(project.id),
      listFinanceProjectCodes(project.id, db).map((code) => ({ id: code.id, code: code.code, name: code.name })),
    ]),
  );
}

export function validateFinanceCodeSelections(
  affiliations: DraftAffiliation[],
  availableProjects: Map<number, { id: number; name: string }>,
  db: DatabaseSync,
): string | null {
  for (const affiliation of affiliations) {
    if (affiliation.affId === "dept") continue;
    const projectId = Number(affiliation.affId);
    const project = availableProjects.get(projectId);
    if (!project) continue;
    const options = listFinanceProjectCodes(projectId, db);
    if (!options.length) continue;
    const codeId = Number(affiliation.financeCodeId);
    if (!Number.isSafeInteger(codeId) || !getFinanceProjectCode(projectId, codeId, db)) {
      return `请选择项目“${project.name}”对应的具体财务项目编码`;
    }
  }
  return null;
}

export function registerFillRoutes(router: Router): void {
  /** 元数据：项目列表 + 分类池 + 今日状态 */
  router.get("/api/fill/meta", (ctx) => {
    if (!requireUser(ctx)) return;
    const today = todayYmd();
    const submittedToday = Boolean(getLog(ctx.user!.id, today));
    const db = getDb();
    const projects = listProjects()
      .filter((project) => canReportToProject(ctx.user!, project.id, db))
      .map((p) => ({ id: p.id, name: p.name, owner: p.owner_name ?? "" }));
    sendJson(ctx.res, 200, {
      ok: true,
      today,
      todayLabel: dateLabel(today),
      isWorkdayToday: isWorkday(today),
      retroDate: prevWorkday(today),
      submittedToday,
      projects,
      financeCodes: financeCodeMap(projects, db),
      categories: listCategories().map((c) => ({ id: c.id, name: c.name, count: c.use_count })),
      adopt: getAdopt(ctx.user!.id, today),
    });
  });

  /** 草稿读取（仅今日；修改/补填不读草稿——与规格一致） */
  router.get("/api/fill/draft", (ctx) => {
    if (!requireFillAllowed(ctx)) return;
    const today = todayYmd();
    const draft = loadDraft(ctx.user!.id, today);
    sendJson(ctx.res, 200, {
      ok: true,
      date: today,
      draft: draft ?? { affiliations: blankAffiliations(ctx.user!.id) },
    });
  });

  router.post("/api/fill/draft", async (ctx) => {
    if (!requireFillAllowed(ctx)) return;
    const body = await readJson<{ affiliations?: unknown }>(ctx.req);
    const affiliations = normalizeAffiliations(body.affiliations);
    saveDraft(ctx.user!.id, todayYmd(), { affiliations });
    sendJson(ctx.res, 200, { ok: true, savedAt: nowIso() });
  });

  /** 载入修改/补填内容 */
  router.get("/api/fill/load", (ctx) => {
    if (!requireFillAllowed(ctx)) return;
    const requested = ctx.url.searchParams.get("date") ?? undefined;
    const resolved = resolveEditableDate(ctx.user!, requested);
    if ("error" in resolved) {
      sendJson(ctx.res, 400, { ok: false, error: resolved.error });
      return;
    }
    const log = getLog(ctx.user!.id, resolved.date);
    if (!log) {
      const savedAssistantDraft = canUseDwsAssistant(ctx.user!) && resolved.mode === "retro"
        ? assistantDraftAffiliations(ctx.user!.id, resolved.date)
        : null;
      sendJson(ctx.res, 200, {
        ok: true,
        date: resolved.date,
        mode: resolved.mode,
        affiliations: savedAssistantDraft ?? blankAffiliations(ctx.user!.id),
        restoredAssistantDraft: Boolean(savedAssistantDraft),
      });
      return;
    }
    const db = getDb();
    const items = db
      .prepare("SELECT id, aff, text, hours, finance_project_code_id AS financeCodeId FROM log_items WHERE log_id = ? ORDER BY ord")
      .all(log.id) as unknown as Array<{ id: number; aff: string; text: string; hours: number; financeCodeId: number | null }>;
    const byAff = new Map<string, DraftAffiliation>();
    for (const it of items) {
      const cats = db
        .prepare("SELECT cat_id AS id, confirmed, manual FROM item_cats WHERE item_id = ?")
        .all(it.id) as unknown as Array<{ id: number; confirmed: number; manual: number }>;
      const atts = db
        .prepare("SELECT id, filename AS name FROM attachments WHERE item_id = ?")
        .all(it.id) as unknown as Array<{ id: number; name: string }>;
      const codeKey = it.financeCodeId ? String(it.financeCodeId) : "none";
      const key = `${it.aff}:${codeKey}`;
      const aff = byAff.get(key) ?? {
        affId: it.aff,
        financeCodeId: it.financeCodeId ? Number(it.financeCodeId) : undefined,
        items: [],
      };
      aff.items.push({
        text: it.text,
        hours: it.hours,
        cats: cats.map((c) => ({ id: c.id, confirmed: c.confirmed === 1, manual: c.manual === 1 })),
        atts,
      });
      byAff.set(key, aff);
    }
    sendJson(ctx.res, 200, { ok: true, date: resolved.date, mode: resolved.mode, affiliations: [...byAff.values()] });
  });

  /** AI 检查（不提交）：返回建议 + 落好的分类 + 质量预估 */
  router.post("/api/fill/check", async (ctx) => {
    if (!requireFillAllowed(ctx)) return;
    const body = await readJson<{ affiliations?: unknown }>(ctx.req);
    const affiliations = normalizeAffiliations(body.affiliations);
    const db = getDb();
    const availableProjects = new Map(listProjects(true).map((project) => [project.id, project]));
    for (const affiliation of affiliations) {
      if (affiliation.affId === "dept") continue;
      const projectId = Number(affiliation.affId);
      if (!Number.isSafeInteger(projectId) || !availableProjects.has(projectId)) {
        sendJson(ctx.res, 400, { ok: false, error: "日报事项必须归入有效正式项目或部门日常" });
        return;
      }
      if (!canReportToProject(ctx.user!, projectId, db)) {
        sendJson(ctx.res, 403, { ok: false, error: "无权将日报事项归入该项目" });
        return;
      }
    }
    const financeError = validateFinanceCodeSelections(affiliations, availableProjects, db);
    if (financeError) {
      sendJson(ctx.res, 400, { ok: false, error: financeError });
      return;
    }
    const result = await runAiCheck(affiliations, listCategories(), affNameMap());
    applyCats(affiliations, result.cats);
    sendJson(ctx.res, 200, {
      ok: true,
      suggestions: result.suggestions,
      affiliations,
      quality: result.quality,
      source: result.source,
    });
  });

  /** 提交（检查后端到端执行：归类 → 质量 → 入库 → 采纳率 → 失效聚合缓存） */
  router.post("/api/fill/submit", async (ctx) => {
    if (!requireFillAllowed(ctx)) return;
    const body = await readJson<{ date?: string; affiliations?: unknown }>(ctx.req);
    const resolved = resolveEditableDate(ctx.user!, body.date ?? undefined);
    if ("error" in resolved) {
      sendJson(ctx.res, 400, { ok: false, error: resolved.error });
      return;
    }
    const affiliations = normalizeAffiliations(body.affiliations).filter((a) => a.items.length > 0);
    if (affiliations.length === 0) {
      sendJson(ctx.res, 400, { ok: false, error: "至少保留一个工作归属和一条事项" });
      return;
    }
    const hasContent = affiliations.some((a) => a.items.some((i) => i.text.trim()));
    if (!hasContent) {
      sendJson(ctx.res, 400, { ok: false, error: "请先填写工作内容再提交" });
      return;
    }
    const db = getDb();
    const availableProjects = new Map(listProjects(true).map((project) => [project.id, project]));
    for (const affiliation of affiliations) {
      if (affiliation.affId === "dept") continue;
      const projectId = Number(affiliation.affId);
      if (!Number.isSafeInteger(projectId) || !availableProjects.has(projectId)) {
        sendJson(ctx.res, 400, { ok: false, error: "日报事项必须归入有效正式项目或部门日常" });
        return;
      }
      if (!canReportToProject(ctx.user!, projectId, db)) {
        sendJson(ctx.res, 403, { ok: false, error: "无权将日报事项归入该项目" });
        return;
      }
    }
    const financeError = validateFinanceCodeSelections(affiliations, availableProjects, db);
    if (financeError) {
      sendJson(ctx.res, 400, { ok: false, error: financeError });
      return;
    }
    const result = await runAiCheck(affiliations, listCategories(), affNameMap());
    applyCats(affiliations, result.cats);

    const now = nowIso();
    const uid = ctx.user!.id;
    let autoCount = 0;
    let confirmedCount = 0;
    for (const aff of affiliations) {
      for (const it of aff.items) {
        for (const c of it.cats) {
          if (!c.manual) {
            autoCount += 1;
            if (c.confirmed) confirmedCount += 1;
          }
        }
      }
    }

    const existing = getLog(uid, resolved.date);
    const isEdit = Boolean(existing);
    db.exec("BEGIN");
    try {
      let logId: number;
      if (existing) {
        logId = existing.id;
        const oldItems = db.prepare("SELECT id FROM log_items WHERE log_id = ?").all(logId) as unknown as Array<{ id: number }>;
        for (const oi of oldItems) {
          db.prepare("DELETE FROM item_cats WHERE item_id = ?").run(oi.id);
          db.prepare("UPDATE attachments SET item_id = -1 WHERE item_id = ?").run(oi.id);
        }
        db.prepare("DELETE FROM log_items WHERE log_id = ?").run(logId);
        db.prepare("UPDATE logs SET quality = ?, updated_at = ? WHERE id = ?").run(result.quality, now, logId);
      } else {
        db.prepare(
          "INSERT INTO logs (user_id, date, status, quality, submitted_at, updated_at) VALUES (?, ?, 'submitted', ?, ?, ?)",
        ).run(uid, resolved.date, result.quality, now, now);
        logId = Number(
          (db.prepare("SELECT id FROM logs WHERE user_id = ? AND date = ? AND status='submitted'").get(uid, resolved.date) as { id: number }).id,
        );
      }
      let ord = 0;
      const usedCatIds: number[] = [];
      for (const aff of affiliations) {
        for (const it of aff.items) {
          ord += 1;
          const projectId = aff.affId === "dept" ? null : Number(aff.affId);
          const projectNameSnapshot = projectId ? availableProjects.get(projectId)?.name ?? null : null;
          const text = it.text.trim();
          db.prepare(
            `INSERT INTO log_items
              (log_id, ord, aff, text, hours, scope_type, project_id, project_name_snapshot, finance_project_code_id,
               work_status, work_summary, result_text, support_people_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, '[]')`,
          ).run(
            logId,
            ord,
            aff.affId,
            text,
            it.hours,
            projectId ? "project" : "department_daily",
            projectId,
            projectNameSnapshot,
            projectId ? (aff.financeCodeId ?? null) : null,
            text,
            text,
          );
          const itemId = Number(
            (db.prepare("SELECT id FROM log_items WHERE log_id = ? AND ord = ?").get(logId, ord) as { id: number }).id,
          );
          for (const c of it.cats) {
            db.prepare("INSERT OR IGNORE INTO item_cats (item_id, cat_id, confirmed, manual) VALUES (?, ?, ?, ?)").run(
              itemId,
              c.id,
              c.confirmed ? 1 : 0,
              c.manual ? 1 : 0,
            );
            usedCatIds.push(c.id);
          }
          for (const a of it.atts) {
            if (a.id) {
              db.prepare("UPDATE pending_uploads SET id = id WHERE id = ?").run(a.id);
              const pu = db
                .prepare("SELECT filename, stored_name, size FROM pending_uploads WHERE id = ? AND user_id = ?")
                .get(a.id, uid) as { filename: string; stored_name: string; size: number } | undefined;
              if (pu) {
                db.prepare("INSERT INTO attachments (item_id, filename, stored_name, size) VALUES (?, ?, ?, ?)").run(
                  itemId,
                  pu.filename,
                  pu.stored_name,
                  pu.size,
                );
              }
            }
          }
        }
      }
      recordReportVersion(
        logId,
        uid,
        resolved.date === todayYmd() ? "current_day_form" : "previous_workday_edit",
        db,
      );
      db.exec("COMMIT");
      bumpCategoryUse(usedCatIds);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    if (autoCount > 0) bumpAdopt(uid, resolved.date, autoCount, confirmedCount);
    if (resolved.mode === "today") deleteDraft(uid, resolved.date);
    invalidateAggCache();
    audit(uid, isEdit ? "log.update" : "log.submit", resolved.date);

    const totalItems = affiliations.reduce((s, a) => s + a.items.length, 0);
    const totalHours = Math.round(affiliations.reduce((s, a) => s + a.items.reduce((x, i) => x + i.hours, 0), 0) * 10) / 10;
    sendJson(ctx.res, 200, {
      ok: true,
      mode: resolved.mode,
      date: resolved.date,
      isEdit,
      quality: result.quality,
      totalItems,
      totalHours,
      affiliations,
      adopt: getAdopt(uid, resolved.date),
      suggestionsSource: result.source,
    });
  });

  /** 我的日志列表 */
  router.get("/api/mylogs", (ctx) => {
    if (!requireUser(ctx)) return;
    if (!canUsePersonalLogs(ctx.user!)) {
      sendJson(ctx.res, 403, { ok: false, error: "一期主管不填写日志（PRD 5.2），该入口对管理角色关闭" });
      return;
    }
    const db = getDb();
    const uid = ctx.user!.id;
    const today = todayYmd();
    const logs = db
      .prepare(
        `SELECT l.id, l.date, l.quality,
                (SELECT COUNT(*) FROM log_items i WHERE i.log_id = l.id) AS items,
                (SELECT ROUND(SUM(i.hours), 1) FROM log_items i WHERE i.log_id = l.id) AS hours
         FROM logs l WHERE l.user_id = ? AND l.status = 'submitted' ORDER BY l.date DESC LIMIT 60`,
      )
      .all(uid) as unknown as Array<{ id: number; date: string; quality: string; items: number; hours: number }>;
    const submittedDates = new Set(logs.map((l) => l.date));
    /** 近 10 个工作日（不含今天）補全 missing 行 */
    const rows: Array<Record<string, unknown>> = [];
    const dates: string[] = [];
    {
      let cur = today;
      let guard = 0;
      while (dates.length < 10 && guard < 40) {
        if (isWorkday(cur)) dates.push(cur);
        cur = prevWorkday(cur);
        guard += 1;
      }
    }
    const retro = prevWorkday(today);
    const byDate = new Map(logs.map((l) => [l.date, l]));
    for (const d of dates) {
      const log = byDate.get(d);
      if (log) {
        rows.push({ date: d, wd: d === today ? "" : wdLabel(d), status: "submitted", items: log.items, hours: log.hours, quality: log.quality, canEdit: canEditReportDate(ctx.user!, d, today, retro) });
      } else if (d !== today) {
        rows.push({ date: d, wd: wdLabel(d), status: "missing", canRetro: d === retro });
      } else {
        rows.push({ date: d, wd: "", status: "today-pending" });
      }
    }
    for (const l of logs) {
      if (!dates.includes(l.date)) {
        rows.push({ date: l.date, wd: wdLabel(l.date), status: "submitted", items: l.items, hours: l.hours, quality: l.quality, canEdit: canEditReportDate(ctx.user!, l.date, today, retro) });
      }
    }
    sendJson(ctx.res, 200, {
      ok: true,
      retroDate: retro,
      adopt: getAdopt(uid, today),
      rows,
    });
  });

  /** 本人已提交日报原文，仅做结构排版。 */
  router.get("/api/mylogs/export", (ctx) => {
    if (!requireUser(ctx)) return;
    const date = String(ctx.url.searchParams.get("date") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(ctx.res, 400, { ok: false, error: "请选择有效的日报日期" });
      return;
    }
    const text = exportOriginalReport(getDb(), ctx.user!.id, date);
    if (text === null) {
      sendJson(ctx.res, 404, { ok: false, error: "当天没有已提交的日报可导出" });
      return;
    }
    ctx.res.setHeader("Cache-Control", "no-store");
    sendJson(ctx.res, 200, { ok: true, date, text });
  });

  /** 我的日志详情 */
  router.get("/api/mylogs/detail", (ctx) => {
    if (!requireUser(ctx)) return;
    const date = String(ctx.url.searchParams.get("date") ?? "");
    const log = getLog(ctx.user!.id, date);
    if (!log) {
      sendJson(ctx.res, 404, { ok: false, error: "无法加载该日志内容" });
      return;
    }
    const db = getDb();
    const report = readFormalReport(log.id, db);
    if (!report) {
      sendJson(ctx.res, 404, { ok: false, error: "无法加载该日志内容" });
      return;
    }
    const names = affNameMap();
    const detail = report.items.map((it) => {
      const aff = it.scopeType === "project" && it.projectId ? String(it.projectId) : "dept";
      return {
        itemId: it.id,
        order: it.order,
        aff,
        affName: it.projectNameSnapshot ?? names.get(aff) ?? aff,
        financeCodeId: it.financeCodeId,
        financeCode: it.financeCode,
        financeCodeName: it.financeCodeName,
        text: it.resultText || it.workSummary,
        workSummary: it.workSummary,
        resultText: it.resultText,
        status: it.status,
        hours: it.hours,
        blockerText: it.blockerText ?? "",
        nextAction: it.nextAction ?? "",
        supportNeeded: it.supportNeeded ?? "",
        supportPeople: it.supportPersonNames,
        tomorrowPlan: it.tomorrowPlan ?? "",
        cats: (
          db
            .prepare(
              "SELECT c.id, c.name, ic.confirmed, ic.manual FROM item_cats ic JOIN categories c ON c.id = ic.cat_id WHERE ic.item_id = ?",
            )
            .all(it.id) as unknown as Array<{ id: number; name: string; confirmed: number; manual: number }>
        ).map((c) => ({ id: c.id, name: c.name, confirmed: c.confirmed === 1, manual: c.manual === 1 })),
        atts: db
          .prepare("SELECT id, filename AS name FROM attachments WHERE item_id = ?")
          .all(it.id) as unknown as Array<{ id: number; name: string }>,
      };
    });
    sendJson(ctx.res, 200, {
      ok: true,
      date,
      quality: log.quality,
      totalHours: report.totalHours,
      version: report.currentVersion,
      canEdit: canEditReportDate(ctx.user!, date),
      items: detail,
    });
  });

  /** 确认单个系统归类标签（我的日志详情弹层） */
  router.post("/api/mylogs/confirm-cat", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ itemId?: number; catId?: number }>(ctx.req);
    const itemId = Number(body.itemId) || 0;
    const catId = Number(body.catId) || 0;
    const db = getDb();
    const own = db
      .prepare(
        `SELECT ic.confirmed, l.date FROM item_cats ic
         JOIN log_items i ON i.id = ic.item_id JOIN logs l ON l.id = i.log_id
         WHERE ic.item_id = ? AND ic.cat_id = ? AND l.user_id = ? AND l.status='submitted'`,
      )
      .get(itemId, catId, ctx.user!.id) as { confirmed: number; date: string } | undefined;
    if (!own) {
      sendJson(ctx.res, 404, { ok: false, error: "标签不存在" });
      return;
    }
    if (!canEditReportDate(ctx.user!, own.date)) {
      sendJson(ctx.res, 403, { ok: false, error: "更早日报只读" });
      return;
    }
    if (own.confirmed !== 1) {
      db.prepare("UPDATE item_cats SET confirmed = 1 WHERE item_id = ? AND cat_id = ?").run(itemId, catId);
      bumpAdopt(ctx.user!.id, todayYmd(), 0, 1);
    }
    sendJson(ctx.res, 200, { ok: true, adopt: getAdopt(ctx.user!.id, todayYmd()) });
  });

  /** 删除已提交日志（PRD 8.6-6） */
  router.post("/api/mylogs/delete", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ date?: string }>(ctx.req);
    const date = String(body.date ?? "");
    if (!canEditReportDate(ctx.user!, date)) {
      sendJson(ctx.res, 403, { ok: false, error: "更早日报只读，不能删除" });
      return;
    }
    const log = getLog(ctx.user!.id, date);
    if (!log) {
      sendJson(ctx.res, 404, { ok: false, error: "该日期没有已提交日志" });
      return;
    }
    getDb().prepare("UPDATE logs SET status = 'deleted', deleted_at = ? WHERE id = ?").run(nowIso(), log.id);
    invalidateAggCache();
    audit(ctx.user!.id, "log.delete", date);
    sendJson(ctx.res, 200, { ok: true });
  });

  /** 附件上传（先入 pending，提交时挂到事项） */
  router.post("/api/upload", async (ctx) => {
    if (!requireUser(ctx)) return;
    const filename = decodeURIComponent(String(ctx.url.searchParams.get("name") ?? "file")).slice(0, 180);
    const buf = await readBody(ctx.req, CONFIG.upload.maxBytes).catch(() => null);
    if (!buf) {
      sendJson(ctx.res, 413, { ok: false, error: "附件过大（上限 20MB）" });
      return;
    }
    if (buf.length === 0) {
      sendJson(ctx.res, 400, { ok: false, error: "空文件" });
      return;
    }
    const ext = path.extname(filename).toLowerCase();
    const banned = [".exe", ".bat", ".cmd", ".sh", ".js", ".vbs", ".dll", ".msi", ".com", ".scr"];
    if (banned.includes(ext)) {
      sendJson(ctx.res, 400, { ok: false, error: "不支持的附件类型" });
      return;
    }
    fs.mkdirSync(CONFIG.uploadsDir, { recursive: true });
    const stored = `${Date.now()}-${randomBytes(6).toString("hex")}${ext}`;
    fs.writeFileSync(path.join(CONFIG.uploadsDir, stored), buf);
    const db = getDb();
    db.prepare("INSERT INTO pending_uploads (user_id, filename, stored_name, size) VALUES (?, ?, ?, ?)").run(
      ctx.user!.id,
      filename,
      stored,
      buf.length,
    );
    const id = Number(
      (db.prepare("SELECT id FROM pending_uploads WHERE stored_name = ?").get(stored) as { id: number }).id,
    );
    sendJson(ctx.res, 200, { ok: true, id, name: filename });
  });

  /** 附件下载（继承日志权限：本人或权限内可见） */
  router.get("/api/attachment/:id", (ctx) => {
    if (!requireUser(ctx)) return;
    const id = Number(ctx.params.id) || 0;
    const db = getDb();
    const att = db
      .prepare(
        `SELECT a.filename, a.stored_name, l.user_id AS owner, i.project_id FROM attachments a
         JOIN log_items i ON i.id = a.item_id JOIN logs l ON l.id = i.log_id WHERE a.id = ?`,
      )
      .get(id) as { filename: string; stored_name: string; owner: number; project_id: number | null } | undefined;
    if (!att) {
      sendJson(ctx.res, 404, { ok: false, error: "附件不存在" });
      return;
    }
    const scope = resolveScope(ctx.user!);
    if (
      scope.userIds !== null &&
      !scope.userIds.includes(att.owner) &&
      !(canUseDwsAssistant(ctx.user!) && att.project_id && canViewProjectReports(ctx.user!, att.project_id, db))
    ) {
      sendJson(ctx.res, 403, { ok: false, error: "无权访问该附件" });
      return;
    }
    const file = path.join(CONFIG.uploadsDir, att.stored_name);
    if (!fs.existsSync(file)) {
      sendJson(ctx.res, 404, { ok: false, error: "附件文件缺失" });
      return;
    }
    ctx.res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
    });
    fs.createReadStream(file).pipe(ctx.res);
  });

  /** 新建分类（正式项目由 projects/routes.ts 统一做服务端权限校验）。 */
  router.post("/api/categories", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ name?: string; force?: boolean }>(ctx.req);
    const name = String(body.name ?? "").trim();
    if (!name) {
      sendJson(ctx.res, 400, { ok: false, error: "请输入分类名称" });
      return;
    }
    const similar = listCategories()
      .map((c) => c.name)
      .filter((n) => n !== name && strSimilar(n, name));
    if (similar.length > 0 && !body.force) {
      sendJson(ctx.res, 200, { ok: true, similar, created: null });
      return;
    }
    const row = createCategory(name, ctx.user!.id);
    audit(ctx.user!.id, "category.create", name);
    sendJson(ctx.res, 200, { ok: true, similar: [], created: { id: row.id, name: row.name } });
  });
}

function applyCats(
  affiliations: DraftAffiliation[],
  cats: Map<number, number[]>,
): void {
  let g = 0;
  for (const aff of affiliations) {
    for (const it of aff.items) {
      g += 1;
      const locked = it.cats.some((c) => c.confirmed || c.manual);
      if (locked) continue;
      const ids = cats.get(g);
      if (!ids) continue;
      it.cats = ids.map((id) => ({ id, confirmed: false }));
    }
  }
}
