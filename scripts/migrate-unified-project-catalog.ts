import { getDb } from "../src/infra/db";
import { migrateUnifiedProjectCatalog } from "../src/projects/catalog-migration";

const apply = process.argv.includes("--apply");
const actorName = process.env.DAILYLOG_MIGRATION_ACTOR?.trim() || "示例管理员";
const result = migrateUnifiedProjectCatalog(actorName, getDb(), apply);

console.log(JSON.stringify({ ok: true, mode: apply ? "apply" : "dry-run", ...result }, null, 2));
if (!apply) console.log("Dry-run only. Re-run with --apply after backing up platform.sqlite.");
