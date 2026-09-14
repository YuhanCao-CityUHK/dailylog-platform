import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { CONFIG } from "../src/infra/config";
import { Router, type Ctx } from "../src/infra/http";
import { registerVivoFlowRoutes } from "../src/vivoflow/routes";
import { fixture } from "./vivoflow-fixture";
import { VivoService } from "../src/vivoflow/service";

test("HTTP 路由验证登录、来源、项目权限，真实保存关联并轮询汇总结果", async () => {
  const f = fixture(), router = new Router(); registerVivoFlowRoutes(router, f.service);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost"); const match = router.match(req.method || "GET", url.pathname);
    if (!match) { res.writeHead(404); res.end(); return; }
    const ctx: Ctx = { req, res, url, params: match.params, user: req.headers["x-test-user"] === "admin" ? f.admin : req.headers["x-test-user"] === "other" ? f.other : undefined };
    await match.handler(ctx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number }, base = `http://127.0.0.1:${addr.port}`;
  const path = `/api/vivoflow/projects/${f.project.id}`;
  const headers = { "x-test-user": "admin", "Content-Type": "application/json", Origin: new URL(CONFIG.publicBaseUrl).origin };
  try {
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + path, { headers: { "x-test-user": "other" } })).status, 403);
    assert.equal((await fetch(base + path + "/links", { method: "PUT", headers: { ...headers, Origin: "https://evil.example" }, body: JSON.stringify({ sourceIds: ["101"] }) })).status, 403);
    const save = await fetch(base + path + "/links", { method: "PUT", headers, body: JSON.stringify({ sourceIds: ["101"] }) });
    assert.equal(save.status, 200);
    assert.equal(f.store.links(f.project.id)[0].method, "manual");
    const first = await fetch(base + path + "?date=2026-09-08", { headers }).then((r) => r.json());
    assert.equal(first.syncing, true);
    await f.service.waitForIdle();
    const loaded = await fetch(base + path + "?date=2026-09-08", { headers }).then((r) => r.json());
    assert.equal(loaded.snapshot.tasks.length, 2);
    assert.equal(loaded.snapshot.tasks[0].progress[0].text, "完成首轮测试");
    assert.equal(JSON.stringify(loaded).includes("fixture-initial-access"), false);
    assert.equal((await fetch(base + path + "?date=2026-13-01", { headers })).status, 400);
    const disconnect = await fetch(base + "/api/vivoflow/disconnect", { method: "POST", headers, body: "{}" });
    assert.equal(disconnect.status, 200);
    const state = await fetch(base + path, { headers }).then((r) => r.json());
    assert.equal(state.connected, false);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM vivoflow_private").get()!.n, 0);
    const sessionHeaders = { ...headers, Cookie: "dailylog_sid=original-session" };
    const begin = await fetch(base + "/api/vivoflow/connect", { method: "POST", headers: sessionHeaders, body: "{}" }).then((r) => r.json());
    const oauthState = new URL(begin.url).searchParams.get("state")!;
    const callback = await fetch(base + "/api/vivoflow/callback?" + new URLSearchParams({ state: oauthState, code: "code" }));
    assert.equal(callback.status, 200);
    assert.equal(f.remote.tokenCount, 0);
    assert.equal((await fetch(base + "/api/vivoflow/complete", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(base + "/api/vivoflow/complete", { method: "POST", headers: { ...sessionHeaders, Origin: "https://evil.example" }, body: "{}" })).status, 403);
    const complete = await fetch(base + "/api/vivoflow/complete", { method: "POST", headers: sessionHeaders, body: "{}" }).then((r) => r.json());
    assert.equal(complete.connected, true);
  } finally {
    await f.service.waitForIdle(); await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); f.db.close();
  }
});

test("统一数据源不允许普通页面重新授权或断开后台连接", async () => {
  const f = fixture(), router = new Router();
  registerVivoFlowRoutes(router, new VivoService(f.client, f.admin.id));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const match = router.match(req.method || "GET", url.pathname)!;
    await match.handler({ req, res, url, params: match.params, user: f.admin });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const operation of ["connect", "disconnect", "complete"]) {
      const response = await fetch(base + "/api/vivoflow/" + operation, { method: "POST", headers: { Origin: new URL(CONFIG.publicBaseUrl).origin }, body: "{}" });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).shared, true);
    }
    assert.ok(f.client.connection(f.admin.id));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.db.close(); }
});
