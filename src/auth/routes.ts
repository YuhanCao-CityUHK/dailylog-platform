/** 认证接口：钉钉免登、本地账号登录/改密、登出、会话信息。 */
import { getDb, audit, nowIso } from "../infra/db";
import { CONFIG } from "../infra/config";
import { readJson, sendJson, type Ctx, type Router } from "../infra/http";
import { hashPassword, passwordPolicyProblem, verifyPassword } from "./password";
import {
  clearSessionCookie,
  destroySession,
  issueSession,
  revokeUserSessions,
  rowToSessionUser,
} from "./session";
import { fetchDdUserDetail, resolveUseridByAuthCode } from "./dingtalk";
import { type Role } from "./types";
import { capabilitiesForUser } from "./capabilities";
import { userCanViewDailyReports } from "../web/daily-reports-access";
import { syncOrganizationSnapshot } from "../projects/organization";

export function roleForDdUser(userid: string, name = "", isDepartmentManager = false): Role {
  if (CONFIG.roles.admins.includes(userid) || CONFIG.roles.adminNames.includes(name.trim())) return "admin";
  if (CONFIG.roles.execs.includes(userid)) return "exec";
  if (CONFIG.roles.mgrs.includes(userid)) return "mgr";
  if (isDepartmentManager) return "mgr";
  if (CONFIG.roles.leads.includes(userid)) return "lead";
  return "emp";
}

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

