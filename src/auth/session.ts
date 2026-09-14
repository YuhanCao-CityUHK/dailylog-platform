/** 会话：随机 token（Cookie）→ 数据库存哈希。钉钉免登与本地登录共用同一套签发。 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb, nowIso } from "../infra/db";
import { CONFIG } from "../infra/config";
import { parseCookies } from "../infra/http";
import type { Role, SessionUser } from "./types";

const COOKIE_NAME = "dailylog_sid";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueSession(res: ServerResponse, userId: number, req?: IncomingMessage): void {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + CONFIG.sessionTtlHours * 3600 * 1000);
  getDb()
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      hashToken(token),
      userId,
      now.toISOString(),
      now.toISOString(),
      expires.toISOString(),
      req ? String(req.socket.remoteAddress ?? "") : "",
      req ? String(req.headers["user-agent"] ?? "").slice(0, 200) : "",
    );
  const secure = CONFIG.devMode ? "" : " Secure;";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${CONFIG.sessionTtlHours * 3600}`,
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function destroySession(req: IncomingMessage): void {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function revokeUserSessions(userId: number): void {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

interface UserRow {
  id: number;
  kind: string;
  dd_userid: string | null;
  login_name: string | null;
  name: string;
  title: string;
  dept: string;
  role: string;
  is_external: number;
  active: number;
  must_change_pw: number;
}

export function rowToSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    kind: row.kind as "dingtalk" | "local",
    ddUserid: row.dd_userid ?? undefined,
    loginName: row.login_name ?? undefined,
    name: row.name,
    title: row.title ?? "",
    dept: row.dept ?? "",
    role: row.role as Role,
    isExternal: row.is_external === 1,
    mustChangePw: row.must_change_pw === 1,
  };
}

export function resolveSession(req: IncomingMessage): SessionUser | null {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const db = getDb();
  const sess = db
    .prepare("SELECT token_hash, user_id, last_seen_at, expires_at FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as { token_hash: string; user_id: number; last_seen_at: string; expires_at: string } | undefined;
  if (!sess) return null;
  const now = Date.now();
  if (Date.parse(sess.expires_at) < now) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sess.token_hash);
    return null;
  }
  const idleMs = CONFIG.sessionIdleHours * 3600 * 1000;
  if (now - Date.parse(sess.last_seen_at) > idleMs) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sess.token_hash);
    return null;
  }
  const user = db
    .prepare(
      "SELECT id, kind, dd_userid, login_name, name, title, dept, role, is_external, active, must_change_pw FROM users WHERE id = ?",
    )
    .get(sess.user_id) as UserRow | undefined;
  if (!user || user.active !== 1) return null;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowIso(), sess.token_hash);
  return rowToSessionUser(user);
}
