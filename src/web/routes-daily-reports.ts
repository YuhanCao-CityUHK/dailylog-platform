/** 日报汇总（照搬模块）HTTP 接线：页面 + API。仅内部管理角色可见。 */
import { readJson, sendHtml, sendJson, type Ctx, type Router } from "../infra/http";
import { userCanViewDailyReports } from "./daily-reports-access";
import {
  buildDailyReportsHttpPayload,
  parseDailyReportsViewParam,
} from "./daily-reports-api";
import { addToRoster, getRosterView, removeFromRoster, searchOrgCandidates } from "./daily-reports-roster";
import {
  listProjectGroupMembers,
  updateProjectGroupAssignments,
} from "./daily-reports-project-groups";
import {
  getProjectViewRosterPayload,
  mutateProjectViewRoster,
  rediscoverProjectViewRoster,
} from "./daily-reports-project-view-roster";
import type { WorkbenchDailyReportsCaps } from "../digest/daily-report-project-views";
import { destroySession, clearSessionCookie } from "../auth/session";

function guard(ctx: Ctx): boolean {
  if (!ctx.user) {
    sendJson(ctx.res, 401, { ok: false, error: "未登录" });
    return false;
  }
  if (!userCanViewDailyReports(ctx.user)) {
    sendJson(ctx.res, 403, { ok: false, error: "日报汇总仅面向内部管理角色及已授权人员开放" });
    return false;
  }
  return true;
}

function capsOf(ctx: Ctx): WorkbenchDailyReportsCaps {
  const role = ctx.user!.role;
  return {
    canAccessAdmin: role === "admin",
    canManage: role === "admin" || role === "mgr" || role === "exec",
    canViewCatalog: true,
  };
}

function sessionUserIdOf(ctx: Ctx): string {
  return ctx.user!.ddUserid ?? `local:${ctx.user!.id}`;
}

