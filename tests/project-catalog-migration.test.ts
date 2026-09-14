import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  migrateUnifiedProjectCatalog,
  type ProjectCatalogMigrationSpec,
} from "../src/projects/catalog-migration";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT, role TEXT, active INTEGER, is_external INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT, normalized_name TEXT UNIQUE, owner_user_id INTEGER,
      source TEXT, active INTEGER, status TEXT, updated_at TEXT
    );
    CREATE TABLE project_members (project_id INTEGER, user_id INTEGER, PRIMARY KEY (project_id, user_id));
    CREATE TABLE project_aliases (
      normalized_alias TEXT PRIMARY KEY, alias TEXT, project_id INTEGER
    );
    CREATE TABLE log_items (
      id INTEGER PRIMARY KEY, aff TEXT, scope_type TEXT, project_id INTEGER, project_name_snapshot TEXT
    );
    CREATE TABLE project_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, actor_user_id INTEGER, action TEXT,
      before_json TEXT, after_json TEXT, created_at TEXT
    );
    INSERT INTO users VALUES
      (1, '示例管理员', 'admin', 1, 0),
      (2, '胡文华', 'emp', 1, 0),
      (3, '周毓凡', 'emp', 1, 0),
      (4, '闫思源', 'emp', 1, 0);
    INSERT INTO projects VALUES
      (48, 'OCT', 'oct', NULL, 'dingtalk', 1, 'in_progress', ''),
      (52, 'AFD', 'afd', 4, 'user', 1, 'in_progress', '');
    INSERT INTO project_members VALUES (52, 4);
    INSERT INTO project_aliases VALUES ('p80', '2303-IV-OCT-P80 Classic A', 48);
    INSERT INTO log_items VALUES (1, '48', 'project', 48, 'OCT');
  `);
  return db;
}

const specs: ProjectCatalogMigrationSpec[] = [
  {
    projectId: 48,
    name: "OCT",
    ownerName: "胡文华",
    memberNames: ["胡文华", "周毓凡"],
    formalizeDingtalkProject: true,
  },
  { projectId: 52, name: "AFD", ownerName: "闫思源", memberNames: ["闫思源", "周毓凡"] },
];

test("历史项目原地正式化并保留项目编号、别名和日报引用", () => {
  const db = database();
  const dryRun = migrateUnifiedProjectCatalog("示例管理员", db, false, specs);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.projects.filter((project) => project.changed).length, 2);
  assert.equal((db.prepare("SELECT source FROM projects WHERE id = 48").get() as { source: string }).source, "dingtalk");

  const applied = migrateUnifiedProjectCatalog("示例管理员", db, true, specs);
  assert.equal(applied.applied, true);
  assert.deepEqual(
    db.prepare("SELECT id, source, owner_user_id FROM projects ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: 48, source: "user", owner_user_id: 2 },
      { id: 52, source: "user", owner_user_id: 4 },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT project_id, user_id FROM project_members ORDER BY project_id, user_id").all().map((row) => ({ ...row })),
    [
      { project_id: 48, user_id: 2 },
      { project_id: 48, user_id: 3 },
      { project_id: 52, user_id: 3 },
      { project_id: 52, user_id: 4 },
    ],
  );
  assert.equal((db.prepare("SELECT project_id FROM project_aliases WHERE normalized_alias = 'p80'").get() as { project_id: number }).project_id, 48);
  assert.deepEqual({ ...db.prepare("SELECT aff, scope_type, project_id, project_name_snapshot FROM log_items").get() }, {
    aff: "48",
    scope_type: "project",
    project_id: 48,
    project_name_snapshot: "OCT",
  });
});

test("迁移可重复执行且不会产生重复审计", () => {
  const db = database();
  migrateUnifiedProjectCatalog("示例管理员", db, true, specs);
  const firstAuditCount = (db.prepare("SELECT COUNT(*) AS count FROM project_audit_log").get() as { count: number }).count;
  const second = migrateUnifiedProjectCatalog("示例管理员", db, true, specs);
  const secondAuditCount = (db.prepare("SELECT COUNT(*) AS count FROM project_audit_log").get() as { count: number }).count;
  assert.equal(firstAuditCount, 2);
  assert.equal(secondAuditCount, firstAuditCount);
  assert.equal(second.projects.some((project) => project.changed), false);
});

test("既有正式项目可保留仍启用的本地项目账号", () => {
  const db = database();
  db.exec(`
    INSERT INTO users VALUES (5, '强轩轩', 'emp', 1, 1);
    INSERT INTO projects VALUES (2, '水锤项目', '水锤项目', 5, 'configured', 1, 'in_progress', '');
    INSERT INTO project_members VALUES (2, 5);
  `);
  migrateUnifiedProjectCatalog("示例管理员", db, true, [
    { projectId: 2, name: "水锤项目", ownerName: "强轩轩", memberNames: ["强轩轩", "周毓凡"] },
  ]);
  assert.deepEqual(
    db.prepare("SELECT user_id FROM project_members WHERE project_id = 2 ORDER BY user_id").all().map((row) => Number(row.user_id)),
    [3, 5],
  );
});
