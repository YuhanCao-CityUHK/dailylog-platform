import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptJson, encryptJson, type CipherText } from "../assistant/crypto";
import type { SessionUser } from "../auth/types";
import { canManageProject, canViewProjectReports } from "../projects/permissions";
import { VivoError, type VivoProject } from "./types";
import { INITIAL_VIVOFLOW_LINKS, INITIAL_VIVOFLOW_ORIGIN } from "./initial-links";

export function ensureVivoFlowSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vivoflow_private (
      user_id INTEGER NOT NULL REFERENCES users(id), origin TEXT NOT NULL, slot TEXT NOT NULL,
      payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, origin, slot)
    );
    CREATE TABLE IF NOT EXISTS vivoflow_project_links (
      origin TEXT NOT NULL, source_id TEXT NOT NULL, project_id INTEGER REFERENCES projects(id),
      method TEXT NOT NULL CHECK(method IN ('auto','manual')), reason TEXT NOT NULL DEFAULT '',
      updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
      PRIMARY KEY(origin, source_id)
    );
    CREATE TABLE IF NOT EXISTS vivoflow_link_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, source_id TEXT NOT NULL,
      old_project_id INTEGER, new_project_id INTEGER, actor_id INTEGER NOT NULL,
      method TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}

export class VivoStore {
  private readonly key: Buffer;
  constructor(readonly db: DatabaseSync, readonly origin: string, secret: string) {
    if (secret.length < 16) throw new VivoError("configuration", "平台会话密钥未配置，暂不能连接 VivoFlow", 503);
    this.key = createHash("sha256").update(`vivoflow-v1:${secret}`).digest();
    ensureVivoFlowSchema(db);
  }
  private aad(userId: number, slot: string): string { return JSON.stringify([this.origin, userId, slot]); }
  get<T>(userId: number, slot: string): T | null {
    const row = this.db.prepare("SELECT payload FROM vivoflow_private WHERE user_id=? AND origin=? AND slot=?")
      .get(userId, this.origin, slot) as { payload: string } | undefined;
    return row ? decryptJson<T>(JSON.parse(row.payload) as CipherText, this.key, this.aad(userId, slot)) : null;
  }
  put(userId: number, slot: string, value: unknown): void {
    if (slot.startsWith("snapshot:")) this.db.prepare("DELETE FROM vivoflow_private WHERE user_id=? AND origin=? AND slot LIKE 'snapshot:%' AND updated_at<?")
      .run(userId, this.origin, new Date(Date.now() - 86400_000).toISOString());
    this.db.prepare(`INSERT INTO vivoflow_private VALUES (?,?,?,?,?)
      ON CONFLICT(user_id,origin,slot) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(userId, this.origin, slot, JSON.stringify(encryptJson(value, this.key, this.aad(userId, slot))), new Date().toISOString());
  }
  remove(userId: number, slot?: string): void {
    if (slot) this.db.prepare("DELETE FROM vivoflow_private WHERE user_id=? AND origin=? AND slot=?").run(userId, this.origin, slot);
    else this.db.prepare("DELETE FROM vivoflow_private WHERE user_id=? AND origin=?").run(userId, this.origin);
  }
  links(projectId: number): Array<{ sourceId: string; method: string; reason: string }> {
    return this.db.prepare("SELECT source_id AS sourceId, method, reason FROM vivoflow_project_links WHERE origin=? AND project_id=? ORDER BY source_id")
      .all(this.origin, projectId) as unknown as Array<{ sourceId: string; method: string; reason: string }>;
  }
  assignments(user: SessionUser, catalog: VivoProject[]) {
    const visible = new Set(catalog.map((p) => p.id));
    const rows = this.db.prepare("SELECT l.source_id AS sourceId,p.id AS projectId,p.name AS projectName FROM vivoflow_project_links l JOIN projects p ON p.id=l.project_id WHERE l.origin=?")
      .all(this.origin) as unknown as Array<{ sourceId: string; projectId: number; projectName: string }>;
    return rows.filter((row) => visible.has(row.sourceId)).map((row) => ({ ...row, projectName: canViewProjectReports(user, row.projectId, this.db) ? row.projectName : "其他平台项目" }));
  }
  requireView(user: SessionUser, projectId: number): void {
    if (user.isExternal || !this.db.prepare("SELECT id FROM projects WHERE id=? AND source<>'dingtalk'").get(projectId)
      || !canViewProjectReports(user, projectId, this.db)) throw new VivoError("project_forbidden", "无权查看该项目的研发任务", 403);
  }
  private link(sourceId: string, projectId: number | null, userId: number, method: "auto" | "manual", reason: string): void {
    const old = this.db.prepare("SELECT project_id FROM vivoflow_project_links WHERE origin=? AND source_id=?").get(this.origin, sourceId) as { project_id: number | null } | undefined;
    const stamp = new Date().toISOString();
    this.db.prepare(`INSERT INTO vivoflow_project_links VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(origin,source_id) DO UPDATE SET project_id=excluded.project_id,method=excluded.method,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(this.origin, sourceId, projectId, method, reason, userId, stamp);
    this.db.prepare("INSERT INTO vivoflow_link_audit (origin,source_id,old_project_id,new_project_id,actor_id,method,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(this.origin, sourceId, old?.project_id ?? null, projectId, userId, method, stamp);
  }
  replaceLinks(user: SessionUser, projectId: number, sourceIds: string[], catalog: VivoProject[]): void {
    this.requireView(user, projectId);
    if (!canManageProject(user, projectId, this.db)) throw new VivoError("manage_forbidden", "只有项目管理者可以调整关联", 403);
    const visibleIds = new Set(catalog.map((p) => p.id));
    const ids = [...new Set(sourceIds)];
    const existing = new Set(this.links(projectId).map((link) => link.sourceId));
    if (ids.length > 30 || ids.some((id) => !visibleIds.has(id) && !existing.has(id))) throw new VivoError("source_forbidden", "只能新增关联当前 VivoFlow 账号可见的项目", 403);
    for (const id of ids) {
      const old = this.db.prepare("SELECT project_id FROM vivoflow_project_links WHERE origin=? AND source_id=?").get(this.origin, id) as { project_id: number | null } | undefined;
      if (old?.project_id && old.project_id !== projectId) throw new VivoError("link_conflict", "该研发项目已有关联，请先在原平台项目中解除关联", 409);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const old of this.links(projectId)) if (!ids.includes(old.sourceId)) this.link(old.sourceId, null, user.id, "manual", "人工解除关联");
      for (const id of ids) this.link(id, projectId, user.id, "manual", "人工设置");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  autoLink(user: SessionUser, catalog: VivoProject[]): number {
    if (user.isExternal) return 0;
    const projects = this.db.prepare("SELECT id,name FROM projects WHERE source<>'dingtalk' AND owner_user_id IS NOT NULL")
      .all() as unknown as Array<{ id: number; name: string }>;
    const hasAliases = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_aliases'").get();
    const aliases = hasAliases ? this.db.prepare("SELECT project_id,alias FROM project_aliases").all() as unknown as Array<{ project_id: number; alias: string }> : [];
    let count = 0;
    for (const source of catalog) {
      // 包括 project_id=NULL 的人工解除记录，永远不重新猜测。
      if (this.db.prepare("SELECT 1 FROM vivoflow_project_links WHERE origin=? AND source_id=?").get(this.origin, source.id)) continue;
      const initial = this.origin === INITIAL_VIVOFLOW_ORIGIN ? INITIAL_VIVOFLOW_LINKS.find((link) => link.sourceId === source.id && link.sourceName === source.name) : undefined;
      const initialProjects = initial ? projects.filter((p) => p.name === initial.projectName) : [];
      if (initialProjects.length === 1 && canManageProject(user, initialProjects[0].id, this.db)) {
        this.link(source.id, initialProjects[0].id, user.id, "auto", "已核对项目与产品线的初始关联，可人工调整");
        count++;
        continue;
      }
      if (initial) continue;
      const ranked = projects.map((p) => ({ ...p, score: Math.max(nameScore(p.name, source.name), nameScore(p.name, source.productLine || ""), ...aliases.filter((a) => a.project_id === p.id).flatMap((a) => [nameScore(a.alias, source.name), nameScore(a.alias, source.productLine || "")])) }))
        .filter((p) => p.score >= 0.75).sort((a, b) => b.score - a.score);
      if (!ranked[0] || (ranked[1] && ranked[0].score - ranked[1].score < 0.15) || !canManageProject(user, ranked[0].id, this.db)) continue;
      this.link(source.id, ranked[0].id, user.id, "auto", "项目名称、产品线或已有别名匹配，可人工调整");
      count++;
    }
    return count;
  }
}

export function nameScore(left: string, right: string): number {
  const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "").replace(/(?:研发)?项目$/u, "");
  const a = normalize(left), b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  return short.length >= 3 && long.includes(short) && short.length / long.length >= 0.45 ? 0.8 : 0;
}
