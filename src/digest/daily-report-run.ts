import { logStructured } from "../infra/logger";
import type { DailyReportDigestConfig } from "./daily-report-config";
import {
  aggregateOrgDigest,
  renderDailyReportMarkdown,
  type OrgDigest,
} from "./daily-report-build";
import {
  createDingTalkReportClient,
  type DingTalkReportClient,
} from "./dingtalk-report-client";
import { sendGroupRobotMarkdown } from "./group-robot-webhook";
import { resolveReportRange, type ReportTimeRange } from "./daily-report-window";
import {
  fallbackMorningSummary,
  loadDailyReportMorningLlmConfig,
  summarizeMorningReportsWithLlm,
} from "./daily-report-morning-llm";
import {
  type DailyWorkbookResult,
  renderMorningReportMarkdown,
  reportEntriesToSheetRows,
} from "./daily-report-morning-build";
import { filterOrgDigestsContents } from "./daily-report-content-filter";
import { applyLeaveToOrgDigests } from "./daily-report-leave";
import { resolveWorkbookParentNodeId } from "./daily-report-doc-archive";
import { createDingTalkWorkbookClient } from "./dingtalk-workbook-client";
import { buildDailyReportsPublicUrlForDingtalkOutbound } from "./daily-report-workbench-link";

export interface RunDailyReportDigestResult {
  ok: boolean;
  skipped?: string;
  labelYmd: string;
  submittedCount: number;
  missingCount: number;
  errorCount: number;
  pushMode?: string;
  workbookCount?: number;
}

export interface CollectOrgDigestsResult {
  orgDigests: OrgDigest[];
  errorCount: number;
}

/**
 * 拉取各组织目标员工在给定时间范围内的日志并按「已交/未交」聚合（不发送）。
 * 调度器/手动发送与工作台页面共用此采集逻辑。
 */
export async function collectOrgDigests(
  config: DailyReportDigestConfig,
  range: ReportTimeRange,
  deps?: { reportClient?: DingTalkReportClient; fetchImpl?: typeof fetch },
): Promise<CollectOrgDigestsResult> {
  const client =
    deps?.reportClient ?? createDingTalkReportClient({ fetchImpl: deps?.fetchImpl });
  const orgDigests: OrgDigest[] = [];
  let errorCount = 0;

  for (const org of config.orgs) {
    const errorsByUserid: Record<string, string> = {};
    const allReports = [];
    for (const emp of org.employees) {
      try {
        const reps = await client.fetchUserReports({
          appKey: org.appKey,
          appSecret: org.appSecret,
          userid: emp.userid,
          templateName: org.templateName,
          startTime: range.startTime,
          endTime: range.endTime,
        });
        allReports.push(...reps);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errorsByUserid[emp.userid] = reason;
        errorCount += 1;
        logStructured({
          event: "daily_report_fetch_failed",
          org: org.label,
          userid: emp.userid,
          reason,
        });
      }
    }
    orgDigests.push(aggregateOrgDigest(org, allReports, errorsByUserid));
  }

  const filtered = filterOrgDigestsContents(orgDigests, config.orgs);
  const withLeave = await applyLeaveToOrgDigests(filtered, config.orgs, range, {
    enabled: config.leaveCheckEnabled,
    fetchImpl: deps?.fetchImpl,
  });

  return { orgDigests: withLeave, errorCount };
}

function sheetNameForEmployee(orgLabel: string, name: string): string {
  const raw = `${orgLabel}·${name}`.replace(/[\\/?*[\]:]/g, "_");
  return raw.slice(0, 31) || name.slice(0, 31);
}

