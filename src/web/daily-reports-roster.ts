/**
 * 「日报汇总」名单管理的服务层：搜人（按组织各自应用）/ 列名单 / 增删 / 近 7 天日报校验。
 * 供 assignment-workbench 的 HTTP 接口调用。
 */
import { loadDailyReportDigestConfig } from "../digest/daily-report-config";
import {
  createDingTalkContactDirectory,
  type ContactCandidate,
} from "../digest/dingtalk-contact-search";
import { createDingTalkReportClient } from "../digest/dingtalk-report-client";
import {
  addRosterEmployee,
  listRoster,
  removeRosterEmployee,
  type RosterOrgView,
} from "../digest/daily-report-roster-store";

const RECENT_LOG_DAYS = 7;

const directory = createDingTalkContactDirectory();
const reportClient = createDingTalkReportClient();

interface ResolvedOrgCreds {
  label: string;
  appKey: string;
  appSecret: string;
  templateName?: string;
}

function resolveOrgCreds(orgLabel: string): ResolvedOrgCreds {
  const label = orgLabel.trim();
  if (!label) throw new Error("org 不能为空");
  const { config } = loadDailyReportDigestConfig();
  const org = config.orgs.find((o) => o.label === label);
  if (!org) {
    throw new Error(
      `未找到组织「${label}」（可选：${config.orgs.map((o) => o.label).join(" / ") || "无"}）`,
    );
  }
  if (!org.appKey || !org.appSecret) {
    throw new Error(`组织「${label}」缺少可用的应用凭证`);
  }
  return {
    label: org.label,
    appKey: org.appKey,
    appSecret: org.appSecret,
    templateName: org.templateName,
  };
}

export interface RosterCandidate extends ContactCandidate {
  inRoster: boolean;
}

export interface SearchOrgCandidatesResult {
  org: string;
  candidates: RosterCandidate[];
}

export async function searchOrgCandidates(
  orgLabel: string,
  query: string,
  limit = 20,
): Promise<SearchOrgCandidatesResult> {
  const creds = resolveOrgCreds(orgLabel);
  const rosterIds = new Set(
    (listRoster().find((o) => o.label === creds.label)?.employees ?? []).map(
      (e) => e.userid,
    ),
  );
  const candidates = await directory.search(
    creds.appKey,
    creds.appSecret,
    query,
    limit,
  );
  return {
    org: creds.label,
    candidates: candidates.map((c) => ({ ...c, inRoster: rosterIds.has(c.userid) })),
  };
}

export function getRosterView(): { orgs: RosterOrgView[] } {
  return { orgs: listRoster() };
}

export interface RecentLogValidation {
  userid: string;
  hasRecentLog: boolean;
  count: number;
  templates: string[];
  days: number;
  error?: string;
}

async function probeRecentLog(
  creds: ResolvedOrgCreds,
  userid: string,
): Promise<RecentLogValidation> {
  const end = Date.now();
  const start = end - RECENT_LOG_DAYS * 24 * 60 * 60 * 1000;
  try {
    const reports = await reportClient.fetchUserReports({
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      userid,
      templateName: creds.templateName,
      startTime: start,
      endTime: end,
    });
    const templates = [...new Set(reports.map((r) => r.templateName).filter(Boolean))];
    return {
      userid,
      hasRecentLog: reports.length > 0,
      count: reports.length,
      templates,
      days: RECENT_LOG_DAYS,
    };
  } catch (err) {
    return {
      userid,
      hasRecentLog: false,
      count: 0,
      templates: [],
      days: RECENT_LOG_DAYS,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface AddToRosterResult {
  orgs: RosterOrgView[];
  validation: RecentLogValidation;
}

export async function addToRoster(
  orgLabel: string,
  userid: string,
  name?: string,
): Promise<AddToRosterResult> {
  const creds = resolveOrgCreds(orgLabel);
  const cleanUserid = userid.trim();
  if (!cleanUserid) throw new Error("userid 不能为空");
  const orgs = addRosterEmployee(creds.label, { userid: cleanUserid, name });
  const validation = await probeRecentLog(creds, cleanUserid);
  return { orgs, validation };
}

export function removeFromRoster(
  orgLabel: string,
  userid: string,
): { orgs: RosterOrgView[] } {
  const label = resolveOrgCreds(orgLabel).label;
  return { orgs: removeRosterEmployee(label, userid) };
}
