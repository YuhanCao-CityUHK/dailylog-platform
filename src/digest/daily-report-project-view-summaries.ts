import type { OrgDigest } from "./daily-report-build";
import {
  fallbackCtoRollupOverviewSummary,
  loadDailyReportMorningLlmConfig,
  summarizeProjectViewMorningForCtoRollup,
} from "./daily-report-project-view-morning-llm";
import {
  getProjectViewCache,
  putProjectViewCache,
  type ProjectViewCacheStore,
} from "./daily-report-project-view-cache";

/** 每 (viewId, dateYmd) 只调一次 CTO plain text LLM，结果写入 cache。 */
export async function ensureProjectViewCtoOverview(input: {
  viewId: string;
  viewLabel: string;
  dateYmd: string;
  dateLabel: string;
  rosterCount: number;
  orgDigest: OrgDigest;
  cacheStore: ProjectViewCacheStore;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
}): Promise<string> {
  if (!input.refresh) {
    const cached = getProjectViewCache(input.viewId, input.dateYmd, input.cacheStore);
    const existing = cached?.payload.ctoOverview?.trim();
    if (existing) return existing;
  }

  const llmConfig = loadDailyReportMorningLlmConfig();
  let overview: string;
  if (llmConfig?.enabled) {
    const summary = await summarizeProjectViewMorningForCtoRollup(
      input.viewLabel,
      input.dateLabel,
      input.rosterCount,
      input.orgDigest,
      llmConfig,
      input.fetchImpl,
    );
    overview = summary.overview;
  } else {
    overview = fallbackCtoRollupOverviewSummary(
      input.viewLabel,
      input.rosterCount,
      input.orgDigest,
    ).overview;
  }

  const cached = getProjectViewCache(input.viewId, input.dateYmd, input.cacheStore);
  if (cached) {
    putProjectViewCache(
      input.viewId,
      input.dateYmd,
      {
        ...cached.payload,
        ctoOverview: overview,
        ctoOverviewGeneratedAt: new Date().toISOString(),
      },
      input.cacheStore,
    );
  }

  return overview;
}
