import type { DailyReportOrgConfig } from "./daily-report-config";
import { filterReportContentsWithBody } from "./daily-report-content-filter";
import {
  formatAttachmentSummary,
  formatFieldDisplayValue,
} from "./daily-report-attachments";
import type { ReportEntry } from "./dingtalk-report-client";

export interface EmployeeReports {
  userid: string;
  name: string;
  reports: ReportEntry[];
}

export interface OrgDigest {
  label: string;
  submitted: EmployeeReports[];
  missing: Array<{ userid: string; name: string }>;
  /** 未交但业务日内有钉钉全天请假记录的员工 */
  onLeave?: Array<{ userid: string; name: string }>;
  /** 拉取该组织日志时发生的错误（按 userid 记录），用于群消息脚注提示 */
  errors: Array<{ userid: string; name: string; reason: string }>;
}

export interface DailyReportDigestResult {
  title: string;
  text: string;
  submittedCount: number;
  missingCount: number;
}

/**
 * 把某组织拉到的日志按目标员工聚合为「已交/未交」。纯函数，便于测试。
 * reports 应为该组织目标员工范围内的日志（客户端按 userid 拉取）。
 */
export function aggregateOrgDigest(
  org: DailyReportOrgConfig,
  reports: ReportEntry[],
  errorsByUserid?: Record<string, string>,
): OrgDigest {
  const byUser = new Map<string, ReportEntry[]>();
  for (const r of reports) {
    const list = byUser.get(r.creatorUserId) ?? [];
    list.push(r);
    byUser.set(r.creatorUserId, list);
  }

  const submitted: EmployeeReports[] = [];
  const missing: Array<{ userid: string; name: string }> = [];
  const errors: Array<{ userid: string; name: string; reason: string }> = [];

  for (const emp of org.employees) {
    const empName = emp.name?.trim();
    const reportsForUser = byUser.get(emp.userid) ?? [];
    const resolvedName =
      reportsForUser[0]?.creatorName?.trim() || empName || emp.userid;
    const err = errorsByUserid?.[emp.userid];
    if (err) {
      errors.push({ userid: emp.userid, name: empName || emp.userid, reason: err });
    }
    if (reportsForUser.length > 0) {
      // 按创建时间升序，便于阅读
      reportsForUser.sort((a, b) => a.createTime - b.createTime);
      submitted.push({ userid: emp.userid, name: resolvedName, reports: reportsForUser });
    } else if (!err) {
      missing.push({ userid: emp.userid, name: empName || emp.userid });
    }
  }

  return { label: org.label, submitted, missing, onLeave: [], errors };
}

function renderReportBody(report: ReportEntry): string {
  const lines: string[] = [];
  for (const field of filterReportContentsWithBody(report.contents)) {
    const key = field.key.trim();
    const display = formatFieldDisplayValue(field);
    if (key) {
      lines.push(`- **${key}**：${display}`);
    } else {
      lines.push(`- ${display}`);
    }
  }
  if ((report.images?.length ?? 0) > 0) {
    lines.push(`- **图片**：${formatAttachmentSummary(report.images!)}`);
  }
  if (lines.length === 0) lines.push("- （无内容）");
  return lines.join("\n");
}

/**
 * 渲染最终群消息 Markdown（原文汇总转发）。纯函数，便于测试。
 */
export function renderDailyReportMarkdown(
  title: string,
  dateLabel: string,
  orgDigests: OrgDigest[],
): DailyReportDigestResult {
  let submittedCount = 0;
  let missingCount = 0;
  const parts: string[] = [];
  parts.push(`## ${title}`);
  parts.push(`> 汇总日期：${dateLabel}`);

  for (const org of orgDigests) {
    submittedCount += org.submitted.length;
    missingCount += org.missing.length;
    parts.push("");
    parts.push("---");
    parts.push(
      `### ${org.label}　已交 ${org.submitted.length} ／ 未交 ${org.missing.length}`,
    );

    if (org.submitted.length > 0) {
      for (const emp of org.submitted) {
        parts.push("");
        const multi = emp.reports.length > 1 ? `（${emp.reports.length} 篇）` : "";
        parts.push(`**${emp.name}**${multi}`);
        emp.reports.forEach((report, idx) => {
          if (emp.reports.length > 1) {
            const tmpl = report.templateName ? `${report.templateName}` : `日志 ${idx + 1}`;
            parts.push(`*${tmpl}*`);
          }
          parts.push(renderReportBody(report));
        });
      }
    }

    if (org.missing.length > 0) {
      parts.push("");
      const names = org.missing.map((m) => m.name).join("、");
      parts.push(`**未提交（${org.missing.length}）**：${names}`);
    }

    const onLeave = org.onLeave ?? [];
    if (onLeave.length > 0) {
      parts.push("");
      const names = onLeave.map((m) => m.name).join("、");
      parts.push(`**请假（${onLeave.length}）**：${names}`);
    }

    if (org.errors.length > 0) {
      parts.push("");
      const names = org.errors.map((e) => e.name).join("、");
      parts.push(`> ⚠️ 以下成员日志读取失败，未纳入统计：${names}`);
    }
  }

  return {
    title,
    text: parts.join("\n"),
    submittedCount,
    missingCount,
  };
}
