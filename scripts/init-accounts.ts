/**
 * 初始化账号：平台管理员（本地账号，备用入口）+ 平湖两位外部工程师。
 * 用法：npm run init-accounts   （重复执行安全：已存在的账号跳过）
 * 输出初始密码，只显示一次，请立即记录并转发。
 */
import { getDb } from "../src/infra/db";
import { ensureDirs } from "../src/infra/config";
import { hashPassword, generatePassword } from "../src/auth/password";
import { seedCategoriesIfEmpty } from "../src/platform/store";

interface Spec {
  loginName: string;
  name: string;
  role: "admin" | "emp";
  isExternal: boolean;
}

const ACCOUNTS: Spec[] = [
  { loginName: "admin", name: "平台管理员", role: "admin", isExternal: false },
  { loginName: "pinghu01", name: "平湖工程师一", role: "emp", isExternal: true },
  { loginName: "pinghu02", name: "平湖工程师二", role: "emp", isExternal: true },
];

ensureDirs();
const db = getDb();
seedCategoriesIfEmpty();

for (const spec of ACCOUNTS) {
  const existing = db.prepare("SELECT id FROM users WHERE login_name = ?").get(spec.loginName);
  if (existing) {
    console.log(`[跳过] ${spec.loginName} 已存在`);
    continue;
  }
  const pw = generatePassword();
  db.prepare(
    "INSERT INTO users (kind, login_name, name, role, is_external, must_change_pw, should_submit) VALUES ('local', ?, ?, ?, ?, 1, ?)",
  ).run(spec.loginName, spec.name, spec.role, spec.isExternal ? 1 : 0, spec.isExternal ? 1 : 0);
  const id = Number((db.prepare("SELECT id FROM users WHERE login_name = ?").get(spec.loginName) as { id: number }).id);
  db.prepare("INSERT INTO local_credentials (user_id, password_hash) VALUES (?, ?)").run(id, hashPassword(pw));
  console.log(`[创建] ${spec.loginName}（${spec.name}，${spec.role}${spec.isExternal ? "，外部" : ""}） 初始密码：${pw}`);
}
console.log("完成。初始密码仅显示这一次；所有账号首次登录会被要求修改密码。");
