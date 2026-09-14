/** DWS 用户接口：检查当前免登用户，并为其发起独立的首次授权。 */
import { audit } from "../infra/db";
import { CONFIG } from "../infra/config";
import { sendJson, type Ctx, type Router } from "../infra/http";
import { canUseDwsAssistant, type SessionUser } from "../auth/types";
import { inspectDwsConnection, parseDwsJson, runDwsForUser } from "./client";
import { collectDwsContextPreview } from "./context-preview";
import { clearDwsAuthorization, getDwsAuthorization, startDwsAuthorization } from "./device-auth";

function dwsInput(user: { id: number; ddUserid?: string }) {
  return {
    platformUserId: user.id,
    corpId: CONFIG.dingtalk.corpId,
    ddUserid: String(user.ddUserid ?? ""),
  };
}

function requireDwsUser(ctx: Ctx): SessionUser | null {
  if (!ctx.user) {
    sendJson(ctx.res, 401, { ok: false, error: "未登录" });
    return null;
  }
  if (!canUseDwsAssistant(ctx.user)) {
    sendJson(ctx.res, 403, { ok: false, error: "日报助手仅向钉钉员工账号开放" });
    return null;
  }
  return ctx.user;
}

export function registerDwsRoutes(router: Router): void {
  router.get("/api/dws/status", async (ctx) => {
    const user = requireDwsUser(ctx);
    if (!user) return;
    const status = await inspectDwsConnection(dwsInput(user));
    if (status.connected) clearDwsAuthorization(user.id);
    sendJson(ctx.res, 200, {
      ok: true,
      ...status,
      authorization: status.connected ? undefined : getDwsAuthorization(user.id),
    });
  });

  router.post("/api/dws/auth/start", async (ctx) => {
    const user = requireDwsUser(ctx);
    if (!user) return;
    if (!CONFIG.dws.enabled) {
      sendJson(ctx.res, 503, { ok: false, error: "DWS 未启用" });
      return;
    }
    const status = await inspectDwsConnection(dwsInput(user));
    if (status.connected) {
      clearDwsAuthorization(user.id);
      sendJson(ctx.res, 200, { ok: true, ...status });
      return;
    }
    try {
      const authorization = await startDwsAuthorization(user.id);
      audit(user.id, "dws.auth.start", authorization.state);
      sendJson(ctx.res, authorization.state === "error" ? 503 : 202, {
        ok: authorization.state !== "error",
        authorization,
        error: authorization.error,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : "无法启动 DWS 授权";
      audit(user.id, "dws.auth.start_failed", error);
      sendJson(ctx.res, 503, { ok: false, error });
    }
  });

  router.get("/api/dws/self", async (ctx) => {
    const user = requireDwsUser(ctx);
    if (!user) return;
    const status = await inspectDwsConnection(dwsInput(user));
    if (!status.connected || !status.identity) {
      sendJson(ctx.res, 409, { ok: false, ...status });
      return;
    }
    sendJson(ctx.res, 200, {
      ok: true,
      profile: status.profile,
      identity: status.identity,
    });
  });

  router.get("/api/dws/context-preview", async (ctx) => {
    const user = requireDwsUser(ctx);
    if (!user) return;
    const status = await inspectDwsConnection(dwsInput(user));
    if (!status.connected || !status.profile) {
      sendJson(ctx.res, 409, { ok: false, error: status.error || "请先连接 DWS", state: status.state });
      return;
    }
    const preview = await collectDwsContextPreview(
      status.profile,
      (args) => runDwsForUser(user.id, args).then(parseDwsJson),
    );
    const counts = Object.fromEntries(
      Object.entries(preview.sources).map(([key, source]) => [key, { status: source.status, count: source.items.length }]),
    );
    audit(user.id, "dws.context.preview", JSON.stringify(counts));
    sendJson(ctx.res, 200, { ok: true, ...preview });
  });
}
