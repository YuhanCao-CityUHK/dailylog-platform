import type { DailyReportOrgConfig } from "./daily-report-config";
import { listOrgScanContacts } from "./daily-report-org-scan-contacts";
import {
  listProjectViewRoster,
  type ProjectViewRosterStore,
} from "./daily-report-project-view-roster-store";
import {
  isOthersProjectView,
  type DailyReportProjectViewConfig,
} from "./daily-report-project-views";

export type UnifiedDayScanMode = "fast" | "full";

export interface ScanContact {
  userid: string;
  name: string;
}

/** 各项目视图 roster 并集（不含「其他」）；用于页面快扫。 */
export function listRosterUnionContacts(
  orgLabel: string,
  projectViews: Array<DailyReportProjectViewConfig & { orgLabel: string }>,
  rosterStore: ProjectViewRosterStore,
): ScanContact[] {
  const byUserid = new Map<string, string>();
  for (const view of projectViews) {
    if (view.orgLabel !== orgLabel || isOthersProjectView(view)) continue;
    for (const member of listProjectViewRoster(view.id, rosterStore)) {
      const uid = member.userid.trim();
      if (!uid || byUserid.has(uid)) continue;
      byUserid.set(uid, member.name?.trim() || uid);
    }
  }
  return [...byUserid.entries()].map(([userid, name]) => ({ userid, name }));
}

export async function resolveUnifiedScanContacts(params: {
  org: DailyReportOrgConfig;
  projectViews: Array<DailyReportProjectViewConfig & { orgLabel: string }>;
  scanMode: UnifiedDayScanMode;
  rosterStore?: ProjectViewRosterStore;
}): Promise<ScanContact[]> {
  if (params.scanMode === "fast" && params.rosterStore) {
    const union = listRosterUnionContacts(
      params.org.label,
      params.projectViews,
      params.rosterStore,
    );
    if (union.length > 0) return union;
  }
  return listOrgScanContacts(params.org);
}
