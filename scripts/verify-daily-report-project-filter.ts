import assert from "node:assert/strict";
import {
  filterReportEntryByCostProject,
  filterReportEntryByKeyword,
} from "../src/digest/daily-report-project-view-filter";
import { partitionReportEntry } from "../src/digest/daily-report-day-partition";
import type { DailyReportProjectViewConfig } from "../src/digest/daily-report-project-views";
import type { ReportEntry } from "../src/digest/dingtalk-report-client";

const entry = {
  reportId: "report-1",
  creatorUserId: "user-1",
  creatorName: "测试员工",
  templateName: "研发日报",
  createTime: Date.now(),
  contents: [
    { key: "工作模块⑦", value: "CLA 测试" },
    { key: "成本归属项目⑦", value: "项目 Alpha" },
    { key: "事项-结果⑦", value: "完成第七模块验证" },
    { key: "工时统计⑦", value: "2" },
    { key: "工作模块⑧", value: "其它工作" },
    { key: "成本归属项目⑧", value: "项目 Beta" },
    { key: "事项-结果⑧", value: "不应被保留" },
  ],
} satisfies ReportEntry;

const keywordResult = filterReportEntryByKeyword(entry, "cla");
assert.deepEqual(
  keywordResult.contents.map((field) => field.key),
  ["工作模块⑦", "成本归属项目⑦", "事项-结果⑦", "工时统计⑦"],
  "关键词匹配应忽略大小写，并保留第七工作块的全部项目字段",
);

const projectResult = filterReportEntryByCostProject(entry, "alpha");
assert.deepEqual(
  projectResult.contents.map((field) => field.key),
  ["工作模块⑦", "成本归属项目⑦", "事项-结果⑦", "工时统计⑦"],
  "成本项目匹配应忽略大小写，并支持第七至第十工作块",
);

const views = [
  { id: "cla", label: "CLA", viewers: ["director"], filters: { keyword: "CLA" } },
  { id: "others", label: "其他", viewers: ["director"], filters: { role: "others" } },
] satisfies DailyReportProjectViewConfig[];
const partitioned = partitionReportEntry(entry, views);
assert.deepEqual(
  partitioned.byViewId.get("cla")?.[0]?.contents.map((field) => field.key),
  ["工作模块⑦", "成本归属项目⑦", "事项-结果⑦", "工时统计⑦"],
  "命中特定项目的工作块应进入对应项目",
);
assert.deepEqual(
  partitioned.byViewId.get("others")?.[0]?.contents.map((field) => field.key),
  ["工作模块⑧", "成本归属项目⑧", "事项-结果⑧"],
  "未命中特定项目的研发工作块应进入其他",
);

console.log("日报项目筛选校验通过：大小写归一化、模块⑦–⑩及未匹配项目兜底正常。");
