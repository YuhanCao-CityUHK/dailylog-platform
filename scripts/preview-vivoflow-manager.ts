/** 本地演示与浏览器验收：隔离数据库和模拟 VivoFlow，只监听回环地址。 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

if (process.env.NODE_ENV === "production") throw new Error("Preview is local only");
const appPort = 8137, sourcePort = 8138;
const appOrigin = `http://127.0.0.1:${appPort}`, sourceOrigin = `http://127.0.0.1:${sourcePort}`;
Object.assign(process.env, {
  DEV_MODE: "1", HOST: "127.0.0.1", PORT: String(appPort), PUBLIC_BASE_URL: appOrigin,
  DATA_DIR: path.resolve("data/vivoflow-preview"), UPLOADS_DIR: path.resolve("data/vivoflow-preview/uploads"),
  SESSION_SECRET: "local-preview-only-key-never-for-production", VIVOFLOW_BASE_URL: sourceOrigin,
  DAILY_ASSISTANT_ENABLED: "0", DAILY_ASSISTANT_PREWARM_ENABLED: "0", DAILY_ASSISTANT_REMINDER_ENABLED: "0",
  REMINDER_ENABLED: "0", DAILY_REPORT_RD_DIGEST_ENABLED: "0",
  DINGTALK_CLIENT_ID: "", DINGTALK_CLIENT_SECRET: "", LLM_API_KEY: "", DASHSCOPE_API_KEY: "", QWEN_API_KEY: "",
});
const { RemoteFixture, ORIGIN, progress, task, user } = await import("../tests/vivoflow-fixture");
const remote = new RemoteFixture();
remote.projects = [
  { id: "101", name: "光学成像研发项目", status: "IN_PROGRESS" },
  { id: "102", name: "光学成像二代项目", status: "NOT_STARTED" },
  { id: "103", name: "演示设备验证", status: "PAUSED" },
];
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
remote.tasks.set("101", [
  task("1001", { name: "完成样机第一轮光学性能验证", riskFlag: "HIGH" }),
  task("1002", { name: "更新测试方案并完成内部评审", status: "DONE" }),
  task("1003", { name: "对两处成像异常进行复测与原因分析", parentTaskId: "1001", depth: 1, riskFlag: "MEDIUM" }),
  task("1004", { name: "下一版样机装配", status: "NOT_STARTED", endDate: null, assignee: null }),
  task("1005", { name: "供应商送样确认", status: "PAUSED", endDate: "2026-09-10" }),
]);
remote.tasks.set("102", [task("1010", { name: "二代成像组件方案调研", status: "NOT_STARTED", endDate: "2026-09-30" })]);
remote.logs.set("1001", [progress("2001", `${today}T02:30:00Z`, "完成首轮样机测试，已记录两处异常。下一步复测并核对光路装配情况。\n需要机械同事协助确认装配公差。")]);
remote.logs.set("1002", [progress("2002", `${today}T01:00:00Z`, "测试方案评审完成，补充了测试条件和判定标准。")]);
const source = createServer(async (req, res) => {
  const url = new URL(req.url || "/", sourceOrigin);
  if (url.pathname === "/api/oauth/authorize") {
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    if (callback.origin !== appOrigin) { res.writeHead(400); res.end(); return; }
    callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", "local-fixture-code");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font:16px sans-serif;max-width:560px;margin:80px auto;padding:20px"><h1>VivoFlow 本地模拟授权</h1><p>仅用于验证日志平台连接流程，当前内容均为演示数据。</p><a href="${callback.toString().replace(/&/g, "&amp;")}">同意连接演示账号</a></body></html>`); return;
  }
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await remote.fetch(`${ORIGIN}${url.pathname}${url.search}`, { method: req.method, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
    const body = (await response.text()).replaceAll(ORIGIN, sourceOrigin);
    res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(body);
  } catch { res.writeHead(500); res.end("{}"); }
});
await new Promise<void>((resolve) => source.listen(sourcePort, "127.0.0.1", resolve));

const { getDb } = await import("../src/infra/db");
const { hashPassword } = await import("../src/auth/password");
const db = getDb();
const found = db.prepare("SELECT id FROM users WHERE login_name='vivo-preview'").get() as { id: number } | undefined;
const userId = found?.id ?? Number(db.prepare("INSERT INTO users (kind,login_name,name,dept,role,is_external,must_change_pw,should_submit) VALUES ('local','vivo-preview','演示主管','研发部','admin',0,0,0)").run().lastInsertRowid);
const password = randomBytes(9).toString("base64url");
db.prepare("INSERT INTO local_credentials (user_id,password_hash) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash, failed_attempts=0,locked_until=NULL").run(userId, hashPassword(password));
const { createFormalProject } = await import("../src/projects/service");
if (!db.prepare("SELECT 1 FROM projects WHERE name='光学成像研发项目'").get()) createFormalProject(user(userId), { name: "光学成像研发项目" }, db);
if (!db.prepare("SELECT 1 FROM projects WHERE name='演示设备验证'").get()) createFormalProject(user(userId), { name: "演示设备验证" }, db);
console.log(JSON.stringify({ preview: appOrigin, login: "vivo-preview", password, date: today, data: "ISOLATED DEMO ONLY" }));
await import("../src/server");
