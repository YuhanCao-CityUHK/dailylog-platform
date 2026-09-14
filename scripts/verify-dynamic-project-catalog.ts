import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CATALOG_OTHERS_VIEW_ID,
  catalogProjectViewId,
  partitionReportEntryByCostProject,
} from "../src/digest/daily-report-day-partition";
import type { ReportEntry } from "../src/digest/dingtalk-report-client";
import { collectUnifiedDayPartition } from "../src/digest/daily-report-unified-day-collect";
import {
  ensureProjectAliasTable,
  projectCatalogRulesFromViews,
  reconcileGeneratedProjectCatalog,
  resolveCostProjectForCatalog,
  seedProjectCatalogAliases,
} from "../src/platform/project-catalog";

const db = new DatabaseSync(":memory:");
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    owner_user_id INTEGER,
    descr TEXT DEFAULT '',
    source TEXT NOT NULL DEFAULT 'user',
    active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE log_items (id INTEGER PRIMARY KEY, aff TEXT NOT NULL);
  CREATE TABLE project_members (
    project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE user_default_projects (
    user_id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL
  );
  CREATE TABLE follows (
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, target_id)
  );
`);
ensureProjectAliasTable(db);
db.prepare("INSERT INTO projects (name, source) VALUES (?, 'configured')").run("水锤项目");
db.prepare("INSERT INTO projects (name, source) VALUES (?, 'external')").run("伤口荧光项目");
seedProjectCatalogAliases(db);

const viewRules = projectCatalogRulesFromViews([
  { label: "CLA", filters: { keyword: "CLA" } },
  { label: "OCT", filters: { keyword: "OCT" } },
  { label: "斑块减容", filters: { keyword: "斑块减容" } },
  { label: "静脉腔闭合系统", filters: { costProjectContains: "静脉腔内闭合系统" } },
  { label: "其他", filters: { role: "others" } },
]);

const waterProject = resolveCostProjectForCatalog("水锤", viewRules, db);
assert.ok(waterProject);
assert.equal(waterProject.name, "水锤项目", "后台别名应归入标准水锤项目");

const claProject = resolveCostProjectForCatalog(
  "2105-CLA-2105-冷激光斑块消融系统（CLA-355）",
  viewRules,
  db,
);
assert.equal(claProject?.name, "CLA", "详细 CLA 成本项目应归并到 CLA");

const plaqueProject = resolveCostProjectForCatalog(
  "Y047-CLA旋转减容（大血管斑块减容方案）",
  viewRules,
  db,
);
assert.equal(plaqueProject?.name, "斑块减容", "同时命中多个规则时应采用更具体的名称");

const woundProject = resolveCostProjectForCatalog(
  "VL2602-伤口自发荧光成像设备-LumeaVision",
  viewRules,
  db,
);
assert.equal(woundProject?.name, "伤口荧光项目", "伤口荧光成本项目应归入平台同名项目");

assert.equal(
  resolveCostProjectForCatalog("1801-PVF-投影红外血管成像仪", viewRules, db),
  null,
  "无法识别的成本编码不得占用主侧栏",
);

const discovered = resolveCostProjectForCatalog("新型光学项目", viewRules, db);
assert.equal(discovered?.name, "新型光学项目", "普通的新项目名称仍应自动建立入口");

const entry = {
  reportId: "dynamic-project-report",
  creatorUserId: "internal-user",
  creatorName: "内部员工",
  templateName: "研发中心日志",
  createTime: Date.now(),
  contents: [
    { key: "工作模块①", value: "水锤试验" },
    { key: "成本归属项目①", value: "水锤" },
    { key: "事项-结果①", value: "完成压力测试" },
    { key: "工作模块②", value: "CLA 转产" },
    { key: "成本归属项目②", value: "2105-CLA-2105-冷激光斑块消融系统（CLA-355）" },
    { key: "事项-结果②", value: "完成文档核对" },
    { key: "工作模块③", value: "PVF 运维" },
    { key: "成本归属项目③", value: "1801-PVF-投影红外血管成像仪" },
    { key: "事项-结果③", value: "完成现场支持" },
    { key: "工作模块④", value: "临时协助" },
    { key: "成本归属项目④", value: "" },
    { key: "事项-结果④", value: "完成临时任务" },
  ],
} satisfies ReportEntry;

const resolver = (rawName: string) => resolveCostProjectForCatalog(rawName, viewRules, db);
const partitioned = partitionReportEntryByCostProject(entry, resolver);
assert.deepEqual(
  partitioned.get(catalogProjectViewId(waterProject.id))?.[0]?.contents.map((field) => field.key),
  ["工作模块①", "成本归属项目①", "事项-结果①"],
  "水锤别名工作块应完整进入标准水锤项目",
);
assert.deepEqual(
  partitioned.get(catalogProjectViewId(claProject!.id))?.[0]?.contents.map((field) => field.key),
  ["工作模块②", "成本归属项目②", "事项-结果②"],
  "详细成本项目归并后仍须保留原始字段",
);
assert.deepEqual(
  partitioned.get(CATALOG_OTHERS_VIEW_ID)?.[0]?.contents.map((field) => field.key),
  ["工作模块③", "成本归属项目③", "事项-结果③", "工作模块④", "事项-结果④"],
  "空值与无法识别的成本编码应进入其他",
);

db.prepare("INSERT INTO projects (name, source) VALUES (?, 'dingtalk')").run(
  "2303-IVOCT主机-2303-Cornaris P80 Classic A",
);
const rawOct = db
  .prepare("SELECT id FROM projects WHERE name = ?")
  .get("2303-IVOCT主机-2303-Cornaris P80 Classic A") as { id: number };
db.prepare(
  "INSERT INTO project_aliases (normalized_alias, alias, project_id) VALUES (?, ?, ?)",
).run("2303-ivoct主机-2303-cornaris p80 classic a", "2303-IVOCT主机-2303-Cornaris P80 Classic A", rawOct.id);
db.prepare("INSERT INTO log_items (id, aff) VALUES (1, ?)").run(String(rawOct.id));

db.prepare("INSERT INTO projects (name, source) VALUES (?, 'dingtalk')").run(
  "Y057-预研-脑机机器人",
);
const unknown = db
  .prepare("SELECT id FROM projects WHERE name = ?")
  .get("Y057-预研-脑机机器人") as { id: number };
db.prepare(
  "INSERT INTO project_aliases (normalized_alias, alias, project_id) VALUES (?, ?, ?)",
).run("y057-预研-脑机机器人", "Y057-预研-脑机机器人", unknown.id);

const migration = reconcileGeneratedProjectCatalog(viewRules, db);
const octProject = resolveCostProjectForCatalog(
  "2303-IVOCT主机-2303-Cornaris P80 Classic A",
  viewRules,
  db,
);
assert.equal(octProject?.name, "OCT", "旧的 OCT 原始入口应归并到业务项目");
assert.equal(
  (db.prepare("SELECT aff FROM log_items WHERE id = 1").get() as { aff: string }).aff,
  String(octProject?.id),
  "旧入口若已有平台日志，引用必须迁移到业务项目",
);
assert.equal(
  (db.prepare("SELECT active FROM projects WHERE id = ?").get(unknown.id) as { active: number }).active,
  0,
  "未使用且无法识别的成本明细入口应停用",
);
assert.ok(migration.merged >= 1 && migration.hidden >= 1);
const repeatedMigration = reconcileGeneratedProjectCatalog(viewRules, db);
assert.equal(repeatedMigration.merged, 0, "重复启动不得再次迁移已归并项目");
assert.equal(repeatedMigration.hidden, 0, "重复启动不得再次停用项目");

const collected = await collectUnifiedDayPartition({
  org: {
    label: "测试组织",
    appKey: "test-key",
    appSecret: "test-secret",
    employees: [],
  },
  range: {
    labelYmd: "2026-08-17",
    labelDisplay: "2026年08月17日",
    startTime: 0,
    endTime: 1,
  },
  projectViews: [],
  reportClient: {
    getAccessToken: async () => "test-token",
    fetchUserReports: async () => [entry],
  },
  scanContacts: [{ userid: "internal-user", name: "内部员工" }],
  resolveCostProject: resolver,
});
assert.equal(
  collected.byViewId.get(catalogProjectViewId(waterProject.id))?.submitted.length,
  1,
  "没有固定 projectViews 时也必须按成本归属项目汇总内部日报",
);
assert.equal(
  collected.byViewId.get(CATALOG_OTHERS_VIEW_ID)?.submitted.length,
  1,
  "无法识别的成本项目必须保留在其他中",
);

db.close();
console.log("动态项目目录校验通过：业务项目归并、成本明细隐藏、引用迁移和其他兜底正常。");
