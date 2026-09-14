import { getDb } from "../src/infra/db";
import { migrateUnifiedProjectCatalog, UNIFIED_PROJECT_CATALOG } from "../src/projects/catalog-migration";

const db = getDb();
const result = migrateUnifiedProjectCatalog("示例管理员", db, false);
const pending = result.projects.filter((project) => project.changed);
if (pending.length > 0) {
  throw new Error(`项目目录仍有未应用变更：${pending.map((project) => `${project.id}-${project.name}`).join("、")}`);
}

const ids = UNIFIED_PROJECT_CATALOG.map((project) => project.projectId);
const placeholders = ids.map(() => "?").join(",");
const formalCount = (
  db
    .prepare(`SELECT COUNT(*) AS count FROM projects WHERE id IN (${placeholders}) AND source <> 'dingtalk' AND active = 1`)
    .get(...(ids as never[])) as { count: number }
).count;
if (formalCount !== ids.length) throw new Error(`正式项目数量异常：${formalCount}/${ids.length}`);

const brokenItems = (
  db
    .prepare(
      `SELECT COUNT(*) AS count FROM log_items
        WHERE project_id IN (${placeholders})
          AND (scope_type <> 'project' OR aff <> CAST(project_id AS TEXT) OR project_name_snapshot IS NULL)`,
    )
    .get(...(ids as never[])) as { count: number }
).count;
if (brokenItems !== 0) throw new Error(`发现 ${brokenItems} 条项目日报引用不一致`);

const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
if (integrity.integrity_check !== "ok") throw new Error(`SQLite 完整性检查失败：${integrity.integrity_check}`);

console.log(JSON.stringify({ ok: true, projects: result.projects, brokenItems, integrity: integrity.integrity_check }, null, 2));
