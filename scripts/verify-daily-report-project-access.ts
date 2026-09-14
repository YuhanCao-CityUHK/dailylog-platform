/** 日报项目组入口的权限验证；使用 DAILY_REPORT_DIGEST_CONFIG_FILE 指向的只读配置。 */
import type { Role, SessionUser } from "../src/auth/types";

const { listDailyReportProjectsForUser } = await import("../src/web/daily-reports-access");

function user(input: {
  id: number;
  name: string;
  role?: Role;
  ddUserid?: string;
  isExternal?: boolean;
}): SessionUser {
  return {
    id: input.id,
    kind: input.isExternal ? "local" : "dingtalk",
    name: input.name,
    title: "",
    dept: "",
    role: input.role ?? "emp",
    isExternal: input.isExternal ?? false,
    mustChangePw: false,
    ...(input.ddUserid ? { ddUserid: input.ddUserid } : {}),
  };
}

const counts = {
  admin: listDailyReportProjectsForUser(user({ id: 1, name: "管理员", role: "admin" })).length,
  caoYihui: listDailyReportProjectsForUser(
    user({ id: 2, name: "示例主管", ddUserid: "example-user-1" }),
  ).length,
  yaoKaiheng: listDailyReportProjectsForUser(
    user({ id: 3, name: "示例查看者", ddUserid: "example-viewer-1" }),
  ).length,
  huWenhua: listDailyReportProjectsForUser(
    user({ id: 4, name: "胡文华", ddUserid: "example-user-3" }),
  ).length,
  external: listDailyReportProjectsForUser(
    user({ id: 5, name: "平湖01", role: "admin", isExternal: true }),
  ).length,
};

const expectedYao = Number(process.env.EXPECT_YAO_PROJECTS ?? "0");
const expected = { admin: 7, caoYihui: 7, yaoKaiheng: expectedYao, huWenhua: 1, external: 0 };
for (const [key, value] of Object.entries(expected)) {
  if (counts[key as keyof typeof counts] !== value) {
    throw new Error(`${key} 项目组数量应为 ${value}，实际为 ${counts[key as keyof typeof counts]}`);
  }
}

console.log(JSON.stringify(counts));
