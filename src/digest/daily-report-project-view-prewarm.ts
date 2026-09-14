import { logStructured } from "../infra/logger";
import {
  loadDailyReportDigestConfig,
  type DailyReportDigestConfig,
} from "./daily-report-config";
import {
  createDayPartitionCacheStore,
  loadOrCollectUnifiedDay,
  type DayPartitionCacheStore,
} from "./daily-report-day-partition-cache";
import {
  createProjectViewCacheStore,
  putProjectViewCache,
  type ProjectViewCacheStore,
} from "./daily-report-project-view-cache";
import { ensureProjectViewCtoOverview } from "./daily-report-project-view-summaries";
import {
  isProjectViewDigestEnabledForView,
  listProjectViewsFromConfig,
} from "./daily-report-project-views";
import { resolveReportRange } from "./daily-report-window";
import { getLocalTimeParts } from "../infra/reminder-policy";
import { isDailyReportProjectViewsEnabled } from "./daily-report-project-view-flag";

function envInt(name: string, defaultValue: number): number {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

function readPrewarmHour(): number {
  return envInt("DAILY_REPORT_PROJECT_VIEW_PREWARM_HOUR", 6);
}

function readPrewarmMinute(): number {
  return envInt("DAILY_REPORT_PROJECT_VIEW_PREWARM_MINUTE", 45);
}

const PREWARM_WINDOW_MINUTES = 5;

export interface DailyReportProjectViewPrewarmDeps {
  config?: DailyReportDigestConfig;
  partitionStore?: DayPartitionCacheStore;
  cacheStore?: ProjectViewCacheStore;
  fetchImpl?: typeof fetch;
  prewarmSummaries?: boolean;
}

export function isProjectViewPrewarmWindow(
  now: Date,
  config: Pick<DailyReportDigestConfig, "timezone">,
): boolean {
  const { weekday, hour, minute } = getLocalTimeParts(now, config.timezone);
  if (weekday === 0 || weekday === 1) return false;
  const prewarmHour = readPrewarmHour();
  const prewarmMinute = readPrewarmMinute();
  if (hour !== prewarmHour) return false;
  return minute >= prewarmMinute && minute < prewarmMinute + PREWARM_WINDOW_MINUTES;
}

function envPrewarmSummariesEnabled(): boolean {
  const raw = String(process.env.DAILY_REPORT_PROJECT_VIEW_PREWARM_SUMMARIES ?? "1")
    .trim()
    .toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function createDailyReportProjectViewPrewarmScheduler(
  deps?: DailyReportProjectViewPrewarmDeps,
) {
  const loadConfig = () => deps?.config ?? loadDailyReportDigestConfig().config;
  const partitionStore = deps?.partitionStore ?? createDayPartitionCacheStore();
  const cacheStore = deps?.cacheStore ?? createProjectViewCacheStore();
  const ownsPartitionStore = !deps?.partitionStore;
  const ownsCacheStore = !deps?.cacheStore;
  const prewarmSummaries = deps?.prewarmSummaries ?? envPrewarmSummariesEnabled();
  let timer: NodeJS.Timeout | undefined;
  let scanning = false;

  async function warmOrgViewsForRange(
    org: (ReturnType<typeof loadConfig>)["orgs"][number],
    orgViews: ReturnType<typeof listProjectViewsFromConfig>,
    range: ReturnType<typeof resolveReportRange>,
  ): Promise<void> {
    const dateLabel = `${range.labelDisplay}（${range.labelYmd}）`;
    const unified = await loadOrCollectUnifiedDay({
      org,
      range,
      scanMode: "full",
      partitionStore,
      projectViewCacheStore: cacheStore,
      ownsPartitionStore: false,
      ownsProjectViewCacheStore: false,
      fetchImpl: deps?.fetchImpl,
    });

    for (const view of orgViews) {
      const digest = unified.byViewId.get(view.id);
      if (!digest) continue;

      if (prewarmSummaries && isProjectViewDigestEnabledForView(view)) {
        await ensureProjectViewCtoOverview({
          viewId: view.id,
          viewLabel: view.label,
          dateYmd: range.labelYmd,
          dateLabel,
          rosterCount: unified.poolCount,
          orgDigest: digest,
          cacheStore,
          fetchImpl: deps?.fetchImpl,
        });
      }
    }
  }

  async function runPrewarm(now: Date = new Date()): Promise<void> {
    if (scanning) return;
    if (!isDailyReportProjectViewsEnabled()) return;
    const config = loadConfig();
    const views = listProjectViewsFromConfig(config.orgs);
    if (!config.orgs.length) return;
    if (!isProjectViewPrewarmWindow(now, config)) return;

    scanning = true;
    try {
      const range = resolveReportRange(now, config.timezone, {
        cutoffHour: config.reportDayCutoffHour,
        cutoffMinute: config.reportDayCutoffMinute,
      });

      for (const org of config.orgs) {
        const orgViews = views.filter((v) => v.orgLabel === org.label);
        await warmOrgViewsForRange(org, orgViews, range);
      }

      logStructured({
        event: "daily_report_project_view_prewarm_done",
        labelYmd: range.labelYmd,
        viewCount: views.length,
        prewarmSummaries,
        mode: "unified_partition",
      });
    } catch (err) {
      logStructured({
        event: "daily_report_project_view_prewarm_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      scanning = false;
    }
  }

  async function bootstrapOnStartup(): Promise<void> {
    if (!isDailyReportProjectViewsEnabled()) return;
    const config = loadConfig();
    const views = listProjectViewsFromConfig(config.orgs);
    if (!config.orgs.length) return;
    const range = resolveReportRange(new Date(), config.timezone, {
      cutoffHour: config.reportDayCutoffHour,
      cutoffMinute: config.reportDayCutoffMinute,
    });
    void (async () => {
      try {
        for (const org of config.orgs) {
          const orgViews = views.filter((v) => v.orgLabel === org.label);
          await warmOrgViewsForRange(org, orgViews, range);
        }
        logStructured({
          event: "daily_report_project_view_startup_prewarm_done",
          labelYmd: range.labelYmd,
          prewarmSummaries,
        });
      } catch (err) {
        logStructured({
          event: "daily_report_project_view_startup_prewarm_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  function startIntervalLoop(): void {
    if (!isDailyReportProjectViewsEnabled()) return;
    const config = loadConfig();
    if (!config.orgs.length) return;
    if (timer) return;
    void runPrewarm().catch(() => undefined);
    timer = setInterval(() => {
      void runPrewarm().catch(() => undefined);
    }, config.scanIntervalMs);
  }

  function stopIntervalLoop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  function close(): void {
    stopIntervalLoop();
    if (ownsPartitionStore) partitionStore.close();
    if (ownsCacheStore) cacheStore.close();
  }

  return {
    runPrewarm,
    bootstrapOnStartup,
    startIntervalLoop,
    stopIntervalLoop,
    close,
  };
}
