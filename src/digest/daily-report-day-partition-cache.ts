import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveWorkbenchSqlitePath } from "../infra/workbench-db-path";
import type { OrgDigest } from "./daily-report-build";
import type { DailyReportOrgConfig } from "./daily-report-config";
import {
  collectUnifiedDayForOrg,
  type UnifiedDayCollectResult,
} from "./daily-report-unified-day-collect";
import type { UnifiedDayScanMode } from "./daily-report-unified-scan-contacts";
import {
  createProjectViewRosterStore,
  type ProjectViewRosterStore,
} from "./daily-report-project-view-roster-store";
import {
  putProjectViewCache,
  type ProjectViewCacheStore,
} from "./daily-report-project-view-cache";
import { listProjectViewsFromConfig } from "./daily-report-project-views";
import type { ReportTimeRange } from "./daily-report-window";

export type DayPartitionCachePayload = {
  version?: number;
  errors?: OrgDigest["errors"];
  scanContactCount?: number;
  views: Record<string, { submitted: OrgDigest["submitted"]; errors: OrgDigest["errors"] }>;
};

const DAY_PARTITION_CACHE_VERSION = 3;

export interface DayPartitionCacheStore {
  db: DatabaseSync;
  close(): void;
}

interface CacheRow {
  pool_count: number;
  payload_json: string;
  scanned_at: string;
}

function ensureTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_report_day_partition_cache (
      org_label TEXT NOT NULL,
      date_ymd TEXT NOT NULL,
      pool_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY (org_label, date_ymd)
    );
  `);
}

export function createDayPartitionCacheStore(
  dbPath = resolveWorkbenchSqlitePath(),
): DayPartitionCacheStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensureTable(db);
  return {
    db,
    close() {
      db.close();
    },
  };
}

export function getDayPartitionCache(
  orgLabel: string,
  dateYmd: string,
  store: DayPartitionCacheStore,
): { poolCount: number; payload: DayPartitionCachePayload; scannedAt: string } | null {
  const row = store.db
    .prepare(
      `SELECT pool_count, payload_json, scanned_at
       FROM daily_report_day_partition_cache
       WHERE org_label = ? AND date_ymd = ?`,
    )
    .get(orgLabel.trim(), dateYmd.trim()) as CacheRow | undefined;
  if (!row) return null;
  return {
    poolCount: row.pool_count,
    payload: JSON.parse(row.payload_json) as DayPartitionCachePayload,
    scannedAt: row.scanned_at,
  };
}

export function putDayPartitionCache(
  orgLabel: string,
  dateYmd: string,
  poolCount: number,
  payload: DayPartitionCachePayload,
  store: DayPartitionCacheStore,
): void {
  store.db
    .prepare(
      `INSERT INTO daily_report_day_partition_cache (org_label, date_ymd, pool_count, payload_json, scanned_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_label, date_ymd) DO UPDATE SET
         pool_count = excluded.pool_count,
         payload_json = excluded.payload_json,
         scanned_at = excluded.scanned_at`,
    )
    .run(
      orgLabel.trim(),
      dateYmd.trim(),
      poolCount,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
}

export function deleteDayPartitionCache(
  orgLabel: string,
  dateYmd: string,
  store: DayPartitionCacheStore,
): void {
  store.db
    .prepare(
      `DELETE FROM daily_report_day_partition_cache WHERE org_label = ? AND date_ymd = ?`,
    )
    .run(orgLabel.trim(), dateYmd.trim());
}

function payloadFromCollect(result: UnifiedDayCollectResult): DayPartitionCachePayload {
  const views: DayPartitionCachePayload["views"] = {};
  for (const [viewId, digest] of result.byViewId) {
    views[viewId] = { submitted: digest.submitted, errors: digest.errors };
  }
  return {
    version: DAY_PARTITION_CACHE_VERSION,
    views,
    errors: result.errors,
    scanContactCount: result.scanContactCount,
  };
}

export function syncProjectViewCachesFromPartition(
  dateYmd: string,
  result: UnifiedDayCollectResult,
  projectViewCacheStore: ProjectViewCacheStore,
): void {
  for (const [viewId, digest] of result.byViewId) {
    const errors = [...digest.errors, ...result.errors];
    putProjectViewCache(
      viewId,
      dateYmd,
      { submitted: digest.submitted, errors },
      projectViewCacheStore,
    );
  }
}

export async function loadOrCollectUnifiedDay(params: {
  org: DailyReportOrgConfig;
  range: ReportTimeRange;
  refresh?: boolean;
  /** fast=项目 roster 并集快扫（不写 partition 缓存）；full=全员扫描并缓存 */
  scanMode?: UnifiedDayScanMode;
  partitionStore?: DayPartitionCacheStore;
  projectViewCacheStore?: ProjectViewCacheStore;
  rosterStore?: ProjectViewRosterStore;
  ownsPartitionStore?: boolean;
  ownsProjectViewCacheStore?: boolean;
  ownsRosterStore?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  poolCount: number;
  byViewId: Map<string, OrgDigest>;
  errors: OrgDigest["errors"];
  fromCache: boolean;
  scannedAt?: string;
  scanMode?: UnifiedDayScanMode;
  scanContactCount?: number;
}> {
  const partitionStore =
    params.partitionStore ?? createDayPartitionCacheStore();
  const ownsPartitionStore = params.ownsPartitionStore ?? !params.partitionStore;
  const rosterStore = params.rosterStore ?? createProjectViewRosterStore();
  const ownsRosterStore = params.ownsRosterStore ?? !params.rosterStore;
  const projectViewCacheStore = params.projectViewCacheStore;
  const dateYmd = params.range.labelYmd;

  try {
    if (!params.refresh) {
      const cached = getDayPartitionCache(params.org.label, dateYmd, partitionStore);
      if (cached?.payload.version === DAY_PARTITION_CACHE_VERSION) {
        const byViewId = new Map<string, OrgDigest>();
        for (const [viewId, slice] of Object.entries(cached.payload.views)) {
          byViewId.set(viewId, {
            label: params.org.label,
            submitted: slice.submitted,
            missing: [],
            onLeave: [],
            errors: slice.errors,
          });
        }
        return {
          poolCount: cached.poolCount,
          byViewId,
          errors: cached.payload.errors ?? [],
          fromCache: true,
          scannedAt: cached.scannedAt,
          scanMode: "full",
          scanContactCount: cached.payload.scanContactCount,
        };
      }
      if (cached) deleteDayPartitionCache(params.org.label, dateYmd, partitionStore);
    } else {
      deleteDayPartitionCache(params.org.label, dateYmd, partitionStore);
    }

    const scanMode: UnifiedDayScanMode =
      params.scanMode ?? (params.refresh ? "full" : "fast");

    const result = await collectUnifiedDayForOrg(params.org, params.range, {
      fetchImpl: params.fetchImpl,
      scanMode,
      rosterStore,
    });

    const scannedAt = new Date().toISOString();

    if (scanMode === "full") {
      putDayPartitionCache(
        params.org.label,
        dateYmd,
        result.poolCount,
        payloadFromCollect(result),
        partitionStore,
      );
    }

    // Roster fast scans are intentionally incomplete. They can be returned to
    // the caller as a temporary preview, but must never replace the complete
    // day snapshot used by the morning digest and workbench.
    if (projectViewCacheStore && scanMode === "full") {
      syncProjectViewCachesFromPartition(dateYmd, result, projectViewCacheStore);
    }

    return {
      poolCount: result.poolCount,
      byViewId: result.byViewId,
      errors: result.errors,
      fromCache: false,
      scannedAt,
      scanMode,
      scanContactCount: result.scanContactCount,
    };
  } finally {
    if (ownsPartitionStore) partitionStore.close();
    if (ownsRosterStore) rosterStore.close();
  }
}

export function listPartitionViewIdsForOrg(org: DailyReportOrgConfig): string[] {
  return listProjectViewsFromConfig([org]).map((v) => v.id);
}
