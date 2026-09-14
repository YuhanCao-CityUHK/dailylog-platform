import type { OrgDigest } from "./daily-report-build";
import type { DailyReportOrgConfig } from "./daily-report-config";
import { filterReportEntryByProject } from "./daily-report-project-filter";
import { fieldHasDisplayBody, reportHasDisplayBody } from "./daily-report-attachments";
import type { ReportContentField, ReportEntry } from "./dingtalk-report-client";

/** 保留 value 非空或含附件的工作模块。 */
export function filterReportContentsWithBody(
  contents: ReportContentField[],
): ReportContentField[] {
  return contents.filter(fieldHasDisplayBody);
}

export function filterReportEntry(entry: ReportEntry): ReportEntry {
  const contents = filterReportContentsWithBody(entry.contents);
  if (!reportHasDisplayBody({ ...entry, contents })) {
    return { ...entry, contents: [] };
  }
  if (contents.length === entry.contents.length) return entry;
  return { ...entry, contents };
}

function applyReportEntryFilters(
  entry: ReportEntry,
  projectFilters?: string[],
): ReportEntry {
  let next = entry;
  if (projectFilters && projectFilters.length > 0) {
    next = filterReportEntryByProject(next, projectFilters);
  }
  return filterReportEntry(next);
}

export function filterOrgDigestsContents(
  orgDigests: OrgDigest[],
  orgConfigs?: DailyReportOrgConfig[],
): OrgDigest[] {
  const projectFilterByLabel = new Map<string, string[]>();
  for (const org of orgConfigs ?? []) {
    if (org.projectFilter && org.projectFilter.length > 0) {
      projectFilterByLabel.set(org.label, org.projectFilter);
    }
  }

  return orgDigests.map((org) => ({
    ...org,
    submitted: org.submitted.map((emp) => ({
      ...emp,
      reports: emp.reports
        .map((r) => applyReportEntryFilters(r, projectFilterByLabel.get(org.label)))
        .filter(reportHasDisplayBody),
    })),
  }));
}
