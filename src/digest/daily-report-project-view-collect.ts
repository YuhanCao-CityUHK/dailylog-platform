import type { DailyReportOrgConfig } from "./daily-report-config";
import type { OrgDigest } from "./daily-report-build";
import { filterReportEntry } from "./daily-report-content-filter";
import { filterReportEntryForView } from "./daily-report-project-view-filter";
import {
  createDingTalkReportClient,
  type DingTalkReportClient,
} from "./dingtalk-report-client";
import {
  mapWithConcurrency,
  scanConcurrencyLimit,
} from "./daily-report-project-view-discovery";
import type { ProjectViewRosterMember } from "./daily-report-project-view-roster-store";
import type { DailyReportProjectViewConfig } from "./daily-report-project-views";
import type { ReportTimeRange } from "./daily-report-window";
import { logStructured } from "../infra/logger";

export async function collectProjectViewDigestForRange(
  org: DailyReportOrgConfig,
  view: DailyReportProjectViewConfig,
  range: ReportTimeRange,
  roster: ProjectViewRosterMember[],
  deps?: { reportClient?: DingTalkReportClient; fetchImpl?: typeof fetch },
): Promise<OrgDigest> {
  const client =
    deps?.reportClient ?? createDingTalkReportClient({ fetchImpl: deps?.fetchImpl });
  const submitted: OrgDigest["submitted"] = [];
  const errors: OrgDigest["errors"] = [];
  const concurrency = scanConcurrencyLimit();

  await mapWithConcurrency(roster, concurrency, async (emp) => {
    try {
      const reps = await client.fetchUserReports({
        appKey: org.appKey,
        appSecret: org.appSecret,
        userid: emp.userid,
        templateName: org.templateName,
        startTime: range.startTime,
        endTime: range.endTime,
      });
      const filteredReports = reps
        .map((r) => filterReportEntryForView(r, view.filters))
        .map((r) => filterReportEntry(r))
        .filter((r) => r.contents.length > 0);
      if (filteredReports.length > 0) {
        submitted.push({
          userid: emp.userid,
          name:
            filteredReports[0]?.creatorName?.trim() || emp.name?.trim() || emp.userid,
          reports: filteredReports,
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({
        userid: emp.userid,
        name: emp.name?.trim() || emp.userid,
        reason,
      });
      logStructured({
        event: "daily_report_custom_view_fetch_failed",
        org: org.label,
        viewId: view.id,
        userid: emp.userid,
        reason,
      });
    }
  });

  submitted.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { label: org.label, submitted, missing: [], onLeave: [], errors };
}
