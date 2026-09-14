import { CONFIG } from "../infra/config";
import { getDb } from "../infra/db";
import { escHtml, parseCookies, readJson, sendHtml, sendJson, type Ctx, type Router } from "../infra/http";
import { canCreateFormalProject, canManageProject } from "../projects/permissions";
import { VivoClient, trustedOrigin } from "./client";
import { VivoService } from "./service";
import { VivoStore } from "./store";
import { beijingDate, entityId, VivoError } from "./types";

export function registerVivoFlowRoutes(router: Router, supplied?: VivoService): void {
  let instance = supplied;
  const runtime = () => {
    if (!instance) {
      const origin = trustedOrigin(process.env.VIVOFLOW_BASE_URL || "https://flow.vivolight.cn", CONFIG.devMode);
      const publicOrigin = trustedOrigin(CONFIG.publicBaseUrl, CONFIG.devMode);
      const sharedId = process.env.VIVOFLOW_SHARED_USER_ID ? Number(process.env.VIVOFLOW_SHARED_USER_ID) : undefined;
      if (sharedId !== undefined && (!Number.isSafeInteger(sharedId) || sharedId < 1)) throw new VivoError("configuration", "研发任务统一数据源配置无效", 503);
      instance = new VivoService(new VivoClient(new VivoStore(getDb(), origin, process.env.VIVOFLOW_ENCRYPTION_KEY || CONFIG.sessionSecret), { origin, callback: `${publicOrigin}/api/vivoflow/callback` }), sharedId);
    }
    return instance;
  };
  const user = (ctx: Ctx) => {
    if (!ctx.user) throw new VivoError("unauthenticated", "请先登录工作日志平台", 401);
    if (ctx.user.isExternal) throw new VivoError("forbidden", "该功能面向内部主管及项目负责人", 403);
    return ctx.user;
  };
  const writable = (ctx: Ctx) => {
    const origin = ctx.req.headers.origin;
    if (ctx.req.headers["sec-fetch-site"] === "cross-site" || !origin || origin !== new URL(CONFIG.publicBaseUrl).origin) throw new VivoError("invalid_origin", "请求来源不匹配，请刷新页面后操作", 403);
  };
  const projectId = (ctx: Ctx) => {
    const value = Number(ctx.params.id);
    if (!Number.isSafeInteger(value) || value < 1) throw new VivoError("invalid_project", "项目编号无效", 400);
    return value;
  };
  const wrap = (fn: (ctx: Ctx, service: VivoService) => Promise<unknown>) => async (ctx: Ctx) => {
    try { user(ctx); sendJson(ctx.res, 200, { ok: true, shared: Boolean(runtime().sharedUserId), ...await fn(ctx, runtime()) as object }); }
    catch (error) { sendJson(ctx.res, error instanceof VivoError ? error.status : 500, { ok: false, shared: Boolean(instance?.sharedUserId), code: error instanceof VivoError ? error.code : "internal", error: error instanceof VivoError ? error.message : "研发任务读取失败，请稍后重试" }); }
  };
  const personalOnly = (service: VivoService) => { if (service.sharedUserId) throw new VivoError("managed_connection", "研发任务由后台统一接入，无需个人连接或断开", 403); };
  router.get("/api/vivoflow/status", wrap(async (ctx, service) => ({ connected: Boolean(service.client.connection(service.sourceUserId(user(ctx)))) })));
  router.get("/api/vivoflow/launch", (ctx) => {
    sendHtml(ctx.res, 200, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接 VivoFlow</title><p>正在打开授权页面，请稍候。</p></html>');
  });
  router.post("/api/vivoflow/connect", wrap(async (ctx, service) => {
    writable(ctx); personalOnly(service); const current = user(ctx);
    if (!canCreateFormalProject(current, service.client.store.db)) throw new VivoError("forbidden", "该功能面向内部主管及项目负责人", 403);
    return { url: await service.client.begin(current.id, sessionBinding(ctx)) };
  }));
  router.post("/api/vivoflow/disconnect", wrap(async (ctx, service) => {
    writable(ctx); personalOnly(service); service.client.store.remove(user(ctx).id); return { connected: false };
  }));
  router.post("/api/vivoflow/complete", wrap(async (ctx, service) => {
    writable(ctx); personalOnly(service);
    return { connected: await service.client.complete(user(ctx).id, sessionBinding(ctx)) };
  }));
  router.get("/api/vivoflow/callback", async (ctx) => {
    try {
      runtime().client.receiveCallback(ctx.url.searchParams.get("state") || "", ctx.url.searchParams.get("code") || "", ctx.url.searchParams.has("error"));
      ctx.res.setHeader("Referrer-Policy", "no-referrer");
      sendHtml(ctx.res, 200, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>VivoFlow 授权回执</title><p>已收到授权回执，请返回原来的项目工作台完成连接。</p></html>');
    } catch (error) {
      ctx.res.setHeader("Referrer-Policy", "no-referrer");
      sendHtml(ctx.res, error instanceof VivoError ? error.status : 500, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>连接 VivoFlow</title><body><main><h1>连接尚未完成</h1><p>${escHtml(error instanceof VivoError ? error.message : "连接失败，请返回项目页重试")}</p><a href="/?vivoflow=return#project">返回项目工作台</a></main></body></html>`);
    }
  });
  router.get("/api/vivoflow/projects/:id", wrap(async (ctx, service) => service.view(user(ctx), projectId(ctx), ctx.url.searchParams.get("date") || beijingDate())));
  router.post("/api/vivoflow/projects/:id/refresh", wrap(async (ctx, service) => {
    writable(ctx); const body = await readJson<{ date?: string }>(ctx.req);
    return service.view(user(ctx), projectId(ctx), body.date || beijingDate(), true);
  }));
  router.get("/api/vivoflow/projects/:id/links", wrap(async (ctx, service) => {
    const current = user(ctx), id = projectId(ctx); service.client.store.requireView(current, id);
    if (!canManageProject(current, id, service.client.store.db)) throw new VivoError("manage_forbidden", "无权调整项目关联", 403);
    const catalog = await service.catalog(current);
    return { ...catalog, links: service.client.store.links(id), assignments: service.client.store.assignments(current, catalog.projects) };
  }));
  router.put("/api/vivoflow/projects/:id/links", wrap(async (ctx, service) => {
    writable(ctx); const body = await readJson<{ sourceIds?: unknown }>(ctx.req);
    if (!Array.isArray(body.sourceIds)) throw new VivoError("invalid_links", "请选择关联项目", 400);
    return { links: await service.updateLinks(user(ctx), projectId(ctx), body.sourceIds.map(entityId)) };
  }));
}

function sessionBinding(ctx: Ctx): string {
  const session = parseCookies(ctx.req).dailylog_sid;
  if (!session) throw new VivoError("unauthenticated", "登录已失效，请重新登录平台", 401);
  return session;
}
