import assert from "node:assert/strict";
import test from "node:test";
import { applyPlatformMigrations, listAppliedMigrations } from "../src/infra/migrations";
import { createLegacyFixtureDb } from "./helpers";

test("增量迁移失败时当前版本完整回滚", () => {
  const db = createLegacyFixtureDb();
  db.exec("CREATE VIEW department_managers AS SELECT 1 AS department_name, 1 AS manager_user_id, '' AS synced_at");
  assert.throws(() => applyPlatformMigrations(db));
  assert.deepEqual(listAppliedMigrations(db).map((migration) => migration.version), [1]);
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as unknown as Array<{ name: string }>;
  assert.equal(projectColumns.some((column) => column.name === "normalized_name"), false);
  assert.equal(projectColumns.some((column) => column.name === "status"), false);
  db.close();
});
