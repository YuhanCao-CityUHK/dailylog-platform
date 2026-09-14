import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../infra/db";

export interface CanonicalProject {
  id: number;
  name: string;
}

export interface ProjectCatalogRule {
  canonical: string;
  contains: string[];
}

type ProjectViewLike = {
  label: string;
  filters: {
    role?: string;
    keyword?: string;
    costProjectContains?: string;
  };
};

const BUILT_IN_RULES: ProjectCatalogRule[] = [
  { canonical: "水锤项目", contains: ["水锤"] },
  {
    canonical: "伤口荧光项目",
    contains: ["伤口自发荧光", "伤口荧光", "LumeaVision"],
  },
];

const COST_ACCOUNTING_NAME_RE = /^(?:\d{4}\S*|[a-z]{1,8}\d{2,}|[a-z]{2,8})-/i;

export function normalizeProjectAlias(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
}

export function projectCatalogRulesFromViews(views: ProjectViewLike[]): ProjectCatalogRule[] {
  return views
    .filter((view) => view.filters.role !== "others")
    .map((view) => ({
      canonical: view.label.trim(),
      contains: [view.filters.costProjectContains, view.filters.keyword]
        .map((value) => value?.trim() ?? "")
        .filter(Boolean),
    }))
    .filter((rule) => rule.canonical && rule.contains.length > 0);
}

export function isDetailedCostProjectName(value: string): boolean {
  return COST_ACCOUNTING_NAME_RE.test(value.trim());
}

export function ensureProjectAliasTable(db: DatabaseSync = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_aliases (
      normalized_alias TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_project_aliases_project ON project_aliases(project_id);
  `);
}

export function putProjectAlias(
  alias: string,
  projectId: number,
  db: DatabaseSync = getDb(),
): void {
  const clean = alias.trim();
  const normalized = normalizeProjectAlias(clean);
  if (!normalized || !projectId) return;
  ensureProjectAliasTable(db);
  db.prepare(
    `INSERT INTO project_aliases (normalized_alias, alias, project_id)
     VALUES (?, ?, ?)
     ON CONFLICT(normalized_alias) DO UPDATE SET
       alias = excluded.alias,
       project_id = excluded.project_id`,
  ).run(normalized, clean, projectId);
}

function listProjects(db: DatabaseSync, activeOnly: boolean): CanonicalProject[] {
  const where = activeOnly ? " WHERE active = 1" : "";
  return db
    .prepare(`SELECT id, name FROM projects${where} ORDER BY id`)
    .all() as unknown as CanonicalProject[];
}

function findProjectByNormalizedName(
  normalized: string,
  db: DatabaseSync,
  activeOnly = true,
): CanonicalProject | undefined {
  return listProjects(db, activeOnly).find(
    (row) => normalizeProjectAlias(row.name) === normalized,
  );
}

function findActiveAlias(normalized: string, db: DatabaseSync): CanonicalProject | undefined {
  return db
    .prepare(
      `SELECT p.id, p.name
       FROM project_aliases a
       JOIN projects p ON p.id = a.project_id
       WHERE a.normalized_alias = ? AND p.active = 1`,
    )
    .get(normalized) as CanonicalProject | undefined;
}

function allCatalogRules(rules: ProjectCatalogRule[]): ProjectCatalogRule[] {
  return [...rules, ...BUILT_IN_RULES];
}

function tokenMatchesProjectName(rawName: string, token: string): boolean {
  const cleanToken = token.trim();
  if (!cleanToken) return false;
  if (/^[A-Z]{2,}$/.test(cleanToken)) {
    if (rawName.includes(cleanToken)) return true;
    const escaped = cleanToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z])${escaped}(?=$|[^a-z])`, "i").test(rawName);
  }
  return normalizeProjectAlias(rawName).includes(normalizeProjectAlias(cleanToken));
}

function matchingCatalogRule(
  rawName: string,
  rules: ProjectCatalogRule[],
): ProjectCatalogRule | undefined {
  return allCatalogRules(rules)
    .flatMap((rule) =>
      rule.contains.map((token) => ({
        rule,
        token: token.trim(),
      })),
    )
    .filter((candidate) => tokenMatchesProjectName(rawName, candidate.token))
    .sort((a, b) => b.token.length - a.token.length)[0]?.rule;
}

function ensureCanonicalProject(name: string, db: DatabaseSync): CanonicalProject {
  const normalized = normalizeProjectAlias(name);
  const existing = findProjectByNormalizedName(normalized, db, false);
  if (existing) {
    db.prepare("UPDATE projects SET active = 1 WHERE id = ?").run(existing.id);
    putProjectAlias(existing.name, existing.id, db);
    return existing;
  }

  db.prepare(
    "INSERT INTO projects (name, owner_user_id, source, created_by) VALUES (?, NULL, 'dingtalk', NULL)",
  ).run(name.trim());
  const created = db
    .prepare("SELECT id, name FROM projects WHERE name = ?")
    .get(name.trim()) as unknown as CanonicalProject;
  putProjectAlias(created.name, created.id, db);
  return created;
}

/**
 * 钉钉成本项目先按后台规则归并为业务项目。带成本编码的未识别明细不进入主侧栏；
 * 普通的新项目名称仍自动建立入口。
 */
