import assert from "node:assert/strict";
import test from "node:test";
import { hash, trustedOrigin, type Connection } from "../src/vivoflow/client";
import { VivoError } from "../src/vivoflow/types";
import { fixture } from "./vivoflow-fixture";

test("OAuth 使用 PKCE 和会话绑定，错误账号/会话/重放不能交换授权码，凭证加密", async () => {
  const f = fixture();
  try {
    f.store.remove(f.admin.id);
    const url = new URL(await f.client.begin(f.admin.id, "local-session"));
    const pending = f.store.get<{ verifier: string }>(f.admin.id, "pending")!;
    assert.equal(url.searchParams.get("code_challenge"), hash(pending.verifier));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("resource")!, /\/api\/mcp$/);
    const state = url.searchParams.get("state")!;
    await assert.rejects(f.client.finish(f.admin.id, "different-session", state, "code"), (e: unknown) => e instanceof VivoError && e.code === "invalid_state");
    await assert.rejects(f.client.finish(f.other.id, "local-session", state, "code"), VivoError);
    assert.equal(f.remote.tokenCount, 0);
    await f.client.finish(f.admin.id, "local-session", state, "code");
    assert.equal(f.remote.tokenCount, 1);
    await assert.rejects(f.client.finish(f.admin.id, "local-session", state, "code"), VivoError);
    const raw = JSON.stringify(f.db.prepare("SELECT * FROM vivoflow_private").all());
    assert.equal(raw.includes("fixture-access"), false);
    assert.equal(raw.includes("fixture-refresh"), false);
    assert.ok(f.remote.calls.some((c) => c.method === "initialize"));
    assert.ok(f.remote.calls.some((c) => c.method === "notifications/initialized"));
    assert.ok(f.remote.calls.some((c) => c.name === "list_projects"));
  } finally { f.db.close(); }
});

test("令牌即将过期时并发请求只刷新一次；失败不重用一次性刷新令牌", async () => {
  const f = fixture();
  try {
    f.store.put(f.admin.id, "connection", { ...f.connection, expiresAt: Date.now() });
    await Promise.all(Array.from({ length: 6 }, () => f.client.projects(f.admin.id)));
    assert.equal(f.remote.refreshCount, 1);
    const next = f.store.get<Connection>(f.admin.id, "connection")!;
    assert.match(next.refreshToken, /fixture-refresh-1/);
    f.store.put(f.admin.id, "connection", { ...next, expiresAt: Date.now() }); f.remote.failRefresh = true;
    await assert.rejects(f.client.projects(f.admin.id), (e: unknown) => e instanceof VivoError && e.code === "authorization_expired");
    assert.equal(f.client.connection(f.admin.id), null);
    await assert.rejects(f.client.projects(f.admin.id), VivoError);
    assert.equal(f.remote.refreshCount, 2);
  } finally { f.db.close(); }
});

test("无 cookie 的 iframe 回调只暂存，原账号原会话才能完成，拒绝篡改重放过期", async () => {
  const f = fixture();
  try {
    f.store.remove(f.admin.id);
    const state = new URL(await f.client.begin(f.admin.id, "original-session")).searchParams.get("state")!;
    assert.equal(await f.client.complete(f.admin.id, "original-session"), false);
    assert.throws(() => f.client.receiveCallback(state + "x", "secret-code", false), VivoError);
    f.client.receiveCallback(state, "secret-code", false);
    f.client.receiveCallback(state, "secret-code", false);
    assert.throws(() => f.client.receiveCallback(state, "different-code", false), VivoError);
    assert.equal(f.remote.tokenCount, 0);
    assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM vivoflow_private").all()).includes("secret-code"), false);
    await assert.rejects(f.client.complete(f.other.id, "original-session"), VivoError);
    await assert.rejects(f.client.complete(f.admin.id, "other-session"), VivoError);
    assert.equal(await f.client.complete(f.admin.id, "original-session"), true);
    assert.equal(f.remote.tokenCount, 1);
    assert.throws(() => f.client.receiveCallback(state, "secret-code", false), VivoError);
    const denied = new URL(await f.client.begin(f.admin.id, "original-session")).searchParams.get("state")!;
    f.client.receiveCallback(denied, "", true);
    await assert.rejects(f.client.complete(f.admin.id, "original-session"), (e: unknown) => e instanceof VivoError && e.code === "denied");
    assert.equal(f.remote.tokenCount, 1);
    const expired = new URL(await f.client.begin(f.admin.id, "original-session")).searchParams.get("state")!;
    f.store.put(f.admin.id, "pending", { ...f.store.get<object>(f.admin.id, "pending"), expiresAt: 0 });
    assert.throws(() => f.client.receiveCallback(expired, "code", false), VivoError);
  } finally { f.db.close(); }
});

test("外部地址必须 HTTPS，同源授权端点，不能借来源数据向第三方发送 token", async () => {
  const f = fixture();
  try {
    assert.throws(() => trustedOrigin("http://untrusted.example"), VivoError);
    assert.throws(() => trustedOrigin("https://user:password@vivoflow.example"), VivoError);
    assert.equal(trustedOrigin("http://127.0.0.1:8123", true), "http://127.0.0.1:8123");
    await assert.rejects(f.client.request("https://other.example/token"), VivoError);
    assert.equal(f.remote.calls.length, 0);
  } finally { f.db.close(); }
});
