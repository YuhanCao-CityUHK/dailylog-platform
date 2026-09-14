/** 中科微光 · 工作日志平台（dailylog）主服务。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer } from "node:http";
import { CONFIG, ensureDirs, validateConfig } from "./infra/config";
import { logStructured } from "./infra/logger";
import { getDb } from "./infra/db";
import { Router, sendHtml, sendJson, sendText, type Ctx } from "./infra/http";
import { resolveSession } from "./auth/session";
import { registerAuthRoutes } from "./auth/routes";
import { registerFillRoutes } from "./platform/routes-fill";
import { registerViewRoutes } from "./platform/routes-views";
import { registerQaRoutes } from "./platform/routes-qa";
import { registerAdminRoutes } from "./platform/routes-admin";
import { registerDailyReportRoutes } from "./web/routes-daily-reports";
import { registerDwsRoutes } from "./dws/routes";
import { registerProjectRoutes } from "./projects/routes";
import { registerAssistantRoutes } from "./assistant/routes";
import { startAssistantContextMaintenance } from "./assistant/runtime";
import { registerManagerRoutes } from "./manager/routes";
import { registerVivoFlowRoutes } from "./vivoflow/routes";
import { startDailyAssistantAutomation } from "./assistant/automation-service";
import { ensureConfiguredDefaultProjects, seedCategoriesIfEmpty } from "./platform/store";
import { seedFinanceProjectCodes } from "./platform/finance-project-codes";
import { startReminderScheduler } from "./platform/reminder";
import { createDailyReportProjectViewPrewarmScheduler } from "./digest/daily-report-project-view-prewarm";
import { createRdDepartmentDigestScheduler } from "./digest/rd-department-digest-scheduler";
import {
  projectCatalogRulesFromViews,
  reconcileGeneratedProjectCatalog,
  seedProjectCatalogAliases,
} from "./platform/project-catalog";
import { loadDailyReportDigestConfig } from "./digest/daily-report-config";
import { listProjectViewsFromConfig } from "./digest/daily-report-project-views";

const PUBLIC_DIR = path.resolve(process.cwd(), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(ctx: Ctx, rel: string): boolean {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  ctx.res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": rel === "index.html" || rel === "login.html" ? "no-store" : "public, max-age=300",
  });
  ctx.res.end(fs.readFileSync(file));
  return true;
}

async function main(): Promise<void> {
  ensureDirs();
  getDb();
  seedCategoriesIfEmpty();
  const defaultProjects = ensureConfiguredDefaultProjects(process.env.DEFAULT_PROJECT_ASSIGNMENTS ?? "");
  seedProjectCatalogAliases();
  const digestConfigResult = loadDailyReportDigestConfig();
  if (digestConfigResult.errors.length === 0) {
    const catalogMigration = reconcileGeneratedProjectCatalog(
      projectCatalogRulesFromViews(listProjectViewsFromConfig(digestConfigResult.config.orgs)),
    );
    if (catalogMigration.merged > 0 || catalogMigration.hidden > 0) {
      logStructured({ evt: "project_catalog_reconciled", ...catalogMigration });
    }
  } else {
    logStructured({
      evt: "project_catalog_reconcile_skipped",
      errorCount: digestConfigResult.errors.length,
    });
  }
  // 项目目录在数据库迁移之后才可能补齐；此处再次幂等同步财务项目编码。
  seedFinanceProjectCodes(getDb());
  if (defaultProjects.configured > 0 || defaultProjects.missingUsers.length > 0) {
    logStructured({
      evt: "default_projects_configured",
      configured: defaultProjects.configured,
      missingUsers: defaultProjects.missingUsers,
    });
  }
  const problems = validateConfig();
  for (const p of problems) logStructured({ evt: "config_warning", problem: p });

  const router = new Router();
  registerAuthRoutes(router);
  registerFillRoutes(router);
  registerViewRoutes(router);
  registerQaRoutes(router);
  registerAdminRoutes(router);
  registerDailyReportRoutes(router);
  registerDwsRoutes(router);
  registerProjectRoutes(router);
  registerAssistantRoutes(router);
  registerManagerRoutes(router);
  registerVivoFlowRoutes(router);

  router.get("/healthz", (ctx) => sendJson(ctx.res, 200, { status: "ok" }));
  router.get("/readyz", (ctx) => {
    try {
      getDb().prepare("SELECT 1").get();
      sendJson(ctx.res, 200, { status: "ready" });
    } catch {
      sendJson(ctx.res, 503, { status: "not-ready" });
    }
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const ctx: Ctx = { req, res, url, params: {} };
    try {
      ctx.user = resolveSession(req) ?? undefined;
      const matched = router.match(req.method ?? "GET", url.pathname);
      if (matched) {
        ctx.params = matched.params;
        await matched.handler(ctx);
        return;
      }
      if (req.method === "GET") {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          if (!ctx.user) {
            res.writeHead(302, { Location: "/login" });
            res.end();
            return;
          }
          if (serveStatic(ctx, "index.html")) return;
        }
        if (url.pathname === "/login") {
          if (serveStatic(ctx, "login.html")) return;
        }
        const rel = url.pathname.replace(/^\/+/, "");
        if (rel && serveStatic(ctx, rel)) return;
        /** SPA 兜底：已登录回主页，未登录去登录页 */
        if (!url.pathname.startsWith("/api/")) {
          res.writeHead(302, { Location: ctx.user ? "/" : "/login" });
          res.end();
          return;
        }
      }
      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { ok: false, error: "接口不存在" });
        return;
      }
      sendText(res, 404, "Not Found");
    } catch (err) {
      logStructured({ evt: "request_error", path: url.pathname, error: String(err) });
      if (!res.headersSent) {
        if (url.pathname.startsWith("/api/")) {
          sendJson(res, 500, { ok: false, error: "服务器内部错误，请稍后重试" });
        } else {
          sendHtml(res, 500, "<p>服务器内部错误</p>");
        }
      } else {
        res.end();
      }
    }
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    logStructured({ evt: "server_started", host: CONFIG.host, port: CONFIG.port });
  });

  startReminderScheduler();
  startAssistantContextMaintenance();
  startDailyAssistantAutomation();

  /** 日报汇总清晨预热（照搬模块原有能力）：每工作日 06:45 提前拉取并缓存当天日报，
      保证早上打开日报汇总页秒开（与原任务工作台「缓存 06:49」的体验一致）。启动时也补热一次。 */
  try {
    const prewarm = createDailyReportProjectViewPrewarmScheduler();
    void prewarm.bootstrapOnStartup();
    prewarm.startIntervalLoop();
    logStructured({ evt: "daily_report_prewarm_wired" });
  } catch (err) {
    logStructured({ evt: "daily_report_prewarm_wire_failed", error: String(err) });
  }

  try {
    const rdDigest = createRdDepartmentDigestScheduler();
    rdDigest.start();
    logStructured({ evt: "rd_department_digest_wired" });
  } catch (err) {
    logStructured({ evt: "rd_department_digest_wire_failed", error: String(err) });
  }
}

void main();
