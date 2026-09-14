/** 管理接口：外部账号管理、人员应提交口径、节假日维护（仅 admin）。 */
import { getDb, audit } from "../infra/db";
import { readJson, sendJson, type Ctx, type Router } from "../infra/http";
import { generatePassword, hashPassword, passwordPolicyProblem } from "../auth/password";
import { revokeUserSessions } from "../auth/session";

function requireAdmin(ctx: Ctx): boolean {
  if (!ctx.user) {
    sendJson(ctx.res, 401, { ok: false, error: "未登录" });
    return false;
  }
  if (ctx.user.role !== "admin") {
    sendJson(ctx.res, 403, { ok: false, error: "仅管理员可操作" });
    return false;
  }
  return true;
}

export function registerAdminRoutes(router: Router): void {
  router.get("/api/admin/users", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const rows = getDb()
      .prepare(
        `SELECT id, kind, dd_userid, login_name, name, title, dept, role, is_external, active, must_change_pw, should_submit, exempt_reminder, created_at
         FROM users ORDER BY is_external DESC, id`,
      )
      .all() as unknown as Array<Record<string, unknown>>;
    sendJson(ctx.res, 200, { ok: true, users: rows });
  });

  /** 创建外部（本地）账号；返回初始密码（仅此一次） */
  router.post("/api/admin/external-users", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = await readJson<{ loginName?: string; name?: string; password?: string }>(ctx.req);
    const loginName = String(body.loginName ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim() || loginName;
    if (!/^[a-z0-9_-]{3,32}$/.test(loginName)) {
      sendJson(ctx.res, 400, { ok: false, error: "登录名需为 3-32 位字母/数字/下划线/中划线" });
      return;
    }
    const db = getDb();
    const dup = db.prepare("SELECT 1 AS x FROM users WHERE login_name = ?").get(loginName);
    if (dup) {
      sendJson(ctx.res, 400, { ok: false, error: "登录名已存在" });
      return;
    }
    let password = String(body.password ?? "").trim();
    if (password) {
      const problem = passwordPolicyProblem(password);
      if (problem) {
        sendJson(ctx.res, 400, { ok: false, error: problem });
        return;
      }
    } else {
      password = generatePassword();
    }
    db.prepare(
      "INSERT INTO users (kind, login_name, name, role, is_external, must_change_pw, should_submit) VALUES ('local', ?, ?, 'emp', 1, 1, 1)",
    ).run(loginName, name);
    const id = Number((db.prepare("SELECT id FROM users WHERE login_name = ?").get(loginName) as { id: number }).id);
    db.prepare("INSERT INTO local_credentials (user_id, password_hash) VALUES (?, ?)").run(id, hashPassword(password));
    audit(ctx.user!.id, "admin.external.create", loginName);
    sendJson(ctx.res, 200, { ok: true, user: { id, loginName, name }, initialPassword: password });
  });

  router.post("/api/admin/users/:id/reset-password", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const id = Number(ctx.params.id) || 0;
    const db = getDb();
    const row = db.prepare("SELECT id, kind FROM users WHERE id = ?").get(id) as { id: number; kind: string } | undefined;
    if (!row || row.kind !== "local") {
      sendJson(ctx.res, 404, { ok: false, error: "账号不存在或非本地账号" });
      return;
    }
    const password = generatePassword();
    db.prepare(
      "UPDATE local_credentials SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE user_id = ?",
    ).run(hashPassword(password), id);
    db.prepare("UPDATE users SET must_change_pw = 1 WHERE id = ?").run(id);
    revokeUserSessions(id);
    audit(ctx.user!.id, "admin.user.reset_pw", String(id));
    sendJson(ctx.res, 200, { ok: true, initialPassword: password });
  });

  router.post("/api/admin/users/:id/update", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const id = Number(ctx.params.id) || 0;
    const body = await readJson<{ active?: boolean; name?: string; shouldSubmit?: boolean; exemptReminder?: boolean; role?: string }>(
      ctx.req,
    );
    const db = getDb();
    const row = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
    if (!row) {
      sendJson(ctx.res, 404, { ok: false, error: "账号不存在" });
      return;
    }
    if (typeof body.active === "boolean") {
      db.prepare("UPDATE users SET active = ? WHERE id = ?").run(body.active ? 1 : 0, id);
      if (!body.active) revokeUserSessions(id);
    }
    if (typeof body.shouldSubmit === "boolean") {
      db.prepare("UPDATE users SET should_submit = ? WHERE id = ?").run(body.shouldSubmit ? 1 : 0, id);
    }
    if (typeof body.exemptReminder === "boolean") {
      db.prepare("UPDATE users SET exempt_reminder = ? WHERE id = ?").run(body.exemptReminder ? 1 : 0, id);
    }
    if (typeof body.name === "string" && body.name.trim()) {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(body.name.trim(), id);
    }
    if (typeof body.role === "string" && ["emp", "lead", "mgr", "exec", "admin"].includes(body.role)) {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.role, id);
    }
    audit(ctx.user!.id, "admin.user.update", `${id}:${JSON.stringify(body)}`);
    sendJson(ctx.res, 200, { ok: true });
  });

  /** 节假日 / 调休补班维护 */
  router.get("/api/admin/calendar", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const db = getDb();
    sendJson(ctx.res, 200, {
      ok: true,
      holidays: db.prepare("SELECT date, name FROM holidays ORDER BY date").all(),
      workdaysExtra: db.prepare("SELECT date, name FROM workdays_extra ORDER BY date").all(),
    });
  });

  router.post("/api/admin/calendar", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = await readJson<{ action?: string; kind?: string; date?: string; name?: string }>(ctx.req);
    const date = String(body.date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(ctx.res, 400, { ok: false, error: "日期格式应为 YYYY-MM-DD" });
      return;
    }
    const table = body.kind === "workday" ? "workdays_extra" : "holidays";
    const db = getDb();
    if (body.action === "remove") {
      db.prepare(`DELETE FROM ${table} WHERE date = ?`).run(date);
    } else {
      db.prepare(`INSERT OR REPLACE INTO ${table} (date, name) VALUES (?, ?)`).run(date, String(body.name ?? ""));
    }
    sendJson(ctx.res, 200, { ok: true });
  });
}
