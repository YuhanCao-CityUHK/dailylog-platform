import { canUseDwsAssistant } from "../auth/types";
import { capabilitiesForUser } from "../auth/capabilities";
import { getDb } from "../infra/db";
import { sendJson, type Router } from "../infra/http";
import { lastCompleteWorkday, todayYmd } from "../infra/workcal";
import { buildManagerOverview } from "./overview-service";
import { CONFIG } from "../infra/config";
import { assistantFeatureEnabled } from "../assistant/features";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerManagerRoutes(router: Router): void {
  router.get("/api/manager/overview", (ctx) => {
    if (!ctx.user) {
      sendJson(ctx.res, 401, { ok: false, error: "未登录" });
      return;
    }
    if (!capabilitiesForUser(ctx.user, getDb()).supervisor) {
      sendJson(ctx.res, 403, { ok: false, error: "无权查看主管首页" });
      return;
    }
    if (!canUseDwsAssistant(ctx.user) || !assistantFeatureEnabled("manager", CONFIG.assistant)) {
      sendJson(ctx.res, 404, { ok: false, error: "新版主管首页尚未开启", code: "feature_disabled" });
      return;
    }
    const requested = String(ctx.url.searchParams.get("date") ?? "").trim();
    const date = requested || lastCompleteWorkday();
    if (!YMD_RE.test(date) || date > todayYmd()) {
      sendJson(ctx.res, 400, { ok: false, error: "请选择今天或历史日期" });
      return;
    }
    const overview = buildManagerOverview(ctx.user, date, getDb());
    sendJson(ctx.res, 200, { ok: true, ...overview });
  });
}
