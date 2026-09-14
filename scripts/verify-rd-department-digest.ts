import assert from "node:assert/strict";
import {
  mapPlatformItemToProjectViewId,
  renderRdDepartmentDigestMarkdown,
  type RdDepartmentDigestData,
} from "../src/digest/rd-department-digest";
import {
  isRdDepartmentDigestSendWindow,
  listPendingRdDigestRecipients,
} from "../src/digest/rd-department-digest-scheduler";

const views = [
  { id: "semiconductor", label: "半导体", filters: { keyword: "半导体" } },
  { id: "cla", label: "CLA", filters: { keyword: "CLA" } },
  { id: "oct", label: "OCT", filters: { keyword: "OCT" } },
  { id: "shockwave", label: "冲击波", filters: { keyword: "冲击波" } },
  { id: "plaque", label: "斑块减容", filters: { keyword: "斑块减容" } },
  { id: "others", label: "其他", filters: { role: "others" as const } },
  { id: "vein", label: "静脉腔闭合系统", filters: { keyword: "静脉" } },
  { id: "water-hammer", label: "水锤项目", filters: { keyword: "水锤" } },
].map((view) => ({ ...view, viewers: ["cao"], orgLabel: "微光" }));

assert.equal(
  mapPlatformItemToProjectViewId({ aff: "2", affName: "水锤项目" }, views),
  "water-hammer",
);
assert.equal(
  mapPlatformItemToProjectViewId({ aff: "3", affName: "伤口荧光项目" }, views),
  "others",
);
assert.equal(
  mapPlatformItemToProjectViewId({ aff: "dept", affName: "部门日常" }, views),
  "others",
);

const digest: RdDepartmentDigestData = {
  dateYmd: "2026-08-13",
  dateLabel: "8月13日（2026-08-13）",
  departmentDisplayName: "研发部门",
  departmentTotal: 12,
  departmentSubmitted: 10,
  platformTotal: 2,
  platformSubmitted: 1,
  missingNames: ["张三", "李四", "强轩轩"],
  projects: views.map((view, index) => ({
    viewId: view.id,
    label: view.label,
    peopleCount: index === 7 ? 1 : 0,
    hours: index === 7 ? 8 : 0,
    summary: index === 7 ? "完成水锤关键战役时间节点分解。" : "暂无相关记录",
  })),
  distinctSubmittedCount: 11,
  projectPersonTimes: 1,
  totalHours: 8,
  detailUrl: "https://dailylog.vivolightsales.com/workbench/daily-reports",
};
const rendered = renderRdDepartmentDigestMarkdown(digest, { preview: true });
assert.equal(rendered.title, "研发部门 · 昨日项目日报");
assert.match(rendered.markdown, /水锤项目/);
assert.match(rendered.markdown, /张三、李四、强轩轩/);
assert.match(rendered.markdown, /8个项目/);
assert.match(rendered.markdown, /模拟预览/);

assert.equal(isRdDepartmentDigestSendWindow(new Date("2026-08-15T07:02:00+08:00"), 7, 0), true);
assert.equal(isRdDepartmentDigestSendWindow(new Date("2026-08-16T07:02:00+08:00"), 7, 0), true);
assert.equal(isRdDepartmentDigestSendWindow(new Date("2026-08-16T07:05:00+08:00"), 7, 0), false);
assert.deepEqual(
  listPendingRdDigestRecipients(["cao", "yang", "cao"], (userId) => userId === "cao"),
  ["yang"],
);

console.log(JSON.stringify({ ok: true, checks: 11 }));
