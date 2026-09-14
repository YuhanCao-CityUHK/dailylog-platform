import { audit, getDb } from "../infra/db";
import { readJson, sendJson, type Ctx, type Router } from "../infra/http";
import { capabilitiesForUser } from "../auth/capabilities";
import { canAssignProjectOwner, canCreateFormalProject, canManageProject } from "./permissions";
import {
  createFormalProject,
  listFormalProjects,
  listProjectAudit,
  ProjectServiceError,
  setFormalProjectStatus,
  transferFormalProject,
  updateFormalProject,
} from "./service";
import { listFinanceProjectCodes, replaceFinanceProjectCodes } from "../platform/finance-project-codes";

function requireUser(ctx: Ctx): boolean {
  if (ctx.user) return true;
  sendJson(ctx.res, 401, { ok: false, error: "未登录" });
  return false;
}

function projectId(ctx: Ctx): number {
  return Number(ctx.params.id) || 0;
}

function sendProjectError(ctx: Ctx, error: unknown): void {
  if (error instanceof ProjectServiceError) {
    sendJson(ctx.res, error.statusCode, { ok: false, code: error.code, error: error.message });
    return;
  }
  throw error;
}

export function registerProjectRoutes(router: Router): void {
  router.get("/api/projects", (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const db = getDb();
      const projects = listFormalProjects(
        ctx.user!,
        db,
        ctx.url.searchParams.get("includeCompleted") === "1",
      ).map((project) => ({
        ...project,
        canManage: canManageProject(ctx.user!, project.id, db),
        financeCodes: listFinanceProjectCodes(project.id, db).map(({ id, code, name }) => ({ id, code, name })),
      }));
      sendJson(ctx.res, 200, {
        ok: true,
        projects,
        canCreate: canCreateFormalProject(ctx.user!, db),
      });
    } catch (error) {
      sendProjectError(ctx, error);
    }
  });

  router.get("/api/projects/manage-meta", (ctx) => {
    if (!requireUser(ctx)) return;
    const db = getDb();
    if (!capabilitiesForUser(ctx.user!, db).projects) {
      sendJson(ctx.res, 403, { ok: false, error: "无权使用项目管理" });
      return;
    }
    const people = db
      .prepare(
        `SELECT id, name, title, dept, is_external AS isExternal FROM users
          WHERE active = 1
          ORDER BY is_external, dept, name, id`,
      )
      .all() as unknown as Array<{ id: number; name: string; title: string; dept: string; isExternal: number }>;
    const assignableOwnerUserIds = people
      .filter((person) => canAssignProjectOwner(ctx.user!, person.id, db))
      .map((person) => person.id);
    sendJson(ctx.res, 200, {
      ok: true,
      people,
      canCreate: canCreateFormalProject(ctx.user!, db),
      createOwnerUserIds: assignableOwnerUserIds,
      assignableOwnerUserIds,
    });
  });

  router.post("/api/projects", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ name?: string; ownerUserId?: number; memberUserIds?: number[] }>(ctx.req);
    try {
      const project = createFormalProject(
        ctx.user!,
        {
          name: String(body.name ?? ""),
          ownerUserId: Number(body.ownerUserId) || undefined,
          memberUserIds: Array.isArray(body.memberUserIds) ? body.memberUserIds : undefined,
        },
        getDb(),
      );
      sendJson(ctx.res, 201, { ok: true, project, created: { id: project.id, name: project.name } });
    } catch (error) {
      sendProjectError(ctx, error);
    }
  });

  router.put("/api/projects/:id", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ name?: string; memberUserIds?: number[] }>(ctx.req);
    try {
      const project = updateFormalProject(ctx.user!, projectId(ctx), body, getDb());
      sendJson(ctx.res, 200, { ok: true, project });
    } catch (error) {
      sendProjectError(ctx, error);
    }
  });

  router.put("/api/projects/:id/finance-codes", async (ctx) => {
    if (!requireUser(ctx)) return;
    const id = projectId(ctx);
    const db = getDb();
    if (!canManageProject(ctx.user!, id, db)) {
      sendJson(ctx.res, 403, { ok: false, error: "无权管理该项目的财务项目编码" });
      return;
    }
    const body = await readJson<{ codes?: unknown }>(ctx.req);
    if (!Array.isArray(body.codes)) {
      sendJson(ctx.res, 400, { ok: false, error: "财务项目编码应按每行一个填写" });
      return;
    }
    const codes: string[] = [];
    for (const raw of body.codes) {
      if (typeof raw !== "string") {
        sendJson(ctx.res, 400, { ok: false, error: "财务项目编码必须是文字" });
        return;
      }
      const code = raw.normalize("NFKC").trim();
      if (!code) continue;
      if (code.length > 200) {
        sendJson(ctx.res, 400, { ok: false, error: "单条财务项目编码不能超过 200 个字符" });
        return;
      }
      if (!codes.includes(code)) codes.push(code);
    }
    if (codes.length > 100) {
      sendJson(ctx.res, 400, { ok: false, error: "单个项目最多配置 100 条财务项目编码" });
      return;
    }
    const financeCodes = replaceFinanceProjectCodes(id, codes, db).map(({ id: codeId, code, name }) => ({
      id: codeId,
      code,
      name,
    }));
    audit(ctx.user!.id, "project.finance_codes.update", `${id}:${JSON.stringify(codes)}`);
    sendJson(ctx.res, 200, { ok: true, financeCodes });
  });

  router.post("/api/projects/:id/transfer", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ newOwnerUserId?: number }>(ctx.req);
    try {
      const project = transferFormalProject(ctx.user!, projectId(ctx), Number(body.newOwnerUserId) || 0, getDb());
      sendJson(ctx.res, 200, { ok: true, project });
    } catch (error) {
      sendProjectError(ctx, error);
    }
  });

  router.post("/api/projects/:id/status", async (ctx) => {
    if (!requireUser(ctx)) return;
    const body = await readJson<{ status?: "in_progress" | "completed" }>(ctx.req);
    try {
      const project = setFormalProjectStatus(ctx.user!, projectId(ctx), String(body.status ?? "") as never, getDb());
      sendJson(ctx.res, 200, { ok: true, project });
    } catch (error) {
      sendProjectError(ctx, error);
    }
  });

  router.get("/api/projects/:id/audit", (ctx) => {
    if (!requireUser(ctx)) return;
    try {
      const entries = listProjectAudit(ctx.user!, projectId(ctx), getDb());
      sendJson(ctx.res, 200, { ok: true, entries });
    } catch (error) {
      sendProjectError(ctx, error);
    }
  });
}
