/** 真实 VivoFlow 联调：平台使用隔离数据，仅监听本机；通过浏览器正常授权。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

if (process.env.NODE_ENV === "production") throw new Error("Preview is local only");
const dataDir = path.resolve("data/vivoflow-live-preview");
fs.mkdirSync(dataDir, { recursive: true });
const keyFile = path.join(dataDir, ".encryption-key");
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
Object.assign(process.env, {
  DEV_MODE: "1", HOST: "127.0.0.1", PORT: "8147", PUBLIC_BASE_URL: "http://127.0.0.1:8147",
  DATA_DIR: dataDir, UPLOADS_DIR: path.join(dataDir, "uploads"),
  SESSION_SECRET: fs.readFileSync(keyFile, "utf8"), VIVOFLOW_BASE_URL: "https://flow.vivolight.cn",
  DAILY_ASSISTANT_ENABLED: "0", DAILY_ASSISTANT_PREWARM_ENABLED: "0", DAILY_ASSISTANT_REMINDER_ENABLED: "0",
  REMINDER_ENABLED: "0", DAILY_REPORT_RD_DIGEST_ENABLED: "0", DWS_ENABLED: "0",
  DINGTALK_CLIENT_ID: "", DINGTALK_CLIENT_SECRET: "", LLM_API_KEY: "", DASHSCOPE_API_KEY: "", QWEN_API_KEY: "",
});
const { getDb } = await import("../src/infra/db");
const { hashPassword } = await import("../src/auth/password");
const db = getDb();
const found = db.prepare("SELECT id FROM users WHERE login_name='vivo-live-preview'").get() as { id: number } | undefined;
const userId = found?.id ?? Number(db.prepare("INSERT INTO users (kind,login_name,name,dept,role,is_external,must_change_pw,should_submit) VALUES ('local','vivo-live-preview','本机联调主管','研发部','admin',0,0,0)").run().lastInsertRowid);
const password = randomBytes(12).toString("base64url");
db.prepare("INSERT INTO local_credentials (user_id,password_hash) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,failed_attempts=0,locked_until=NULL").run(userId, hashPassword(password));
const catalogPath = path.join(dataDir, "catalog.json");
if (fs.existsSync(catalogPath)) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { projects: Array<{ id: number; name: string }>; aliases: Array<{ project_id: number; alias: string }> };
  for (const p of catalog.projects) db.prepare("INSERT INTO projects (id,name,source,status,owner_user_id) VALUES (?,?,'platform','active',?) ON CONFLICT(id) DO NOTHING").run(p.id, p.name, userId);
  for (const a of catalog.aliases) if (catalog.projects.some((p) => p.id === a.project_id)) db.prepare("INSERT OR IGNORE INTO project_aliases (project_id,alias) VALUES (?,?)").run(a.project_id, a.alias);
}
console.log(JSON.stringify({ preview: "http://127.0.0.1:8147", login: "vivo-live-preview", password, notice: "LOCAL PLATFORM / REAL VIVOFLOW, no production writes" }));
await import("../src/server");
