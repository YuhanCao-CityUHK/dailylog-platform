import type { SessionUser } from "../src/auth/types";
import { createFormalProject } from "../src/projects/service";
import { VivoClient, type Connection } from "../src/vivoflow/client";
import { VivoService } from "../src/vivoflow/service";
import { VivoStore } from "../src/vivoflow/store";
import type { VivoProgress, VivoProject, VivoTask } from "../src/vivoflow/types";
import { addUser, createMigratedFixtureDb } from "./helpers";

export const ORIGIN = "https://vivoflow.example";
export function user(id: number, role: SessionUser["role"] = "admin"): SessionUser {
  return { id, kind: "dingtalk", ddUserid: `dd-${id}`, name: `测试主管${id}`, title: "", dept: "研发部", role, isExternal: false, mustChangePw: false };
}
export function task(id: string, overrides: Partial<VivoTask> = {}): VivoTask {
  return { id, name: `研发任务${id}`, status: "IN_PROGRESS", phase: "DEVELOPMENT", riskFlag: null, startDate: "2026-09-01", endDate: "2026-09-07", assignee: { id: "11", name: "测试工程师" }, parentTaskId: null, depth: 0, directChildCount: 0, ...overrides };
}
export function progress(id: string, createdAt: string, text: string): VivoProgress {
  return { id, createdAt, staff: { id: "11", name: "测试工程师" }, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, attachmentCount: 1 };
}
export class RemoteFixture {
  projects: VivoProject[] = [{ id: "101", name: "光学研发项目", status: "IN_PROGRESS" }];
  tasks = new Map<string, VivoTask[]>([["101", [task("1001"), task("1002", { name: "完成的父任务", status: "DONE", directChildCount: 1 })]]]);
  logs = new Map<string, VivoProgress[]>([["1001", [progress("2001", "2026-09-08T03:00:00Z", "完成首轮测试")]]]);
  calls: Array<{ method: string; name?: string; args?: Record<string, unknown> }> = [];
  refreshCount = 0; tokenCount = 0; failRefresh = false; unavailable = false; duplicateCursor = false;
  deniedTasks = new Set<string>();
  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = String(init?.body || "");
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (this.unavailable) return reply({}, 502);
    if (url.endsWith("/.well-known/oauth-authorization-server")) return reply({ issuer: ORIGIN, registration_endpoint: `${ORIGIN}/api/oauth/register`, authorization_endpoint: `${ORIGIN}/api/oauth/authorize`, token_endpoint: `${ORIGIN}/api/oauth/token` });
    if (url.endsWith("/api/oauth/register")) return reply({ client_id: "fixture-client" });
    if (url.endsWith("/api/oauth/token")) {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") { this.refreshCount++; if (this.failRefresh) return reply({ error: "invalid_grant" }, 400); }
      this.tokenCount++;
      return reply({ access_token: `fixture-access-${this.tokenCount}`, refresh_token: `fixture-refresh-${this.tokenCount}`, token_type: "Bearer", expires_in: 3600 });
    }
    const rpc = JSON.parse(body); this.calls.push({ method: rpc.method, name: rpc.params?.name, args: rpc.params?.arguments });
    if (rpc.method === "initialize") return reply({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "vivoflow", version: "1.0.0" }, capabilities: { tools: {} } } });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    const args = rpc.params.arguments, name = rpc.params.name;
    const page = <T extends { id: string }>(rows: T[], field: string) => {
      const offset = args.cursor ? rows.findIndex((r) => r.id === args.cursor) + 1 : 0;
      const items = rows.slice(offset, offset + Math.min(args.limit || 100, 2));
      const nextCursor = this.duplicateCursor ? "999" : offset + items.length < rows.length ? items.at(-1)?.id : null;
      return { [field]: items, nextCursor };
    };
    let value;
    if (name === "list_projects") value = page(this.projects, "projects");
    else if (name === "get_project_task_tree") value = page(this.tasks.get(args.projectId) || [], "nodes");
    else if (name === "get_task_progress") {
      if (this.deniedTasks.has(args.taskId)) return reply({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: "权限不足" }] } });
      value = page(this.logs.get(args.taskId) || [], "progress");
    } else throw new Error(`Unexpected tool ${name}`);
    return reply({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] } });
  }) as typeof fetch;
}
export function fixture() {
  const db = createMigratedFixtureDb();
  const admin = user(addUser(db, { name: "测试主管", role: "admin", dept: "研发部" }));
  const other = user(addUser(db, { name: "另一主管", role: "mgr", dept: "市场部" }), "mgr"); other.dept = "市场部";
  const project = createFormalProject(admin, { name: "光学研发项目" }, db);
  const store = new VivoStore(db, ORIGIN, "fixture-encryption-key-at-least-32-chars");
  const remote = new RemoteFixture();
  const client = new VivoClient(store, { origin: ORIGIN, callback: "https://dailylog.example/api/vivoflow/callback" }, remote.fetch);
  const service = new VivoService(client);
  const connection: Connection = { id: "fixture-grant", clientId: "fixture-client", accessToken: "fixture-initial-access", refreshToken: "fixture-initial-refresh", expiresAt: Date.now() + 3600_000, connectedAt: new Date().toISOString(), tokenEndpoint: `${ORIGIN}/api/oauth/token` };
  store.put(admin.id, "connection", connection);
  return { db, admin, other, project, store, remote, client, service, connection };
}