export function registerDailyReportRoutes(router: Router): void {
  router.get("/workbench/daily-reports", (ctx) => {
    if (!ctx.user) {
      ctx.res.writeHead(302, { Location: "/login?next=/workbench/daily-reports" });
      ctx.res.end();
      return;
    }
    if (!userCanViewDailyReports(ctx.user)) {
      sendHtml(ctx.res, 403, "<p style='font-family:sans-serif;padding:40px'>日报汇总仅面向内部管理角色及已授权人员开放。<a href='/'>返回平台</a></p>");
      return;
    }
    const rawView = ctx.url.searchParams.get("view") ?? "";
    const customProjectId = rawView.startsWith("custom:") ? rawView.slice("custom:".length) : "";
    const catalogProjectId = rawView.startsWith("catalog:") ? rawView.slice("catalog:".length) : "";
    const date = ctx.url.searchParams.get("date") ?? "";
    const params = new URLSearchParams({
      projectSource: catalogProjectId === "others" ? "unassigned" : catalogProjectId ? "unified" : "dingtalk",
    });
    if (catalogProjectId && catalogProjectId !== "others") params.set("projectId", catalogProjectId);
    if (customProjectId) params.set("projectId", customProjectId);
    if (date) params.set("date", date);
    ctx.res.writeHead(302, { Location: `/?${params.toString()}#project` });
    ctx.res.end();
  });

  router.get("/api/workbench/daily-reports", async (ctx) => {
    if (!guard(ctx)) return;
    const payload = await buildDailyReportsHttpPayload({
      date: ctx.url.searchParams.get("date") ?? undefined,
      view: parseDailyReportsViewParam(ctx.url.searchParams.get("view")),
      userId: sessionUserIdOf(ctx),
      caps: capsOf(ctx),
      refresh: ctx.url.searchParams.get("refresh") === "1",
    });
    sendJson(ctx.res, 200, payload);
  });

  router.get("/api/workbench/daily-reports/roster", (ctx) => {
    if (!guard(ctx)) return;
    if (!capsOf(ctx).canAccessAdmin) {
      sendJson(ctx.res, 403, { ok: false, error: "仅管理员可管理名单" });
      return;
    }
    sendJson(ctx.res, 200, { ok: true, ...getRosterView() });
  });

  router.post("/api/workbench/daily-reports/roster", async (ctx) => {
    if (!guard(ctx)) return;
    if (!capsOf(ctx).canAccessAdmin) {
      sendJson(ctx.res, 403, { ok: false, error: "仅管理员可管理名单" });
      return;
    }
    const body = await readJson<{ action?: string; org?: string; userid?: string; name?: string }>(ctx.req);
    try {
      if (body.action === "add") {
        const result = await addToRoster(String(body.org ?? ""), String(body.userid ?? ""), String(body.name ?? ""));
        sendJson(ctx.res, 200, { ok: true, orgs: result.orgs, validation: result.validation });
      } else if (body.action === "remove") {
        const result = removeFromRoster(String(body.org ?? ""), String(body.userid ?? ""));
        sendJson(ctx.res, 200, { ok: true, orgs: result.orgs });
      } else {
        sendJson(ctx.res, 400, { ok: false, error: "action 必须为 add 或 remove" });
      }
    } catch (err) {
      sendJson(ctx.res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/workbench/daily-reports/contacts", async (ctx) => {
    if (!guard(ctx)) return;
    try {
      const result = await searchOrgCandidates(
        String(ctx.url.searchParams.get("org") ?? ""),
        String(ctx.url.searchParams.get("q") ?? ""),
      );
      sendJson(ctx.res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(ctx.res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/workbench/daily-reports/project-groups", (ctx) => {
    if (!guard(ctx)) return;
    try {
      sendJson(ctx.res, 200, { ok: true, members: listProjectGroupMembers() });
    } catch (err) {
      sendJson(ctx.res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/workbench/daily-reports/project-groups", async (ctx) => {
    if (!guard(ctx)) return;
    if (!capsOf(ctx).canManage) {
      sendJson(ctx.res, 403, { ok: false, error: "无权调整项目组归属" });
      return;
    }
    const body = await readJson<{ updates?: Array<{ orgLabel: string; userid: string; projectGroup: string }> }>(ctx.req);
    try {
      const members = updateProjectGroupAssignments(
        (body.updates ?? []).map((u) => ({
          orgLabel: String(u.orgLabel ?? ""),
          userid: String(u.userid ?? ""),
          projectGroup: u.projectGroup as never,
        })),
      );
      sendJson(ctx.res, 200, { ok: true, members });
    } catch (err) {
      sendJson(ctx.res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/workbench/daily-reports/project-views/:viewId/roster", (ctx) => {
    if (!guard(ctx)) return;
    sendJson(ctx.res, 200, getProjectViewRosterPayload(ctx.params.viewId));
  });

  router.post("/api/workbench/daily-reports/project-views/:viewId/roster", async (ctx) => {
    if (!guard(ctx)) return;
    const body = await readJson<{ action?: string; userid?: string; name?: string }>(ctx.req);
    const payload = await mutateProjectViewRoster({
      viewId: ctx.params.viewId,
      action: body.action === "remove" ? "remove" : "add",
      userid: String(body.userid ?? ""),
      name: body.name ? String(body.name) : undefined,
    });
    sendJson(ctx.res, payload.ok ? 200 : 400, payload);
  });

  router.post("/api/workbench/daily-reports/project-views/:viewId/discover", async (ctx) => {
    if (!guard(ctx)) return;
    const result = await rediscoverProjectViewRoster(ctx.params.viewId);
    sendJson(ctx.res, result.ok ? 200 : 400, result);
  });

  router.post("/api/workbench/logout", (ctx) => {
    destroySession(ctx.req);
    clearSessionCookie(ctx.res);
    sendJson(ctx.res, 200, { ok: true, redirectTo: "/login" });
  });
}
