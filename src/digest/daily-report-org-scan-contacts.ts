import type { DailyReportOrgConfig } from "./daily-report-config";
import {
  createDingTalkContactDirectory,
  type DingTalkContactDirectory,
} from "./dingtalk-contact-search";

const BOT_NAME_RE = /机器人|T-/;

/** 微光 org_all 扫描默认上限（钉钉通讯录枚举）。 */
const ORG_SCAN_CONTACT_LIMIT = 5000;

export function isBotLikeContactName(name: string): boolean {
  return BOT_NAME_RE.test(name.trim());
}

/**
 * 按**指定组织**（微光 appKey/appSecret）从钉钉通讯录枚举可扫描员工。
 * 不用本地 SQLite：mingsibot 实例上的 workbench.sqlite 未必同步微光全员。
 */
export async function listOrgScanContacts(
  org: Pick<DailyReportOrgConfig, "appKey" | "appSecret" | "label">,
  deps?: {
    directory?: DingTalkContactDirectory;
    limit?: number;
  },
): Promise<Array<{ userid: string; name: string }>> {
  if (!org.appKey?.trim() || !org.appSecret?.trim()) {
    throw new Error(`组织「${org.label}」缺少 appKey/appSecret，无法枚举通讯录`);
  }
  const directory = deps?.directory ?? createDingTalkContactDirectory();
  const limit = deps?.limit ?? ORG_SCAN_CONTACT_LIMIT;
  const users = await directory.listAll(org.appKey, org.appSecret, limit);
  return users
    .filter((u) => !isBotLikeContactName(u.name))
    .map((u) => ({ userid: u.userid, name: u.name.trim() || u.userid }));
}
