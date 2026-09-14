import { loadDailyReportDigestConfig } from "../src/digest/daily-report-config";
import { resolveDayRangeForYmd, resolveReportRange } from "../src/digest/daily-report-window";
import {
  buildRdDepartmentDigest,
  renderRdDepartmentDigestMarkdown,
} from "../src/digest/rd-department-digest";

const dateYmd = String(process.env.RD_DIGEST_PREVIEW_DATE ?? "").trim();
const { config, errors } = loadDailyReportDigestConfig();
if (errors.length > 0) throw new Error(`日报配置错误：${errors.join("；")}`);
const range = dateYmd
  ? resolveDayRangeForYmd(dateYmd, config.timezone, {
      cutoffHour: config.reportDayCutoffHour,
      cutoffMinute: config.reportDayCutoffMinute,
    })
  : resolveReportRange(new Date(), config.timezone, {
      cutoffHour: config.reportDayCutoffHour,
      cutoffMinute: config.reportDayCutoffMinute,
    });
const digest = await buildRdDepartmentDigest(range, { refresh: true });
const rendered = renderRdDepartmentDigestMarkdown(digest, { preview: true });
console.log(
  JSON.stringify({
    dateYmd: digest.dateYmd,
    departmentSubmitted: digest.departmentSubmitted,
    departmentTotal: digest.departmentTotal,
    platformSubmitted: digest.platformSubmitted,
    platformTotal: digest.platformTotal,
    missingNames: digest.missingNames,
    projects: digest.projects,
    markdown: rendered.markdown,
  }),
);
