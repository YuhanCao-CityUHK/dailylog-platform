/** 视角 API：主管首页 / 项目 / 分类 / 员工 / 部门日常 / 关注。 */
import { getDb } from "../infra/db";
import { sendJson, readJson, type Ctx, type Router } from "../infra/http";
import { addDaysYmd, dateLabel, todayYmd } from "../infra/workcal";
import { capabilitiesForUser } from "../auth/capabilities";
import {
  computeInsights,
  homeDefaultDate,
  hourDist,
  hoursByDate,
  itemsCacheStamp,
  riskWatch,
  submissionStatus,
  windowDates,
} from "./aggregate";
import { fetchSubmittedItems, listCategories, listFollows, listProjects, toggleFollow } from "./store";
import { listEmployeesInScope, resolveScope } from "./scope";
import {
  listDailyReportProjectsForUser,
  userCanViewDailyReports,
} from "../web/daily-reports-access";
import { canViewProjectReports } from "../projects/permissions";
import { listFormalProjects } from "../projects/service";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireUser(ctx: Ctx): boolean {
  if (!ctx.user) {
    sendJson(ctx.res, 401, { ok: false, error: "未登录" });
    return false;
  }
  return true;
}

export function registerViewRoutes(router: Router): void {
  /** 主管首页 */
  router.get("/api/views/home", async (ctx) => {
    if (!requireUser(ctx)) return;
    if (!capabilitiesForUser(ctx.user!, getDb()).supervisor) {
      sendJson(ctx.res, 403, {
        ok: false,
        error: "主管首页仅面向钉钉组织中的主管和公司管理角色开放",
      });
      return;
    }
    const scope = resolveScope(ctx.user!);
    const date = homeDefaultDate();
    const dates = windowDates(date);
    const items = fetchSubmittedItems({ dates, userIds: scope.userIds ?? undefined });
    const insights = await computeInsights(
      items,
      dates,
      "团队全部项目与部门日常",
      `home:${ctx.user!.role}:${itemsCacheStamp(items)}`,
    );
    const follows = listFollows(ctx.user!.id);
    sendJson(ctx.res, 200, {
      ok: true,
      date,
      dateLabel: dateLabel(date),
      submission: submissionStatus(date, scope.userIds),
      riskWatch: riskWatch(items, dates),
      hourDist: hourDist(items.filter((i) => i.date !== date || true)),
      progress: insights.progress,
      blockers: insights.blockers,
      insightsSource: insights.source,
      follows,
    });
  });

  /** 项目视角 */
  router.get("/api/views/project", async (ctx) => {
    if (!requireUser(ctx)) return;
    const db = getDb();
    if (!capabilitiesForUser(ctx.user!, db).projects) {
      sendJson(ctx.res, 403, { ok: false, error: "项目页仅面向项目负责人、部门主管和公司管理角色开放" });
      return;
    }
    const requestedDate = ctx.url.searchParams.get("date")?.trim() ?? "";
    if (requestedDate && !YMD_RE.test(requestedDate)) {
      sendJson(ctx.res, 400, { ok: false, error: "日期格式应为 YYYY-MM-DD" });
      return;
    }
    const selectedDate = requestedDate || addDaysYmd(todayYmd(), -1);
    const accessibleProjectIds = new Set(listFormalProjects(ctx.user!, db, true).map((project) => project.id));
    const projects = listProjects(true).filter((project) => accessibleProjectIds.has(project.id));
    const dailyReportProjects = listDailyReportProjectsForUser(ctx.user!);
    const canViewDingtalkProjects = userCanViewDailyReports(ctx.user!);
    const requestedId = Number(ctx.url.searchParams.get("id") ?? 0) || projects[0]?.id || 0;
    const proj = projects.find((p) => p.id === requestedId) ?? projects[0];
    const follows = listFollows(ctx.user!.id);
    if (!proj) {
      sendJson(ctx.res, 200, {
        ok: true,
        projects: [],
        dailyReportProjects,
        canViewDingtalkProjects,
        date: selectedDate,
        dateLabel: dateLabel(selectedDate),
        project: null,
        follows,
      });
      return;
    }
    const scope = resolveScope(ctx.user!);
    const dates = [selectedDate];
    const projectWide = canViewProjectReports(ctx.user!, proj.id, db);
    const items = fetchSubmittedItems({
      dates,
      userIds: projectWide ? undefined : scope.userIds ?? undefined,
      aff: String(proj.id),
    });
    /** 标签计数：同一事项同一标签只计 1 次 */
    const catCount = new Map<number, { name: string; n: number }>();
    for (const it of items) {
      for (const c of it.cats) {
        const cur = catCount.get(c.id) ?? { name: c.name, n: 0 };
        cur.n += 1;
        catCount.set(c.id, cur);
      }
    }
    const people = new Map<string, number>();
    for (const it of items) people.set(it.empName, (people.get(it.empName) ?? 0) + it.hours);
    const timeline = new Map<string, Array<Record<string, unknown>>>();
    for (const it of [...items].sort((a, b) => (a.date < b.date ? 1 : -1))) {
      const list = timeline.get(it.date) ?? [];
      list.push({
        itemId: it.itemId,
        logId: it.logId,
        emp: it.empName,
        text: it.text,
        hours: it.hours,
        cats: it.cats.map((c) => ({
          id: c.id,
          name: c.name,
          confirmed: c.confirmed,
          manual: c.manual,
        })),
        atts: it.atts,
      });
      timeline.set(it.date, list);
    }
    sendJson(ctx.res, 200, {
      ok: true,
      projects: projects.map((p) => ({ id: p.id, name: p.name, owner: p.owner_name ?? "" })),
      dailyReportProjects,
      canViewDingtalkProjects,
      date: selectedDate,
      dateLabel: dateLabel(selectedDate),
      project: {
        id: proj.id,
        name: proj.name,
        owner: proj.owner_name ?? "",
        descr: proj.descr,
        hours7total: Math.round(items.reduce((s, i) => s + i.hours, 0) * 10) / 10,
        memberCount: people.size,
        itemCount: items.length,
        activeDays: timeline.size,
        reportCount: new Set(items.map((item) => item.logId)).size,
        people: [...people.entries()].map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 })),
        hours7: hoursByDate(items, dates),
        catCounts: [...catCount.entries()]
          .map(([id, v]) => ({ id, name: v.name, n: v.n }))
          .sort((a, b) => b.n - a.n),
        timeline: [...timeline.entries()].map(([d, list]) => ({ date: d, label: dateLabel(d), items: list })),
      },
      follows,
    });
  });

  /** 分类视角 */
  router.get("/api/views/category", async (ctx) => {
    if (!requireUser(ctx)) return;
    if (!capabilitiesForUser(ctx.user!, getDb()).supervisor) {
      sendJson(ctx.res, 403, { ok: false, error: "分类视角仅面向主管和公司管理角色开放" });
      return;
    }
    const cats = listCategories();
    const follows = listFollows(ctx.user!.id);
    const requestedId = Number(ctx.url.searchParams.get("id") ?? 0);
    if (!requestedId) {
      sendJson(ctx.res, 200, {
        ok: true,
        categories: cats.map((c) => ({ id: c.id, name: c.name, count: c.use_count })),
        category: null,
        follows,
      });
      return;
    }
    const cat = cats.find((c) => c.id === requestedId);
    if (!cat) {
      sendJson(ctx.res, 404, { ok: false, error: "分类不存在" });
      return;
    }
    const scope = resolveScope(ctx.user!);
    const dates = windowDates();
    const all = fetchSubmittedItems({ dates, userIds: scope.userIds ?? undefined });
    const items = all.filter((i) => i.cats.some((c) => c.id === cat.id));
    const insights = await computeInsights(
      items,
      dates,
      `分类「${cat.name}」相关工作`,
      `category:${cat.id}:${itemsCacheStamp(items)}`,
    );
    const projSet = new Map<string, string>();
    const people = new Set<string>();
    let hours = 0;
    for (const it of items) {
      projSet.set(it.aff, it.affName);
      people.add(it.empName);
      hours += it.hours;
    }
    sendJson(ctx.res, 200, {
      ok: true,
      categories: cats.map((c) => ({ id: c.id, name: c.name, count: c.use_count })),
      category: {
        id: cat.id,
        name: cat.name,
        count: cat.use_count,
        projects: [...projSet.entries()].map(([aff, name]) => ({ aff, name })),
        people: [...people],
        hours: Math.round(hours * 10) / 10,
        progress: insights.progress,
        blockers: insights.blockers,
        refs: items.slice(-20).reverse().map((it) => ({
          itemId: it.itemId,
          emp: it.empName,
          date: it.date,
          aff: it.aff,
          affName: it.affName,
          excerpt: it.text.length > 90 ? `${it.text.slice(0, 90)}…` : it.text,
        })),
      },
      follows,
    });
  });

  /** 员工视角 */
  router.get("/api/views/employee", async (ctx) => {
    if (!requireUser(ctx)) return;
    const db = getDb();
    if (!capabilitiesForUser(ctx.user!, db).supervisor) {
      sendJson(ctx.res, 403, { ok: false, error: "员工视角仅面向主管和公司管理角色开放" });
      return;
    }
    const me = ctx.user!;
    const scope = resolveScope(me);
    const selfOnly =
      scope.userIds !== null && scope.userIds.length === 1 && scope.userIds[0] === me.id;
    const list = listEmployeesInScope(scope);
    const requestedId = Number(ctx.url.searchParams.get("id") ?? 0) || me.id;
    const target = list.find((u) => u.id === requestedId) ?? list[0];
    if (!target) {
      sendJson(ctx.res, 200, { ok: true, employees: [], employee: null, selfOnly });
      return;
    }
    const dates = windowDates();
    const items = fetchSubmittedItems({ dates, userIds: [target.id] });
    const byAff = new Map<string, { name: string; hours: number }>();
    const itemsByDate = new Map<string, typeof items>();
    let total = 0;
    for (const it of items) {
      total += it.hours;
      const cur = byAff.get(it.aff) ?? { name: it.affName, hours: 0 };
      cur.hours += it.hours;
      byAff.set(it.aff, cur);
      const dateItems = itemsByDate.get(it.date) ?? [];
      dateItems.push(it);
      itemsByDate.set(it.date, dateItems);
    }
    const qualities = { ex: 0, vg: 0, good: 0 };
    const logRows = db
      .prepare(
        "SELECT date, quality, (SELECT COUNT(*) FROM log_items i WHERE i.log_id = logs.id) AS items FROM logs WHERE user_id = ? AND status='submitted' AND date IN (" +
          dates.map(() => "?").join(",") +
          ") ORDER BY date DESC",
      )
      .all(target.id, ...(dates as never[])) as unknown as Array<{ date: string; quality: string; items: number }>;
    for (const l of logRows) {
      if (l.quality === "ex") qualities.ex += 1;
      else if (l.quality === "vg") qualities.vg += 1;
      else if (l.quality === "good") qualities.good += 1;
    }
    sendJson(ctx.res, 200, {
      ok: true,
      employees: list,
      selfOnly,
      employee: {
        id: target.id,
        name: target.name,
        title: target.title,
        totalHours: Math.round(total * 10) / 10,
        workload: [...byAff.entries()]
          .map(([aff, v]) => ({
            aff,
            name: v.name,
            hours: Math.round(v.hours * 10) / 10,
            pc: total > 0 ? Math.round((v.hours / total) * 100) : 0,
          }))
          .sort((a, b) => b.hours - a.hours),
        qualities,
        logs: logRows.map((log) => ({
          ...log,
          entries: (itemsByDate.get(log.date) ?? []).map((item) => ({
            itemId: item.itemId,
            affName: item.affName,
            text: item.text,
            hours: item.hours,
            cats: item.cats,
            atts: item.atts,
          })),
        })),
      },
    });
  });

  /** 员工原始日志弹层 */
  router.get("/api/views/employee-log", (ctx) => {
    if (!requireUser(ctx)) return;
    const uid = Number(ctx.url.searchParams.get("id") ?? 0);
    const date = String(ctx.url.searchParams.get("date") ?? "");
    const scope = resolveScope(ctx.user!);
    if (scope.userIds !== null && !scope.userIds.includes(uid)) {
      sendJson(ctx.res, 403, { ok: false, error: "无权查看该员工日志" });
      return;
    }
    const items = fetchSubmittedItems({ dates: [date], userIds: [uid] });
    if (items.length === 0) {
      sendJson(ctx.res, 404, { ok: false, error: "该日期无已提交日志" });
      return;
    }
    sendJson(ctx.res, 200, {
      ok: true,
      emp: items[0].empName,
      date,
      quality: items[0].quality,
      items: items.map((it) => ({
        affName: it.affName,
        text: it.text,
        hours: it.hours,
        cats: it.cats.map((c) => ({ id: c.id, name: c.name })),
        atts: it.atts,
      })),
    });
  });

  /** 部门日常 */
  router.get("/api/views/dept", (ctx) => {
    if (!requireUser(ctx)) return;
    if (!capabilitiesForUser(ctx.user!, getDb()).supervisor) {
      sendJson(ctx.res, 403, { ok: false, error: "部门日常仅面向主管和公司管理角色开放" });
      return;
    }
    const scope = resolveScope(ctx.user!);
    const dates = windowDates();
    const items = fetchSubmittedItems({ dates, userIds: scope.userIds ?? undefined, aff: "dept" });
    const catSet = new Map<number, string>();
    for (const it of items) for (const c of it.cats) catSet.set(c.id, c.name);
    sendJson(ctx.res, 200, {
      ok: true,
      cats: [...catSet.entries()].map(([id, name]) => ({ id, name })),
      entries: [...items].reverse().map((it) => ({
        itemId: it.itemId,
        date: it.date,
        emp: it.empName,
        hours: it.hours,
        text: it.text,
        cats: it.cats.map((c) => ({ id: c.id, name: c.name })),
        atts: it.atts,
      })),
    });
  });

  /** 引用原文（各视角引用弹层展开） */
  router.get("/api/views/ref/:itemId", (ctx) => {
    if (!requireUser(ctx)) return;
    const itemId = Number(ctx.params.itemId) || 0;
    const db = getDb();
    const row = db
      .prepare(
        `SELECT i.id AS itemId, i.text, i.hours, i.aff, i.project_id, l.date, l.user_id AS uid, u.name AS emp
         FROM log_items i JOIN logs l ON l.id = i.log_id JOIN users u ON u.id = l.user_id
         WHERE i.id = ? AND l.status = 'submitted'`,
      )
      .get(itemId) as
      | { itemId: number; text: string; hours: number; aff: string; project_id: number | null; date: string; uid: number; emp: string }
      | undefined;
    if (!row) {
      sendJson(ctx.res, 404, { ok: false, error: "引用的日志不存在或已删除" });
      return;
    }
    const scope = resolveScope(ctx.user!);
    if (
      scope.userIds !== null &&
      !scope.userIds.includes(row.uid) &&
      !(row.project_id && canViewProjectReports(ctx.user!, row.project_id, db))
    ) {
      sendJson(ctx.res, 403, { ok: false, error: "无权查看该日志" });
      return;
    }
    const projects = listProjects(true);
    const affName = row.aff === "dept" ? "部门日常" : projects.find((p) => String(p.id) === row.aff)?.name ?? row.aff;
    sendJson(ctx.res, 200, { ok: true, ref: { ...row, affName } });
  });

  /** 关注切换 */
  router.post("/api/follows/toggle", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ kind?: string; targetId?: number }>(ctx.req);
    const kind = body.kind === "p" ? "p" : body.kind === "c" ? "c" : null;
    const targetId = Number(body.targetId) || 0;
    if (!kind || !targetId) {
      sendJson(ctx.res, 400, { ok: false, error: "参数错误" });
      return;
    }
    const followed = toggleFollow(ctx.user!.id, kind, targetId);
    sendJson(ctx.res, 200, { ok: true, followed, follows: listFollows(ctx.user!.id) });
  });
}

export function viewsAllowManagerOnly(ctx: Ctx): boolean {
  return Boolean(ctx.user && capabilitiesForUser(ctx.user, getDb()).supervisor);
}
