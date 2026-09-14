/** 部署前后只读核验；只输出服务所需的非敏感计数和开关。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const appDir = path.resolve(process.env.APP_DIR ?? process.cwd());
const db = new DatabaseSync(path.join(appDir, "data", "platform.sqlite"), { readOnly: true });
const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
);
const users = db
  .prepare("SELECT id, login_name, name, active FROM users WHERE login_name IN (?, ?) ORDER BY login_name")
  .all("pinghu01", "pinghu02");
const drafts = db
  .prepare(
    `SELECT u.login_name, COUNT(*) AS n FROM drafts d JOIN users u ON u.id = d.user_id
     WHERE u.login_name IN (?, ?) GROUP BY u.login_name ORDER BY u.login_name`,
  )
  .all("pinghu01", "pinghu02");
const projectCount = db.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
const waterHammer = db
  .prepare("SELECT id, name, active, source FROM projects WHERE name = ?")
  .get("水锤项目");
const defaultProjects = tables.has("user_default_projects")
  ? db
      .prepare(
        `SELECT u.login_name, p.name AS project_name FROM user_default_projects d
         JOIN users u ON u.id = d.user_id JOIN projects p ON p.id = d.project_id
         WHERE u.login_name IN (?, ?) ORDER BY u.login_name`,
      )
      .all("pinghu01", "pinghu02")
  : [];

const envText = fs.readFileSync(path.join(appDir, ".env"), "utf8");
const reminder = /^REMINDER_ENABLED=(.*)$/m.exec(envText)?.[1]?.trim() ?? "missing";
const defaultAssignments = /^DEFAULT_PROJECT_ASSIGNMENTS=(.*)$/m.exec(envText)?.[1]?.trim() ?? "missing";
const digestConfigPath = /^DAILY_REPORT_DIGEST_CONFIG_FILE=(.*)$/m.exec(envText)?.[1]?.trim() ?? "";
const digestFile = path.resolve(appDir, digestConfigPath);
const digest = JSON.parse(fs.readFileSync(digestFile, "utf8"));
let yaoViewerRefs = 0;
let yaoRecipientRefs = 0;
for (const org of digest.orgs ?? []) {
  for (const view of org.projectViews ?? []) {
    yaoViewerRefs += (view.viewers ?? []).filter((id) => id === "example-viewer-1").length;
    yaoRecipientRefs += (view.digest?.recipients ?? []).filter((id) => id === "example-viewer-1").length;
  }
}

console.log(
  JSON.stringify({
    users,
    drafts,
    projectCount,
    waterHammer: waterHammer ?? null,
    defaultProjects,
    reminder,
    defaultAssignments,
    yaoViewerRefs,
    yaoRecipientRefs,
  }),
);
