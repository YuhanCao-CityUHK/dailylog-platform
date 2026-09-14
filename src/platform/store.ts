/** 平台数据访问层：项目、分类池、日志、草稿、关注、采纳率。 */
import { getDb, nowIso } from "../infra/db";
import { isoWeekOf } from "../infra/workcal";
import { cleanProjectName, normalizeProjectName } from "../projects/name";

export interface ProjectRow {
  id: number;
  name: string;
  owner_user_id: number | null;
  owner_name?: string;
  descr: string;
  active: number;
  status: "in_progress" | "completed";
}

export interface CategoryRow {
  id: number;
  name: string;
  use_count: number;
  risk: number;
  warm: number;
}

/** 一期初始分类池（与规格 §6.7.3 对齐；count 从 0 起真实累计）。 */
const SEED_CATEGORIES: Array<{ name: string; risk?: boolean; warm?: boolean }> = [
  { name: "实验验证" },
  { name: "参数优化" },
  { name: "交付风险", risk: true },
  { name: "跨部门协同", risk: true },
  { name: "注册申报" },
  { name: "文献调研" },
  { name: "供应商沟通", warm: true },
  { name: "算法开发" },
  { name: "样机调试" },
  { name: "问题复盘" },
];

export function seedCategoriesIfEmpty(): void {
  const db = getDb();
  const n = (db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number }).n;
  if (n > 0) return;
  const ins = db.prepare("INSERT INTO categories (name, risk, warm) VALUES (?, ?, ?)");
  for (const c of SEED_CATEGORIES) ins.run(c.name, c.risk ? 1 : 0, c.warm ? 1 : 0);
}

export function listProjects(includeCompleted = false): ProjectRow[] {
  return getDb()
    .prepare(
      `SELECT p.id, p.name, p.owner_user_id, u.name AS owner_name, p.descr, p.active, p.status
       FROM projects p LEFT JOIN users u ON u.id = p.owner_user_id
       WHERE p.active = 1 AND p.source <> 'dingtalk' AND (? = 1 OR p.status = 'in_progress')
       ORDER BY p.status, p.id`,
    )
    .all(includeCompleted ? 1 : 0) as unknown as ProjectRow[];
}

export function listCategories(): CategoryRow[] {
  return getDb()
    .prepare("SELECT id, name, use_count, risk, warm FROM categories WHERE active = 1 ORDER BY use_count DESC, id")
    .all() as unknown as CategoryRow[];
}

export interface DefaultProjectAssignmentResult {
  configured: number;
  missingUsers: string[];
}

/**
 * 为本地账号配置默认项目。配置格式：login:项目名，多个配置用逗号或分号分隔。
 * 项目只创建一份；账号首次打开空白日志或补填空白日志时自动选中该项目。
 */
export function ensureConfiguredDefaultProjects(raw: string): DefaultProjectAssignmentResult {
  const assignments = raw
    .split(/[,，;；\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const sep = part.search(/[:=]/);
      return sep > 0
        ? { loginName: part.slice(0, sep).trim().toLowerCase(), projectName: part.slice(sep + 1).trim() }
        : { loginName: "", projectName: "" };
    })
    .filter((item) => item.loginName && item.projectName);

  if (assignments.length === 0) return { configured: 0, missingUsers: [] };

  const db = getDb();
  const missingUsers: string[] = [];
  let configured = 0;
  db.exec("BEGIN");
  try {
    for (const assignment of assignments) {
      const user = db
        .prepare("SELECT id FROM users WHERE login_name = ? AND active = 1")
        .get(assignment.loginName) as { id: number } | undefined;
      if (!user) {
        missingUsers.push(assignment.loginName);
        continue;
      }

      const normalizedName = normalizeProjectName(assignment.projectName);
      let project = db
        .prepare("SELECT id, active FROM projects WHERE normalized_name = ?")
        .get(normalizedName) as { id: number; active: number } | undefined;
      if (!project) {
        db.prepare(
          `INSERT INTO projects
            (name, normalized_name, owner_user_id, status, source, created_by, updated_at)
           VALUES (?, ?, NULL, 'in_progress', 'configured', NULL, ?)`,
        ).run(cleanProjectName(assignment.projectName), normalizedName, nowIso());
        project = db
          .prepare("SELECT id, active FROM projects WHERE normalized_name = ?")
          .get(normalizedName) as { id: number; active: number };
      } else if (project.active !== 1) {
        db.prepare("UPDATE projects SET active = 1 WHERE id = ?").run(project.id);
      }

      db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)").run(
        project.id,
        user.id,
      );
      db.prepare(
        "UPDATE projects SET owner_user_id = COALESCE(owner_user_id, ?), updated_at = ? WHERE id = ?",
      ).run(user.id, nowIso(), project.id);
      db.prepare(
        `INSERT INTO user_default_projects (user_id, project_id) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET project_id = excluded.project_id`,
      ).run(user.id, project.id);
      configured += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { configured, missingUsers };
}

