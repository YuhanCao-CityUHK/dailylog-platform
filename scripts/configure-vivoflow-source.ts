/** 服务器管理员的一次性只读接入配置；不提供公开 HTTP 管理入口。 */
import { randomBytes } from "node:crypto";
import { CONFIG } from "../src/infra/config";
import { getDb } from "../src/infra/db";
import { VivoClient, trustedOrigin } from "../src/vivoflow/client";
import { VivoStore } from "../src/vivoflow/store";

const [action, rawId] = process.argv.slice(2);
const userId = Number(rawId);
if (!["begin", "complete", "status"].includes(action) || !Number.isSafeInteger(userId) || userId < 1) throw new Error("Usage: configure-vivoflow-source.ts begin|complete|status PLATFORM_USER_ID");
const db = getDb();
const source = db.prepare("SELECT id,name,active,is_external FROM users WHERE id=?").get(userId) as { id: number; name: string; active: number; is_external: number } | undefined;
if (!source?.active || source.is_external) throw new Error("Source must be an active internal platform user");
const origin = trustedOrigin(process.env.VIVOFLOW_BASE_URL || "https://flow.vivolight.cn", CONFIG.devMode);
const store = new VivoStore(db, origin, process.env.VIVOFLOW_ENCRYPTION_KEY || CONFIG.sessionSecret);
const client = new VivoClient(store, { origin, callback: `${trustedOrigin(CONFIG.publicBaseUrl, CONFIG.devMode)}/api/vivoflow/callback` });
if (action === "begin") {
  const session = randomBytes(32).toString("base64url");
  const url = await client.begin(userId, session);
  store.put(userId, "provisioning", { session });
  console.log(JSON.stringify({ source: source.name, url }));
} else if (action === "complete") {
  const provisioning = store.get<{ session: string }>(userId, "provisioning");
  if (!provisioning) throw new Error("No pending provisioning request");
  const connected = await client.complete(userId, provisioning.session);
  console.log(JSON.stringify({ source: source.name, connected }));
  if (!connected) process.exitCode = 2;
} else {
  console.log(JSON.stringify({ source: source.name, connected: Boolean(client.connection(userId)) }));
}
db.close();