export function registerAuthRoutes(router: Router): void {
  router.get("/api/auth/config", (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      corpId: CONFIG.dingtalk.corpId || null,
      dingtalkEnabled: Boolean(CONFIG.dingtalk.clientId && CONFIG.dingtalk.clientSecret),
    });
  });

  /** 钉钉免登：前端 dd.runtime.permission.requestAuthCode 拿 code 后调用 */
  router.post("/api/auth/dingtalk", async (ctx) => {
    const body = await readJson<{ code?: string }>(ctx.req);
    const code = String(body.code ?? "").trim();
    if (!code) {
      sendJson(ctx.res, 400, { ok: false, error: "缺少免登 code" });
      return;
    }
    let userid: string;
    try {
      userid = await resolveUseridByAuthCode(code);
    } catch (err) {
      sendJson(ctx.res, 401, { ok: false, error: err instanceof Error ? err.message : "免登失败" });
      return;
    }
    const db = getDb();
    let row = db
      .prepare(
        "SELECT id, kind, dd_userid, login_name, name, title, dept, role, is_external, active, must_change_pw FROM users WHERE dd_userid = ?",
      )
      .get(userid) as Record<string, unknown> | undefined;
    const detail = await fetchDdUserDetail(userid).catch(() => ({
      userid,
      name: String(row?.name ?? userid),
      title: String(row?.title ?? ""),
      dept: String(row?.dept ?? ""),
      departments: [],
      organizationResolved: false,
    }));
    const isDepartmentManager = detail.organizationResolved
      ? detail.departments.some((department) => department.isManager)
      : String(row?.role ?? "") === "mgr";
    const resolvedName = detail.organizationResolved ? detail.name : String(row?.name ?? detail.name ?? userid);
    const resolvedTitle = detail.organizationResolved ? detail.title : String(row?.title ?? detail.title ?? "");
    if (!row) {
      db.prepare(
        "INSERT INTO users (kind, dd_userid, name, title, dept, role, is_external) VALUES ('dingtalk', ?, ?, ?, ?, ?, 0)",
      ).run(
        userid,
        resolvedName,
        resolvedTitle,
        detail.dept || CONFIG.deptName,
        roleForDdUser(userid, resolvedName, isDepartmentManager),
      );
      row = db
        .prepare(
          "SELECT id, kind, dd_userid, login_name, name, title, dept, role, is_external, active, must_change_pw FROM users WHERE dd_userid = ?",
        )
        .get(userid) as Record<string, unknown>;
      audit(Number(row.id), "user.provision.dingtalk", userid);
    } else {
      const expect = roleForDdUser(userid, resolvedName, isDepartmentManager);
      db.prepare("UPDATE users SET name = ?, title = ?, role = ? WHERE id = ?").run(
        resolvedName,
        resolvedTitle,
        expect,
        Number(row.id),
      );
      row = db
        .prepare(
          "SELECT id, kind, dd_userid, login_name, name, title, dept, role, is_external, active, must_change_pw FROM users WHERE dd_userid = ?",
        )
        .get(userid) as Record<string, unknown>;
    }
    if (detail.organizationResolved) {
      const stamp = nowIso();
      syncOrganizationSnapshot(
        Number(row.id),
        {
          departmentName: detail.dept || String(row.dept ?? ""),
          managerDepartmentNames: detail.departments.filter((department) => department.isManager).map((department) => department.name),
          syncedAt: stamp,
        },
        db,
      );
      row.dept = detail.dept || row.dept;
      audit(Number(row.id), "organization.sync", stamp);
    }
    if (Number(row.active) !== 1) {
      sendJson(ctx.res, 403, { ok: false, error: "账号已停用" });
      return;
    }
    issueSession(ctx.res, Number(row.id), ctx.req);
    audit(Number(row.id), "auth.login.dingtalk", userid);
    sendJson(ctx.res, 200, { ok: true, user: rowToSessionUser(row as never) });
  });

  /** 本地账号（外部工程师/管理员）登录 */
  router.post("/api/auth/login", async (ctx) => {
    const body = await readJson<{ loginName?: string; password?: string }>(ctx.req);
    const loginName = String(body.loginName ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!loginName || !password) {
      sendJson(ctx.res, 400, { ok: false, error: "请输入账号和密码" });
      return;
    }
    const db = getDb();
    const row = db
      .prepare(
        "SELECT id, kind, dd_userid, login_name, name, title, dept, role, is_external, active, must_change_pw FROM users WHERE login_name = ?",
      )
      .get(loginName) as Record<string, unknown> | undefined;
    const cred = row
      ? (db
          .prepare("SELECT password_hash, failed_attempts, locked_until FROM local_credentials WHERE user_id = ?")
          .get(Number(row.id)) as { password_hash: string; failed_attempts: number; locked_until: string | null } | undefined)
      : undefined;
    if (!row || !cred || Number(row.active) !== 1) {
      sendJson(ctx.res, 401, { ok: false, error: "账号或密码不正确" });
      return;
    }
    if (cred.locked_until && Date.parse(cred.locked_until) > Date.now()) {
      sendJson(ctx.res, 429, { ok: false, error: "失败次数过多，账号已临时锁定，请稍后再试" });
      return;
    }
    if (!verifyPassword(password, cred.password_hash)) {
      const attempts = cred.failed_attempts + 1;
      const lock =
        attempts >= LOCK_THRESHOLD ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
      db.prepare("UPDATE local_credentials SET failed_attempts = ?, locked_until = ? WHERE user_id = ?").run(
        attempts,
        lock,
        Number(row.id),
      );
      audit(Number(row.id), "auth.login.failed", loginName);
      sendJson(ctx.res, 401, { ok: false, error: "账号或密码不正确" });
      return;
    }
    db.prepare("UPDATE local_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?").run(
      Number(row.id),
    );
    issueSession(ctx.res, Number(row.id), ctx.req);
    audit(Number(row.id), "auth.login.local", loginName);
    sendJson(ctx.res, 200, { ok: true, user: rowToSessionUser(row as never) });
  });

  router.post("/api/auth/change-password", async (ctx) => {
    if (!ctx.user) {
      sendJson(ctx.res, 401, { ok: false, error: "未登录" });
      return;
    }
    if (ctx.user.kind !== "local") {
      sendJson(ctx.res, 400, { ok: false, error: "钉钉账号无需密码" });
      return;
    }
    const body = await readJson<{ oldPassword?: string; newPassword?: string }>(ctx.req);
    const oldPw = String(body.oldPassword ?? "");
    const newPw = String(body.newPassword ?? "");
    const problem = passwordPolicyProblem(newPw);
    if (problem) {
      sendJson(ctx.res, 400, { ok: false, error: problem });
      return;
    }
    const db = getDb();
    const cred = db
      .prepare("SELECT password_hash FROM local_credentials WHERE user_id = ?")
      .get(ctx.user.id) as { password_hash: string } | undefined;
    if (!cred || !verifyPassword(oldPw, cred.password_hash)) {
      sendJson(ctx.res, 401, { ok: false, error: "原密码不正确" });
      return;
    }
    db.prepare(
      "UPDATE local_credentials SET password_hash = ?, password_changed_at = ?, failed_attempts = 0, locked_until = NULL WHERE user_id = ?",
    ).run(hashPassword(newPw), nowIso(), ctx.user.id);
    db.prepare("UPDATE users SET must_change_pw = 0 WHERE id = ?").run(ctx.user.id);
    revokeUserSessions(ctx.user.id);
    issueSession(ctx.res, ctx.user.id, ctx.req);
    audit(ctx.user.id, "auth.password.changed");
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post("/api/auth/logout", (ctx) => {
    destroySession(ctx.req);
    clearSessionCookie(ctx.res);
    sendJson(ctx.res, 200, { ok: true, redirectTo: "/login" });
  });

  router.get("/api/me", (ctx) => {
    if (!ctx.user) {
      sendJson(ctx.res, 401, { ok: false, error: "未登录" });
      return;
    }
    const capabilities = capabilitiesForUser(ctx.user, getDb());
    sendJson(ctx.res, 200, {
      ok: true,
      user: {
        ...ctx.user,
        canDailyReports: userCanViewDailyReports(ctx.user),
        canPersonalLogs: capabilities.personalLogs,
        canDwsAssistant: capabilities.assistant,
        capabilities,
      },
    });
  });
}
