/** 钉钉服务端：access_token 缓存、免登 code 换 userid、用户详情、工作通知（提醒用）。 */
import { CONFIG } from "../infra/config";
import { logStructured } from "../infra/logger";

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getDingTalkAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - 30_000 > Date.now()) return tokenCache.token;
  const res = await fetchImpl("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: CONFIG.dingtalk.clientId, appSecret: CONFIG.dingtalk.clientSecret }),
  });
  const data = (await res.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number };
  const token = String(data.accessToken ?? "").trim();
  if (!res.ok || !token) {
    throw new Error(`钉钉 accessToken 获取失败：${res.status} ${JSON.stringify(data)}`);
  }
  tokenCache = { token, expiresAt: Date.now() + (Number(data.expireIn ?? 7200) || 7200) * 1000 };
  return token;
}

export interface DdUserInfo {
  userid: string;
  name: string;
  title: string;
  dept: string;
  departments: Array<{ id: number; name: string; isManager: boolean }>;
  organizationResolved: boolean;
}

async function fetchDepartmentName(deptId: number, token: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(
    `https://oapi.dingtalk.com/topapi/v2/department/get?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dept_id: deptId, language: "zh_CN" }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as { errcode?: number; result?: { name?: string } };
  return res.ok && data.errcode === 0 ? String(data.result?.name ?? "").trim() : "";
}

/** 免登：H5 jsapi requestAuthCode 的 code → userid。 */
export async function resolveUseridByAuthCode(code: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = await getDingTalkAccessToken(fetchImpl);
  const res = await fetchImpl(
    `https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    errcode?: number;
    errmsg?: string;
    result?: { userid?: string };
  };
  if (!res.ok || data.errcode !== 0 || !data.result?.userid) {
    throw new Error(`免登 code 校验失败：${JSON.stringify({ errcode: data.errcode, errmsg: data.errmsg })}`);
  }
  return String(data.result.userid);
}

export async function fetchDdUserDetail(userid: string, fetchImpl: typeof fetch = fetch): Promise<DdUserInfo> {
  const token = await getDingTalkAccessToken(fetchImpl);
  const res = await fetchImpl(
    `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userid, language: "zh_CN" }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    errcode?: number;
    result?: {
      name?: string;
      title?: string;
      dept_id_list?: number[];
      leader_in_dept?: Array<{ dept_id?: number; leader?: boolean | string | number }>;
    };
  };
  if (!res.ok || data.errcode !== 0) {
    logStructured({ evt: "dd_user_get_failed", userid, data });
    return { userid, name: userid, title: "", dept: "", departments: [], organizationResolved: false };
  }
  const deptIds = [...new Set((data.result?.dept_id_list ?? []).map(Number).filter(Number.isSafeInteger))].slice(0, 20);
  const leaderIds = new Set(
    (data.result?.leader_in_dept ?? [])
      .filter((item) => item.leader === true || item.leader === "true" || item.leader === 1 || item.leader === "1")
      .map((item) => Number(item.dept_id))
      .filter(Number.isSafeInteger),
  );
  const names = await Promise.all(deptIds.map((deptId) => fetchDepartmentName(deptId, token, fetchImpl)));
  const departments = deptIds
    .map((id, index) => ({ id, name: names[index], isManager: leaderIds.has(id) }))
    .filter((item) => item.name);
  return {
    userid,
    name: String(data.result?.name ?? userid),
    title: String(data.result?.title ?? ""),
    dept: departments[0]?.name ?? "",
    departments,
    organizationResolved: true,
  };
}

/** 工作通知（9:00 未提交提醒）。需要 DINGTALK_AGENT_ID。 */
export async function sendWorkNotice(
  userids: string[],
  markdownTitle: string,
  markdownText: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!CONFIG.dingtalk.agentId || userids.length === 0) return;
  const token = await getDingTalkAccessToken(fetchImpl);
  const res = await fetchImpl(
    `https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: Number(CONFIG.dingtalk.agentId),
        userid_list: userids.join(","),
        msg: { msgtype: "markdown", markdown: { title: markdownTitle, text: markdownText } },
      }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
  if (data.errcode !== 0) {
    logStructured({ evt: "dd_work_notice_failed", errcode: data.errcode, errmsg: data.errmsg });
  }
}

/** 钉钉应用机器人单聊 ActionCard。robotCode 默认就是应用 Client ID。 */
export async function sendRobotActionCard(
  params: {
    userId: string;
    title: string;
    markdown: string;
    detailUrl: string;
    singleTitle?: string;
    robotCode?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const userId = params.userId.trim();
  const robotCode = params.robotCode?.trim() || CONFIG.dingtalk.clientId;
  if (!userId) throw new Error("DingTalk robot userId is required");
  if (!robotCode) throw new Error("DingTalk robotCode is required");
  const token = await getDingTalkAccessToken(fetchImpl);
  const res = await fetchImpl("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify({
      robotCode,
      userIds: [userId],
      msgKey: "sampleActionCard",
      msgParam: JSON.stringify({
        title: params.title,
        text: params.markdown,
        singleTitle: params.singleTitle?.trim() || "打开工作台 · 全部项目",
        singleURL: params.detailUrl,
      }),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`DingTalk robot send failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return String(data.processQueryKey ?? data.requestId ?? "");
}