export function getDefaultProjectId(userId: number): number | null {
  const row = getDb()
    .prepare(
      `SELECT p.id FROM user_default_projects d
       JOIN projects p ON p.id = d.project_id
       WHERE d.user_id = ? AND p.active = 1 AND p.status = 'in_progress'`,
    )
    .get(userId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function createCategory(name: string, createdBy: number): CategoryRow {
  const db = getDb();
  const clean = name.trim();
  const existing = db
    .prepare("SELECT id, name, use_count, risk, warm FROM categories WHERE name = ?")
    .get(clean) as unknown as CategoryRow | undefined;
  if (existing) return existing;
  db.prepare("INSERT INTO categories (name, created_by) VALUES (?, ?)").run(clean, createdBy);
  return db
    .prepare("SELECT id, name, use_count, risk, warm FROM categories WHERE name = ?")
    .get(clean) as unknown as CategoryRow;
}

/** 相似判定（规格 §7.1.4 strSimilar 算法，作为生产的相似提示） */
export function strSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  for (let i = 0; i + 2 <= a.length; i += 1) {
    const sub = a.slice(i, i + 2);
    if (b.includes(sub)) return true;
  }
  return false;
}

/* ---------------- 草稿 ---------------- */

export interface DraftItem {
  text: string;
  hours: number;
  cats: Array<{ id: number; confirmed: boolean; manual?: boolean }>;
  atts: Array<{ id?: number; name: string }>;
}

export interface DraftAffiliation {
  affId: string; // 'dept' 或项目 id 字符串
  /** 项目归属对应的财务项目编码；部门日常为空。 */
  financeCodeId?: number;
  items: DraftItem[];
}

export interface DraftPayload {
  affiliations: DraftAffiliation[];
}

export function loadDraft(userId: number, date: string): DraftPayload | null {
  const row = getDb()
    .prepare("SELECT payload FROM drafts WHERE user_id = ? AND date = ?")
    .get(userId, date) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload) as DraftPayload;
    if (!Array.isArray(parsed.affiliations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft(userId: number, date: string, payload: DraftPayload): void {
  getDb()
    .prepare(
      `INSERT INTO drafts (user_id, date, payload, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    )
    .run(userId, date, JSON.stringify(payload), nowIso());
}

export function deleteDraft(userId: number, date: string): void {
  getDb().prepare("DELETE FROM drafts WHERE user_id = ? AND date = ?").run(userId, date);
}

/* ---------------- 日志 ---------------- */

export interface SubmittedItem {
  itemId: number;
  logId: number;
  userId: number;
  empName: string;
  date: string;
  aff: string; // 'dept' | 项目 id 字符串
  affName: string;
  financeCodeId?: number;
  financeCode?: string;
  financeCodeName?: string;
  text: string;
  hours: number;
  cats: Array<{ id: number; name: string; confirmed: boolean; manual: boolean }>;
  atts: Array<{ id: number; name: string }>;
  quality: string;
}

export function getLog(userId: number, date: string): { id: number; quality: string; submitted_at: string; updated_at: string } | null {
  const row = getDb()
    .prepare("SELECT id, quality, submitted_at, updated_at FROM logs WHERE user_id = ? AND date = ? AND status = 'submitted'")
    .get(userId, date) as { id: number; quality: string; submitted_at: string; updated_at: string } | undefined;
  return row ?? null;
}

/** 拉取一组日期范围内（可选按人）已提交事项（含分类与附件），供聚合与问答用。 */
export function fetchSubmittedItems(opts: {
  dates?: string[];
  userIds?: number[];
  aff?: string;
}): SubmittedItem[] {
  const db = getDb();
  const clauses: string[] = ["l.status = 'submitted'"];
  const args: unknown[] = [];
  if (opts.dates && opts.dates.length > 0) {
    clauses.push(`l.date IN (${opts.dates.map(() => "?").join(",")})`);
    args.push(...opts.dates);
  }
  if (opts.userIds && opts.userIds.length > 0) {
    clauses.push(`l.user_id IN (${opts.userIds.map(() => "?").join(",")})`);
    args.push(...opts.userIds);
  }
  if (opts.aff) {
    clauses.push("i.aff = ?");
    args.push(opts.aff);
  }
  const rows = db
    .prepare(
      `SELECT i.id AS itemId, l.id AS logId, l.user_id AS userId, u.name AS empName, l.date AS date,
              i.aff AS aff, i.text AS text, i.hours AS hours, l.quality AS quality,
              i.finance_project_code_id AS financeCodeId,
              f.code AS financeCode, f.name AS financeCodeName
       FROM log_items i
       JOIN logs l ON l.id = i.log_id
       JOIN users u ON u.id = l.user_id
       LEFT JOIN finance_project_codes f ON f.id = i.finance_project_code_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY l.date, l.user_id, i.ord`,
    )
    .all(...(args as never[])) as unknown as Array<Omit<SubmittedItem, "cats" | "atts" | "affName">>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.itemId);
  const catRows = db
    .prepare(
      `SELECT ic.item_id AS itemId, c.id AS id, c.name AS name, ic.confirmed AS confirmed, ic.manual AS manual
       FROM item_cats ic JOIN categories c ON c.id = ic.cat_id
       WHERE ic.item_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...(ids as never[])) as unknown as Array<{ itemId: number; id: number; name: string; confirmed: number; manual: number }>;
  const attRows = db
    .prepare(
      `SELECT item_id AS itemId, id, filename FROM attachments WHERE item_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...(ids as never[])) as unknown as Array<{ itemId: number; id: number; filename: string }>;
  const catMap = new Map<number, SubmittedItem["cats"]>();
  for (const c of catRows) {
    const list = catMap.get(c.itemId) ?? [];
    list.push({ id: c.id, name: c.name, confirmed: c.confirmed === 1, manual: c.manual === 1 });
    catMap.set(c.itemId, list);
  }
  const attMap = new Map<number, SubmittedItem["atts"]>();
  for (const a of attRows) {
    const list = attMap.get(a.itemId) ?? [];
    list.push({ id: a.id, name: a.filename });
    attMap.set(a.itemId, list);
  }
  const projNames = new Map<string, string>();
  for (const p of listProjects(true)) projNames.set(String(p.id), p.name);
  return rows.map((r) => ({
    ...r,
    financeCodeId: Number(r.financeCodeId) || undefined,
    affName: r.aff === "dept" ? "部门日常" : projNames.get(r.aff) ?? `项目${r.aff}`,
    cats: catMap.get(r.itemId) ?? [],
    atts: attMap.get(r.itemId) ?? [],
  }));
}

/* ---------------- 关注 ---------------- */

export function listFollows(userId: number): { projects: number[]; categories: number[] } {
  const rows = getDb()
    .prepare("SELECT kind, target_id FROM follows WHERE user_id = ?")
    .all(userId) as unknown as Array<{ kind: string; target_id: number }>;
  return {
    projects: rows.filter((r) => r.kind === "p").map((r) => r.target_id),
    categories: rows.filter((r) => r.kind === "c").map((r) => r.target_id),
  };
}

export function toggleFollow(userId: number, kind: "p" | "c", targetId: number): boolean {
  const db = getDb();
  const existing = db
    .prepare("SELECT 1 AS x FROM follows WHERE user_id = ? AND kind = ? AND target_id = ?")
    .get(userId, kind, targetId);
  if (existing) {
    db.prepare("DELETE FROM follows WHERE user_id = ? AND kind = ? AND target_id = ?").run(userId, kind, targetId);
    return false;
  }
  db.prepare("INSERT INTO follows (user_id, kind, target_id) VALUES (?, ?, ?)").run(userId, kind, targetId);
  return true;
}

/* ---------------- 采纳率 ---------------- */

export function bumpAdopt(userId: number, date: string, autoDelta: number, confirmedDelta: number): void {
  const week = isoWeekOf(date);
  getDb()
    .prepare(
      `INSERT INTO adopt_stats (user_id, week, auto_count, confirmed_count) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, week) DO UPDATE SET
         auto_count = auto_count + excluded.auto_count,
         confirmed_count = confirmed_count + excluded.confirmed_count`,
    )
    .run(userId, week, autoDelta, confirmedDelta);
}

export function getAdopt(userId: number, date: string): { auto: number; confirmed: number } {
  const week = isoWeekOf(date);
  const row = getDb()
    .prepare("SELECT auto_count, confirmed_count FROM adopt_stats WHERE user_id = ? AND week = ?")
    .get(userId, week) as { auto_count: number; confirmed_count: number } | undefined;
  return { auto: row?.auto_count ?? 0, confirmed: row?.confirmed_count ?? 0 };
}

/** 分类使用计数（提交时累计） */
export function bumpCategoryUse(catIds: number[]): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE categories SET use_count = use_count + 1 WHERE id = ?");
  for (const id of catIds) stmt.run(id);
}