export function resolveCostProjectForCatalog(
  rawName: string,
  rules: ProjectCatalogRule[] = [],
  db: DatabaseSync = getDb(),
): CanonicalProject | null {
  const name = rawName.trim();
  const normalized = normalizeProjectAlias(name);
  if (!normalized) return null;
  ensureProjectAliasTable(db);

  const aliased = findActiveAlias(normalized, db);
  if (aliased) return aliased;

  const existing = findProjectByNormalizedName(normalized, db);
  if (existing) {
    putProjectAlias(name, existing.id, db);
    return existing;
  }

  const matchedRule = matchingCatalogRule(name, rules);
  if (matchedRule) {
    const canonical = ensureCanonicalProject(matchedRule.canonical, db);
    putProjectAlias(name, canonical.id, db);
    return canonical;
  }

  if (isDetailedCostProjectName(name)) return null;

  return ensureCanonicalProject(name, db);
}

function projectHasPlatformReferences(projectId: number, db: DatabaseSync): boolean {
  const counts = [
    db.prepare("SELECT COUNT(*) AS n FROM log_items WHERE aff = ?").get(String(projectId)),
    db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?").get(projectId),
    db.prepare("SELECT COUNT(*) AS n FROM user_default_projects WHERE project_id = ?").get(projectId),
    db.prepare("SELECT COUNT(*) AS n FROM follows WHERE kind = 'p' AND target_id = ?").get(projectId),
  ] as Array<{ n: number }>;
  return counts.some((row) => Number(row.n) > 0);
}

function mergeProjectReferences(fromId: number, toId: number, db: DatabaseSync): void {
  db.prepare("UPDATE log_items SET aff = ? WHERE aff = ?").run(String(toId), String(fromId));
  db.prepare(
    `INSERT OR IGNORE INTO project_members (project_id, user_id)
     SELECT ?, user_id FROM project_members WHERE project_id = ?`,
  ).run(toId, fromId);
  db.prepare("DELETE FROM project_members WHERE project_id = ?").run(fromId);
  db.prepare("UPDATE user_default_projects SET project_id = ? WHERE project_id = ?").run(toId, fromId);
  db.prepare(
    `INSERT OR IGNORE INTO follows (user_id, kind, target_id)
     SELECT user_id, kind, ? FROM follows WHERE kind = 'p' AND target_id = ?`,
  ).run(toId, fromId);
  db.prepare("DELETE FROM follows WHERE kind = 'p' AND target_id = ?").run(fromId);
}

export interface ProjectCatalogReconcileResult {
  merged: number;
  hidden: number;
  kept: number;
}

/** 将旧版误提升为侧栏入口的钉钉成本明细归并或停用，原始日报缓存不删除。 */
export function reconcileGeneratedProjectCatalog(
  rules: ProjectCatalogRule[] = [],
  db: DatabaseSync = getDb(),
): ProjectCatalogReconcileResult {
  ensureProjectAliasTable(db);
  const generated = db
    .prepare("SELECT id, name FROM projects WHERE active = 1 AND source = 'dingtalk' ORDER BY id")
    .all() as unknown as CanonicalProject[];
  const result: ProjectCatalogReconcileResult = { merged: 0, hidden: 0, kept: 0 };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const project of generated) {
      const matchedRule = matchingCatalogRule(project.name, rules);
      if (matchedRule) {
        const canonical = ensureCanonicalProject(matchedRule.canonical, db);
        if (canonical.id === project.id) {
          result.kept += 1;
          continue;
        }
        mergeProjectReferences(project.id, canonical.id, db);
        db.prepare("UPDATE project_aliases SET project_id = ? WHERE project_id = ?").run(
          canonical.id,
          project.id,
        );
        putProjectAlias(project.name, canonical.id, db);
        db.prepare("UPDATE projects SET active = 0 WHERE id = ?").run(project.id);
        result.merged += 1;
        continue;
      }

      if (isDetailedCostProjectName(project.name) && !projectHasPlatformReferences(project.id, db)) {
        db.prepare("DELETE FROM project_aliases WHERE project_id = ?").run(project.id);
        db.prepare("UPDATE projects SET active = 0 WHERE id = ?").run(project.id);
        result.hidden += 1;
      } else {
        result.kept += 1;
      }
    }
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 启动时只补后台别名；不创建不存在的标准项目。 */
export function seedProjectCatalogAliases(db: DatabaseSync = getDb()): void {
  ensureProjectAliasTable(db);
  const projects = listProjects(db, true);
  for (const project of projects) putProjectAlias(project.name, project.id, db);

  for (const rule of BUILT_IN_RULES) {
    const canonical = projects.find(
      (project) => normalizeProjectAlias(project.name) === normalizeProjectAlias(rule.canonical),
    );
    if (!canonical) continue;
    for (const alias of rule.contains) putProjectAlias(alias, canonical.id, db);
  }
}

export function getCanonicalProject(
  projectId: number,
  db: DatabaseSync = getDb(),
): CanonicalProject | undefined {
  if (!projectId) return undefined;
  return db
    .prepare("SELECT id, name FROM projects WHERE id = ? AND active = 1")
    .get(projectId) as CanonicalProject | undefined;
}
