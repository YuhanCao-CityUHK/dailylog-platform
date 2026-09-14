import type { SessionUser } from "../auth/types";
import { canManageProject } from "../projects/permissions";
import { VivoClient, hash } from "./client";
import { beijingDate, entityId, progressText, VivoError, workDate, type ProjectSnapshot, type TaskSummary, type VivoProject, type VivoTask } from "./types";

interface Job { status: "running" | "done" | "error"; completed: number; total: number; error?: string; startedAt: number; promise: Promise<void>; }
export class VivoService {
  private readonly jobs = new Map<string, Job>();
  constructor(readonly client: VivoClient, readonly sharedUserId?: number) {}
  sourceUserId(user: SessionUser): number {
    if (!this.sharedUserId) return user.id;
    const source = this.client.store.db.prepare("SELECT active,is_external FROM users WHERE id=?").get(this.sharedUserId) as { active: number; is_external: number } | undefined;
    if (!source?.active || source.is_external) throw new VivoError("configuration", "研发任务统一数据源暂不可用，请联系管理员", 503);
    return this.sharedUserId;
  }
  async catalog(user: SessionUser) {
    if (user.isExternal) throw new VivoError("forbidden", "该功能面向内部项目管理者", 403);
    const projects = await this.client.projects(this.sourceUserId(user));
    const autoLinked = this.client.store.autoLink(user, projects);
    return { projects, autoLinked };
  }
  async updateLinks(user: SessionUser, projectId: number, ids: string[]) {
    const projects = await this.client.projects(this.sourceUserId(user));
    this.client.store.replaceLinks(user, projectId, ids, projects);
    return this.client.store.links(projectId);
  }
  async view(user: SessionUser, projectId: number, date: string, refresh = false) {
    this.client.store.requireView(user, projectId); workDate(date);
    const canManage = canManageProject(user, projectId, this.client.store.db);
    const sourceUserId = this.sourceUserId(user);
    const shared = Boolean(this.sharedUserId);
    const connection = this.client.connection(sourceUserId);
    if (!connection) return { connected: false, shared, canManage, date, links: [], snapshot: null, syncing: false };
    // 每次读取都重新取得远端可见目录，禁止权限失效后继续返回缓存。
    const { projects, autoLinked } = await this.catalog(user);
    const allLinks = this.client.store.links(projectId);
    const sourceProjects = projects.filter((p) => allLinks.some((l) => l.sourceId === p.id));
    const unavailableCount = allLinks.length - sourceProjects.length;
    const links = sourceProjects.map((p) => ({ ...p, ...allLinks.find((l) => l.sourceId === p.id)! }));
    if (!sourceProjects.length) return { connected: true, shared, canManage, date, links, unavailableCount, autoLinked, snapshot: null, syncing: false };
    const linkHash = hash(sourceProjects.map((p) => p.id).sort().join(","));
    const slot = `snapshot:${projectId}:${date}:${linkHash}`;
    const key = `${sourceUserId}:${connection.id}:${slot}`;
    let snapshot = this.client.store.get<ProjectSnapshot>(sourceUserId, slot);
    let job = this.jobs.get(key);
    const expired = !snapshot || Date.now() - Date.parse(snapshot.syncedAt) > 5 * 60_000;
    const retry = shared && job?.status === "error" && Date.now() - job.startedAt > 60_000;
    if (job?.status !== "running" && (refresh || retry || (expired && job?.status !== "error"))) {
      job = this.start(key, slot, sourceUserId, connection.id, sourceProjects, date);
    }
    if (job?.status === "done") snapshot = this.client.store.get<ProjectSnapshot>(sourceUserId, slot);
    return {
      connected: true, shared, canManage, date, links, unavailableCount, autoLinked, snapshot,
      syncing: job?.status === "running", syncProgress: job ? { completed: job.completed, total: job.total } : null,
      error: job?.error, stale: Boolean(snapshot && expired),
    };
  }
  private start(key: string, slot: string, userId: number, connectionId: string, projects: VivoProject[], date: string): Job {
    for (const [id, previous] of this.jobs) if (previous.status !== "running" && Date.now() - previous.startedAt > 3600_000) this.jobs.delete(id);
    const job: Job = { status: "running", completed: 0, total: 0, startedAt: Date.now(), promise: Promise.resolve() };
    const stamp = new Date();
    job.promise = this.collect(userId, projects, date, stamp, job).then((snapshot) => {
      if (this.client.connection(userId)?.id !== connectionId) throw new VivoError("connection_changed", "连接已更改，请重新读取", 409);
      this.client.store.put(userId, slot, snapshot);
      job.status = "done";
    }).catch((error: unknown) => {
      job.status = "error";
      job.error = error instanceof VivoError ? error.message : "读取任务失败，请重新同步";
    });
    this.jobs.set(key, job); return job;
  }
  async waitForIdle(): Promise<void> { await Promise.all([...this.jobs.values()].map((job) => job.promise)); }
  private async collect(userId: number, projects: VivoProject[], date: string, now: Date, job: Job): Promise<ProjectSnapshot> {
    const warnings: string[] = []; let complete = true;
    const tasks: Array<{ task: VivoTask; project: VivoProject }> = [];
    const seen = new Set<string>();
    for (const project of projects) {
      const result = await this.client.tasks(userId, project.id);
      if (!result.complete) { complete = false; warnings.push(`${project.name}：任务列表未读取完整`); }
      for (const task of result.items) {
        const id = entityId(task.id);
        if (seen.has(id)) continue;
        seen.add(id); tasks.push({ task, project });
      }
    }
    job.total = tasks.length;
    const output: TaskSummary[] = new Array(tasks.length);
    const start = Date.parse(`${date}T00:00:00+08:00`), end = start + 86400_000;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, async () => {
      for (;;) {
        const index = next++; if (index >= tasks.length) break;
        const { task, project } = tasks[index];
        let progress: TaskSummary["progress"] = [], progressComplete = true;
        try {
          const result = await this.client.progress(userId, task.id);
          progressComplete = result.complete;
          const ids = new Set<string>();
          progress = result.items.filter((p) => {
            const at = Date.parse(p.createdAt);
            if (!Number.isFinite(at)) { progressComplete = false; return false; }
            if (at < start || at >= end || ids.has(p.id)) return false;
            ids.add(p.id); return true;
          }).map((p) => ({ id: entityId(p.id), createdAt: p.createdAt, author: String(p.staff?.name ?? "未标注人员"), text: progressText(p.content), attachmentCount: Math.max(0, Number(p.attachmentCount) || 0) }))
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        } catch (error) {
          if (error instanceof VivoError && ["authorization_expired", "not_connected", "connection_changed"].includes(error.code)) throw error;
          progressComplete = false;
        }
        if (!progressComplete) complete = false;
        output[index] = {
          id: task.id, name: String(task.name), status: String(task.status), phase: String(task.phase),
          riskFlag: task.riskFlag ?? null, startDate: task.startDate, endDate: task.endDate,
          assignee: task.assignee, parentTaskId: task.parentTaskId ?? null, depth: Number(task.depth) || 0,
          directChildCount: Number(task.directChildCount) || 0,
          sourceProjectId: project.id, sourceProjectName: project.name,
          url: `${this.client.config.origin}/tasks/${encodeURIComponent(task.id)}`,
          overdue: ["NOT_STARTED", "IN_PROGRESS"].includes(task.status) && Boolean(task.endDate && task.endDate.slice(0, 10) < beijingDate(now)),
          progress, progressComplete,
        };
        job.completed++;
      }
    }));
    const incomplete = output.filter((t) => !t.progressComplete).length;
    if (incomplete) warnings.push(`${incomplete} 项任务的进展未读取完整，不能据此判断当日没有更新`);
    return { date, syncedAt: new Date().toISOString(), projects, tasks: output, complete, warnings };
  }
}
