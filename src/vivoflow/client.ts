import { createHash, randomBytes, randomUUID } from "node:crypto";
import { VivoStore } from "./store";
import { entityId, VivoError, type VivoProject, type VivoProgress, type VivoTask } from "./types";

type Json = Record<string, unknown>;
export interface Connection { id: string; clientId: string; accessToken: string; refreshToken: string; expiresAt: number; connectedAt: string; tokenEndpoint: string; }
interface Pending { state: string; verifier: string; session: string; expiresAt: number; clientId: string; tokenEndpoint: string; callback?: { code: string; denied: boolean }; }
export interface VivoConfig { origin: string; callback: string; timeoutMs?: number; }
const token = () => randomBytes(32).toString("base64url");
export const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

export function trustedOrigin(value: string, allowLoopback = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new VivoError("configuration", "VivoFlow 地址须使用 HTTPS", 503);
  }
  return url.origin;
}

export class VivoClient {
  private readonly refreshes = new Map<number, Promise<Connection>>();
  private readonly initialized = new Map<string, Promise<string>>();
  constructor(readonly store: VivoStore, readonly config: VivoConfig, private readonly fetcher: typeof fetch = fetch) {}
  private endpoint(value: unknown): string {
    if (typeof value !== "string" || new URL(value).origin !== this.config.origin || new URL(value).username || new URL(value).password) throw new VivoError("untrusted_endpoint", "VivoFlow 授权服务地址不匹配");
    return value;
  }
  async request(url: string, init: RequestInit = {}): Promise<Json> {
    let response: Response;
    try { response = await this.fetcher(this.endpoint(url), { ...init, redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs ?? 15000) }); }
    catch { throw new VivoError("unavailable", "VivoFlow 暂时无法连接，请稍后重试"); }
    if (!response.ok) {
      if (response.status === 401) throw new VivoError("authorization_expired", "VivoFlow 授权已失效，请重新连接", 401);
      if (response.status === 403) throw new VivoError("remote_forbidden", "当前 VivoFlow 账号无权查看该内容", 403);
      throw new VivoError("unavailable", `VivoFlow 读取失败（${response.status}），请稍后重试`);
    }
    if (response.status === 202 || response.status === 204) return {};
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("empty");
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new Error("oversize"); }
        chunks.push(chunk.value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const messages = text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")).filter(Boolean).map((data) => JSON.parse(data) as Json);
        const result = messages.find((m) => m.id != null && (m.result != null || m.error != null));
        if (!result) throw new Error("missing_response");
        return result;
      }
      const body = JSON.parse(text) as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
      return body as Json;
    } catch { throw new VivoError("invalid_response", "VivoFlow 返回的数据不完整，请重新读取"); }
  }
  connection(userId: number): Connection | null { return this.store.get<Connection>(userId, "connection"); }
  async begin(userId: number, session: string): Promise<string> {
    const metadata = await this.request(`${this.config.origin}/.well-known/oauth-authorization-server`);
    if (metadata.issuer !== this.config.origin) throw new VivoError("issuer_mismatch", "VivoFlow 授权签发方不匹配");
    const register = this.endpoint(metadata.registration_endpoint), authorize = this.endpoint(metadata.authorization_endpoint), endpoint = this.endpoint(metadata.token_endpoint);
    const client = await this.request(register, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "工作日志平台 · 主管任务汇总", redirect_uris: [this.config.callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    if (typeof client.client_id !== "string") throw new VivoError("invalid_client", "VivoFlow 客户端注册失败");
    const pending: Pending = { state: `${userId}.${token()}`, verifier: token(), session: hash(session), expiresAt: Date.now() + 10 * 60_000, clientId: client.client_id, tokenEndpoint: endpoint };
    this.store.put(userId, "pending", pending);
    const url = new URL(authorize);
    url.search = new URLSearchParams({ client_id: pending.clientId, redirect_uri: this.config.callback, response_type: "code", code_challenge: hash(pending.verifier), code_challenge_method: "S256", state: pending.state, resource: `${this.config.origin}/api/mcp` }).toString();
    return url.toString();
  }
  // VivoFlow 现有客户端用跨站 iframe 回调，此时没有平台 cookie。
  // 只暂存一次性授权码；交换令牌仍由原平台登录会话完成。
  receiveCallback(state: string, code: string, denied: boolean): void {
    const match = /^(\d+)\.[A-Za-z0-9_-]{43}$/.exec(state);
    const userId = match ? Number(match[1]) : 0;
    const pending = Number.isSafeInteger(userId) && userId > 0 ? this.store.get<Pending>(userId, "pending") : null;
    if (!pending || pending.expiresAt < Date.now() || pending.state !== state || (!denied && !code) || code.length > 4096) throw new VivoError("invalid_state", "连接请求已失效，请回项目页重新连接", 400);
    if (pending.callback) {
      if (pending.callback.code === code && pending.callback.denied === denied) return;
      throw new VivoError("invalid_state", "连接回调不匹配，请重新连接", 400);
    }
    this.store.put(userId, "pending", { ...pending, callback: { code, denied } });
  }
  async complete(userId: number, session: string): Promise<boolean> {
    const pending = this.store.get<Pending>(userId, "pending");
    if (!pending || pending.expiresAt < Date.now() || pending.session !== hash(session)) throw new VivoError("invalid_state", "连接请求已失效，请回项目页重新连接", 400);
    if (!pending.callback) return false;
    if (pending.callback.denied) {
      this.store.remove(userId, "pending");
      throw new VivoError("denied", "本次连接已取消，可以重新连接", 400);
    }
    await this.finish(userId, session, pending.state, pending.callback.code);
    return true;
  }
  async finish(userId: number, session: string, state: string, code: string): Promise<void> {
    const pending = this.store.get<Pending>(userId, "pending");
    if (!pending || pending.expiresAt < Date.now() || pending.session !== hash(session) || pending.state !== state || !code || code.length > 4096) {
      throw new VivoError("invalid_state", "连接请求已失效，请回项目页重新连接", 400);
    }
    this.store.remove(userId, "pending");
    const result = await this.exchange(pending.tokenEndpoint, { grant_type: "authorization_code", client_id: pending.clientId, redirect_uri: this.config.callback, code, code_verifier: pending.verifier, resource: `${this.config.origin}/api/mcp` });
    const connection = this.parseTokens(result, { id: randomUUID(), clientId: pending.clientId, tokenEndpoint: pending.tokenEndpoint, connectedAt: new Date().toISOString() });
    // 验证真实远端读取，不能以 JWT 解码或本地记录替代授权成功。
    await this.toolWithToken(connection.accessToken, "list_projects", { limit: 1 });
    this.store.remove(userId);
    this.store.put(userId, "connection", connection);
  }
  private async exchange(url: string, params: Record<string, string>): Promise<Json> {
    return this.request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  }
  private parseTokens(result: Json, info: Pick<Connection, "id" | "clientId" | "connectedAt" | "tokenEndpoint">): Connection {
    if (typeof result.access_token !== "string" || typeof result.refresh_token !== "string" || String(result.token_type).toLowerCase() !== "bearer" || !(Number(result.expires_in) > 0)) throw new VivoError("invalid_token", "VivoFlow 未返回有效授权，请重新连接", 401);
    return { ...info, accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: Date.now() + Number(result.expires_in) * 1000 };
  }
  private async access(userId: number): Promise<Connection> {
    const connection = this.connection(userId);
    if (!connection) throw new VivoError("not_connected", "请先连接自己的 VivoFlow 账号", 401);
    if (connection.expiresAt > Date.now() + 60_000) return connection;
    const existing = this.refreshes.get(userId); if (existing) return existing;
    const pending = (async () => {
      let result: Json;
      try { result = await this.exchange(connection.tokenEndpoint, { grant_type: "refresh_token", client_id: connection.clientId, refresh_token: connection.refreshToken, resource: `${this.config.origin}/api/mcp` }); }
      catch {
        // 刷新令牌为一次性轮换；失败结果不确定时禁止自动重复使用。
        if (this.connection(userId)?.id === connection.id) this.store.remove(userId);
        throw new VivoError("authorization_expired", "VivoFlow 授权需要重新连接", 401);
      }
      const next = this.parseTokens(result, connection);
      if (this.connection(userId)?.id !== connection.id) throw new VivoError("connection_changed", "连接已更改，请重新读取", 409);
      this.store.put(userId, "connection", next); return next;
    })().finally(() => this.refreshes.delete(userId));
    this.refreshes.set(userId, pending); return pending;
  }
  async tool(userId: number, name: string, args: Json): Promise<Json> {
    const connection = await this.access(userId);
    try { return await this.toolWithToken(connection.accessToken, name, args); }
    catch (error) {
      if (error instanceof VivoError && error.code === "authorization_expired" && this.connection(userId)?.id === connection.id) this.store.remove(userId);
      throw error;
    }
  }
  private async toolWithToken(accessToken: string, name: string, args: Json): Promise<Json> {
    const allowed = new Set(["list_projects", "get_project", "get_project_task_tree", "get_task_progress"]);
    if (!allowed.has(name)) throw new VivoError("tool_forbidden", "不支持该操作", 400);
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${accessToken}`, "MCP-Protocol-Version": "2025-06-18" };
    const key = hash(accessToken);
    let initialized = this.initialized.get(key);
    if (!initialized) {
      initialized = (async () => {
        const start = await this.request(`${this.config.origin}/api/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dailylog-manager", version: "1.0.0" } } }) });
        const version = (start.result as Json | undefined)?.protocolVersion;
        if (start.error || typeof version !== "string" || !["2025-03-26", "2025-06-18", "2025-11-25"].includes(version)) throw new VivoError("protocol_error", "VivoFlow 连接协议初始化失败");
        await this.request(`${this.config.origin}/api/mcp`, { method: "POST", headers: { ...headers, "MCP-Protocol-Version": version }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
        return version;
      })().catch((error: unknown) => { this.initialized.delete(key); throw error; });
      if (this.initialized.size > 200) this.initialized.clear();
      this.initialized.set(key, initialized);
    }
    headers["MCP-Protocol-Version"] = await initialized;
    const result = await this.request(`${this.config.origin}/api/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } }) });
    const payload = result.result as Json | undefined;
    if (result.error || !payload || payload.isError) throw new VivoError("remote_read_failed", "VivoFlow 内容不可读取，可能已删除或无查看权限", 403);
    if (payload.structuredContent && typeof payload.structuredContent === "object") return payload.structuredContent as Json;
    try {
      const content = payload.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content.find((c) => c.type === "text")?.text ?? "") as Json;
    } catch { throw new VivoError("invalid_response", "VivoFlow 未返回有效任务数据"); }
  }
  async pages<T>(userId: number, name: string, args: Json, field: string, maxPages = 100): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = []; const seen = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.tool(userId, name, { ...args, ...(cursor ? { cursor } : {}), limit: 100 });
      if (!Array.isArray(result[field])) throw new VivoError("invalid_response", "VivoFlow 返回的列表格式不正确");
      items.push(...result[field] as T[]);
      if (result.nextCursor == null) return { items, complete: true };
      const next = entityId(result.nextCursor);
      if (seen.has(next)) throw new VivoError("pagination_loop", "VivoFlow 分页重复，未能读取完整数据");
      seen.add(next); cursor = next;
    }
    return { items, complete: false };
  }
  async projects(userId: number): Promise<VivoProject[]> {
    const page = await this.pages<VivoProject>(userId, "list_projects", {}, "projects");
    if (!page.complete) throw new VivoError("catalog_incomplete", "项目目录未读取完整，请稍后重试");
    return page.items.map((p) => ({ id: entityId(p.id), name: String(p.name), status: String(p.status), productLine: typeof p.productLine === "string" ? p.productLine : null }));
  }
  tasks(userId: number, projectId: string) { return this.pages<VivoTask>(userId, "get_project_task_tree", { projectId }, "nodes"); }
  progress(userId: number, taskId: string) { return this.pages<VivoProgress>(userId, "get_task_progress", { taskId }, "progress"); }
}
