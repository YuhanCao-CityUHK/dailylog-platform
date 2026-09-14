/**
 * 钉钉「日志」(OA 日报/汇报) 读取客户端。
 *
 * - access_token: 每个组织独立的企业内部应用凭证（appKey/appSecret），按 appKey 缓存。
 *   端点 https://api.dingtalk.com/v1.0/oauth2/accessToken 返回的 token 同时适用于
 *   oapi.dingtalk.com 的 topapi/* 调用。
 * - 日志列表: POST https://oapi.dingtalk.com/topapi/report/list?access_token=...
 *   需应用申请「查询企业员工日志权限」。size 上限 20，cursor 游标分页。
 */
import {
  REPORT_ATTACHMENT_FIELD_TYPE,
  type ReportAttachment,
  parseAttachmentsFromValue,
  parseReportImages,
} from "./daily-report-attachments";
import { withDingTalkRateLimitRetry } from "./dingtalk-rate-limit-retry";

export type { ReportAttachment };

export interface ReportContentField {
  key: string;
  value: string;
  /** 钉钉 contents.type，如 9=附件 */
  type?: string;
  attachments?: ReportAttachment[];
}

export interface ReportEntry {
  reportId?: string;
  creatorUserId: string;
  creatorName: string;
  templateName: string;
  /** 日志创建时间，Unix 毫秒 */
  createTime: number;
  contents: ReportContentField[];
  /** 日志顶层图片列表（report/list images） */
  images?: ReportAttachment[];
}

export interface FetchUserReportsParams {
  appKey: string;
  appSecret: string;
  userid: string;
  /** 留空=不按模板过滤 */
  templateName?: string;
  /** Unix 毫秒 */
  startTime: number;
  /** Unix 毫秒 */
  endTime: number;
}

interface AccessTokenResp {
  accessToken?: string;
  access_token?: string;
  errcode?: number;
  errmsg?: string;
}

interface ReportListResp {
  errcode?: number;
  errmsg?: string;
  result?: {
    data_list?: Array<Record<string, unknown>>;
    next_cursor?: number;
    has_more?: boolean;
    size?: number;
  };
}

const PAGE_SIZE = 20;
const MAX_PAGES = 50; // 安全上限，避免异常分页死循环
const TOKEN_EARLY_REFRESH_MS = 30_000;

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function normalizeContents(raw: unknown): ReportContentField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const type = asString(o.type) || undefined;
      const key = asString(o.key).trim();
      const value = asString(o.value).trim();
      let attachments = undefined as ReportContentField["attachments"];
      if (type === REPORT_ATTACHMENT_FIELD_TYPE || key.includes("附件")) {
        attachments = parseAttachmentsFromValue(value);
      }
      return { key, value, type, attachments };
    })
    .filter((f) => f.key.length > 0 || f.value.length > 0 || (f.attachments?.length ?? 0) > 0);
}

function normalizeEntry(raw: Record<string, unknown>): ReportEntry {
  return {
    reportId: asString(raw.report_id) || undefined,
    creatorUserId: asString(raw.creator_id ?? raw.creator_userid ?? raw.userid),
    creatorName: asString(raw.creator_name ?? raw.creatorName),
    templateName: asString(raw.template_name ?? raw.templateName),
    createTime: Number(raw.create_time ?? raw.createTime ?? 0) || 0,
    contents: normalizeContents(raw.contents),
    images: parseReportImages(raw.images),
  };
}

export function createDingTalkReportClient(opts?: { fetchImpl?: typeof fetch }) {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const tokenCache = new Map<string, { token: string; expiresAt: number }>();

  async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
    if (!appKey || !appSecret) {
      throw new Error("appKey / appSecret is required");
    }
    const cached = tokenCache.get(appKey);
    if (cached && cached.expiresAt - TOKEN_EARLY_REFRESH_MS > Date.now()) {
      return cached.token;
    }
    const res = await fetchImpl("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey, appSecret }),
    });
    const data = (await res.json().catch(() => ({}))) as AccessTokenResp & { expireIn?: number };
    if (!res.ok || (typeof data.errcode === "number" && data.errcode !== 0)) {
      throw new Error(`getAccessToken failed: ${res.status} ${JSON.stringify(data)}`);
    }
    const token = String(data.accessToken ?? data.access_token ?? "").trim();
    if (!token) throw new Error("access token missing");
    const expireInSec = Number(data.expireIn ?? 7200) || 7200;
    tokenCache.set(appKey, { token, expiresAt: Date.now() + expireInSec * 1000 });
    return token;
  }

  async function fetchUserReports(params: FetchUserReportsParams): Promise<ReportEntry[]> {
    const token = await getAccessToken(params.appKey, params.appSecret);
    const entries: ReportEntry[] = [];
    let cursor = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        start_time: params.startTime,
        end_time: params.endTime,
        cursor,
        size: PAGE_SIZE,
        userid: params.userid,
      };
      if (params.templateName) body.template_name = params.templateName;

      const data = await withDingTalkRateLimitRetry(async () => {
        const res = await fetchImpl(
          `https://oapi.dingtalk.com/topapi/report/list?access_token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const data = (await res.json().catch(() => ({}))) as ReportListResp;
        if (!res.ok || (typeof data.errcode === "number" && data.errcode !== 0)) {
          throw new Error(
            `report/list failed (userid=${params.userid}): ${res.status} ${JSON.stringify({
              errcode: data.errcode,
              errmsg: data.errmsg,
            })}`,
          );
        }
        return data;
      });
      const list = data.result?.data_list ?? [];
      for (const item of list) entries.push(normalizeEntry(item));

      const hasMore = Boolean(data.result?.has_more);
      const nextCursor = Number(data.result?.next_cursor ?? 0);
      if (!hasMore || list.length === 0) break;
      if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    return entries;
  }

  return { getAccessToken, fetchUserReports };
}

export type DingTalkReportClient = ReturnType<typeof createDingTalkReportClient>;
