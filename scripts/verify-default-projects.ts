/** 默认项目配置的隔离验证脚本；仅写入系统临时目录。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dailylog-default-project-"));
process.env.DATA_DIR = dataDir;

const { getDb } = await import("../src/infra/db");
const { ensureConfiguredDefaultProjects, getDefaultProjectId } = await import("../src/platform/store");

const db = getDb();
const addUser = db.prepare("INSERT INTO users(kind, login_name, name, is_external) VALUES('local', ?, ?, 1)");
addUser.run("pinghu01", "平湖01");
addUser.run("pinghu02", "平湖02");

const result = ensureConfiguredDefaultProjects("pinghu01:水锤项目,pinghu02:水锤项目");
const users = db
  .prepare("SELECT id, login_name FROM users WHERE login_name LIKE 'pinghu%' ORDER BY login_name")
  .all() as unknown as Array<{ id: number; login_name: string }>;
const project = db
  .prepare("SELECT id, name, source, active FROM projects WHERE name = '水锤项目'")
  .get() as { id: number; name: string; source: string; active: number } | undefined;

if (!project) throw new Error("水锤项目未创建");
const members = (
  db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?").get(project.id) as { n: number }
).n;
const defaults = users.map((user) => ({
  login: user.login_name,
  projectId: getDefaultProjectId(user.id),
}));

if (result.configured !== 2 || result.missingUsers.length !== 0) throw new Error("配置结果不符合预期");
if (project.source !== "configured" || project.active !== 1) throw new Error("项目状态不符合预期");
if (members !== 2 || defaults.some((item) => item.projectId !== project.id)) {
  throw new Error("账号与默认项目关联不符合预期");
}

console.log(JSON.stringify({ result, project, members, defaults }));
