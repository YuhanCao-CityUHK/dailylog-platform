import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "../src/infra/config";
import { getDb } from "../src/infra/db";
import { listAppliedMigrations } from "../src/infra/migrations";

const root = process.cwd();
const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const deployDir = path.join(root, "deploy");
const rollbackScriptPath = [
  path.join(deployDir, "deploy-daily-assistant-full-pilot.sh"),
  path.join(deployDir, "deploy-daily-assistant-pilot.sh"),
].find((candidate) => fs.existsSync(candidate));
if (!rollbackScriptPath) throw new Error("未找到日报助手回滚脚本");
const rollbackScript = fs.readFileSync(rollbackScriptPath, "utf8");
const defaultOff = [
  "DAILY_ASSISTANT_ENABLED=0",
  "DAILY_ASSISTANT_CONVERSATION_ENABLED=0",
  "DAILY_ASSISTANT_SUBMIT_ENABLED=0",
  "DAILY_ASSISTANT_MANAGER_OVERVIEW_ENABLED=0",
  "DAILY_ASSISTANT_PREWARM_ENABLED=0",
  "DAILY_ASSISTANT_REMINDER_ENABLED=0",
].every((line) => example.includes(line));
if (!defaultOff) throw new Error(".env.example 中的新助手开关必须全部默认关闭");

const contextPath = path.resolve(root, CONFIG.assistant.contextDbPath);
const platformPath = path.resolve(root, CONFIG.dataDir, "platform.sqlite");
if (contextPath === platformPath) throw new Error("临时上下文库必须与正式主库分离");
if (/assistant-context\.sqlite[^\n]*(?:BACKUP_DIR|backup)/i.test(rollbackScript)) {
  throw new Error("回滚备份不得包含 12 小时临时上下文库");
}
const preservesPlatformDb = /platform\.sqlite[^\n]*BACKUP_DIR/i.test(rollbackScript) ||
  (/for name in platform\.sqlite/.test(rollbackScript) && /BACKUP_DIR\/\$name/.test(rollbackScript));
if (!preservesPlatformDb) {
  throw new Error("回滚脚本必须保留正式 platform.sqlite 备份");
}

const migrations = listAppliedMigrations(getDb());
if (!migrations.some((migration) => migration.version === 7)) throw new Error("本地主库尚未执行助手版本 7 迁移");

console.log(JSON.stringify({
  ok: true,
  defaultOff,
  latestMigration: migrations.at(-1)?.version,
  separateContextDatabase: true,
  contextExcludedFromRollbackBackup: true,
}, null, 2));