async function createDailyWorkbook(
  config: DailyReportDigestConfig,
  orgDigests: OrgDigest[],
  dateLabel: string,
  deps?: { fetchImpl?: typeof fetch },
): Promise<DailyWorkbookResult | undefined> {
  if (!config.doc) return undefined;
  const deployedKey = process.env.DINGTALK_CLIENT_ID ?? "";
  const deployedSecret = process.env.DINGTALK_CLIENT_SECRET ?? "";
  if (!deployedKey || !deployedSecret) {
    logStructured({ event: "daily_report_workbook_skipped", reason: "no_deployed_credentials" });
    return undefined;
  }

  const employees: Array<{ orgLabel: string; name: string; reports: OrgDigest["submitted"][0]["reports"] }> =
    [];
  for (const org of orgDigests) {
    for (const emp of org.submitted) {
      employees.push({ orgLabel: org.label, name: emp.name, reports: emp.reports });
    }
  }
  if (employees.length === 0) return undefined;

  const wb = createDingTalkWorkbookClient({ fetchImpl: deps?.fetchImpl });
  const workbookTitle = `${dateLabel} 日报汇总`.slice(0, 80);
  const sheetErrors: DailyWorkbookResult["sheetErrors"] = [];

  try {
    let parentNodeId: string | undefined;
    try {
      parentNodeId = await resolveWorkbookParentNodeId({
        doc: config.doc,
        labelYmd: dateLabel,
        stateDir: config.stateDir,
        monthArchive: config.doc.monthArchive,
        appKey: deployedKey,
        appSecret: deployedSecret,
        fetchImpl: deps?.fetchImpl,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logStructured({ event: "daily_report_month_folder_fallback", reason });
      parentNodeId = config.doc.parentNodeId;
    }
    const created = await wb.createWorkbook(
      deployedKey,
      deployedSecret,
      config.doc,
      workbookTitle,
      parentNodeId,
    );
    let sheetCount = 0;

    for (const emp of employees) {
      const sheetName = sheetNameForEmployee(emp.orgLabel, emp.name);
      try {
        const sheet = await wb.createSheet(
          deployedKey,
          deployedSecret,
          config.doc,
          created.workbookId,
          sheetName,
        );
        const rows = reportEntriesToSheetRows(emp.reports);
        await wb.writeSheetValues(
          deployedKey,
          deployedSecret,
          config.doc,
          created.workbookId,
          rows,
          sheet.id,
        );
        try {
          await wb.formatSheetLayout(
            deployedKey,
            deployedSecret,
            config.doc,
            created.workbookId,
            sheet.id,
            rows,
          );
        } catch (fmtErr) {
          logStructured({
            event: "daily_report_sheet_format_failed",
            org: emp.orgLabel,
            name: emp.name,
            reason: fmtErr instanceof Error ? fmtErr.message : String(fmtErr),
          });
        }
        sheetCount += 1;
        logStructured({
          event: "daily_report_sheet_created",
          org: emp.orgLabel,
          name: emp.name,
          workbookId: created.workbookId,
          sheetId: sheet.id,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        sheetErrors.push({ orgLabel: emp.orgLabel, name: emp.name, error: reason });
        logStructured({
          event: "daily_report_sheet_failed",
          org: emp.orgLabel,
          name: emp.name,
          workbookId: created.workbookId,
          reason,
        });
      }
    }

    if (sheetCount > 0) {
      try {
        await wb.deleteSheet(
          deployedKey,
          deployedSecret,
          config.doc,
          created.workbookId,
          "Sheet1",
        );
        logStructured({
          event: "daily_report_sheet1_deleted",
          workbookId: created.workbookId,
        });
      } catch (err) {
        logStructured({
          event: "daily_report_sheet1_delete_failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logStructured({
      event: "daily_report_workbook_created",
      workbookId: created.workbookId,
      sheetCount,
      sheetErrorCount: sheetErrors.length,
    });

    return {
      url: created.url,
      workbookId: created.workbookId,
      name: workbookTitle,
      sheetCount,
      sheetErrors,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logStructured({ event: "daily_report_workbook_failed", reason });
    return {
      url: "",
      name: workbookTitle,
      sheetCount: 0,
      sheetErrors,
      error: reason,
    };
  }
}

async function runMorningDailyReportDigest(
  config: DailyReportDigestConfig,
  orgDigests: OrgDigest[],
  range: ReportTimeRange,
  errorCount: number,
  deps?: { fetchImpl?: typeof fetch; now?: Date },
): Promise<RunDailyReportDigestResult> {
  const dateLabel = `${range.labelDisplay}（${range.labelYmd}）`;
  const llmConfig = loadDailyReportMorningLlmConfig();
  const summary = llmConfig
    ? await summarizeMorningReportsWithLlm(orgDigests, dateLabel, llmConfig, deps?.fetchImpl)
    : fallbackMorningSummary(orgDigests, dateLabel);

  const workbenchUrl = buildDailyReportsPublicUrlForDingtalkOutbound({
    dateYmd: range.labelYmd,
    view: "project",
  });
  const dailyWorkbook = config.createWorkbookOnSend
    ? await createDailyWorkbook(config, orgDigests, range.labelYmd, deps)
    : undefined;
  const rendered = renderMorningReportMarkdown({
    title: config.title,
    dateLabel,
    dateYmd: range.labelYmd,
    summary,
    orgDigests,
    workbenchUrl: workbenchUrl || undefined,
    dailyWorkbook,
  });

  const sendResult = await sendGroupRobotMarkdown(
    config.webhook,
    { title: config.title, text: rendered.text },
    { fetchImpl: deps?.fetchImpl, now: deps?.now },
  );

  if (!sendResult.ok) {
    logStructured({
      event: "daily_report_send_failed",
      labelYmd: range.labelYmd,
      pushMode: "morning",
      errcode: sendResult.errcode,
      errmsg: sendResult.errmsg,
    });
    return {
      ok: false,
      skipped: sendResult.errmsg ?? "send_failed",
      labelYmd: range.labelYmd,
      submittedCount: rendered.submittedCount,
      missingCount: rendered.missingCount,
      errorCount,
      pushMode: "morning",
      workbookCount: dailyWorkbook?.sheetCount ?? 0,
    };
  }

  logStructured({
    event: "daily_report_sent",
    labelYmd: range.labelYmd,
    pushMode: "morning",
    submittedCount: rendered.submittedCount,
    missingCount: rendered.missingCount,
    errorCount,
    workbookCount: dailyWorkbook?.sheetCount ?? 0,
    workbookUrl: dailyWorkbook?.url || undefined,
  });
  return {
    ok: true,
    labelYmd: range.labelYmd,
    submittedCount: rendered.submittedCount,
    missingCount: rendered.missingCount,
    errorCount,
    pushMode: "morning",
    workbookCount: dailyWorkbook?.sheetCount ?? 0,
  };
}

/**
 * 拉取各组织目标员工的昨日日报 → 汇总 → 发到群。
 * pushMode=morning：LLM 早报 + 可选钉钉表格；full：原文 Markdown 拼接。
 */
export async function runDailyReportDigest(
  config: DailyReportDigestConfig,
  deps?: {
    reportClient?: DingTalkReportClient;
    fetchImpl?: typeof fetch;
    now?: Date;
  },
): Promise<RunDailyReportDigestResult> {
  const now = deps?.now ?? new Date();
  const range = resolveReportRange(now, config.timezone, {
    cutoffHour: config.reportDayCutoffHour,
    cutoffMinute: config.reportDayCutoffMinute,
  });
  const { orgDigests, errorCount } = await collectOrgDigests(config, range, {
    reportClient: deps?.reportClient,
    fetchImpl: deps?.fetchImpl,
  });

  if (config.pushMode === "morning") {
    return runMorningDailyReportDigest(config, orgDigests, range, errorCount, deps);
  }

  const rendered = renderDailyReportMarkdown(
    config.title,
    `${range.labelDisplay}（${range.labelYmd}）`,
    orgDigests,
  );

  const sendResult = await sendGroupRobotMarkdown(
    config.webhook,
    { title: config.title, text: rendered.text },
    { fetchImpl: deps?.fetchImpl, now },
  );

  if (!sendResult.ok) {
    logStructured({
      event: "daily_report_send_failed",
      labelYmd: range.labelYmd,
      pushMode: "full",
      errcode: sendResult.errcode,
      errmsg: sendResult.errmsg,
    });
    return {
      ok: false,
      skipped: sendResult.errmsg ?? "send_failed",
      labelYmd: range.labelYmd,
      submittedCount: rendered.submittedCount,
      missingCount: rendered.missingCount,
      errorCount,
      pushMode: "full",
    };
  }

  logStructured({
    event: "daily_report_sent",
    labelYmd: range.labelYmd,
    pushMode: "full",
    submittedCount: rendered.submittedCount,
    missingCount: rendered.missingCount,
    errorCount,
  });
  return {
    ok: true,
    labelYmd: range.labelYmd,
    submittedCount: rendered.submittedCount,
    missingCount: rendered.missingCount,
    errorCount,
    pushMode: "full",
  };
}
