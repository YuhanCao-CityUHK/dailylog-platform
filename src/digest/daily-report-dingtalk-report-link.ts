const REPORT_DETAIL_H5 =
  "https://landray.dingtalkapps.com/alid/app/report/viewreport.html";

/** 日志详情在 PC 侧栏打开，避免替换工作台当前页导致无法返回。 */
export function wrapReportUrlForDingtalkSlide(innerUrl: string): string {
  const encoded = encodeURIComponent(innerUrl.trim());
  return `https://applink.dingtalk.com/page/link?url=${encoded}&targetDesktop=slide`;
}

/** 微光 managebot 部署进程的 corpId（DINGTALK_CORP_ID）。 */
export function resolveDailyReportCorpId(): string | undefined {
  return (
    process.env.DAILY_REPORT_WEIGUANG_CORP_ID?.trim()
    || process.env.DINGTALK_CORP_ID?.trim()
    || process.env.DINGTALK_CORP_ID_ALT?.trim()
    || undefined
  );
}

export function buildReportDetailH5Url(input: {
  reportId: string;
  corpId: string;
  creatorUserId?: string;
  createTime?: number;
}): string {
  const params = new URLSearchParams({
    corpid: input.corpId.trim(),
    /** landray viewreport 读 id，不是 reportid（见 we-report getReportDetail） */
    id: input.reportId.trim(),
    comeFromInside: "1",
  });
  const ts = input.createTime;
  if (typeof ts === "number" && ts > 0) {
    params.set("createtime", String(ts));
  }
  return `${REPORT_DETAIL_H5}?${params.toString()}`;
}

/** 钉钉客户端内打开 HTTPS 页（比 openapp 嵌套更稳）。 */
export function buildDingtalkClientPageLink(h5Url: string): string {
  return `dingtalk://dingtalkclient/page/link?url=${encodeURIComponent(h5Url)}`;
}

export interface OpenReportInDingtalkUrls {
  /** 浏览器 / 外开：applink 侧栏 + openapp（带登录态，不关当前页） */
  openInDingtalkUrl: string;
  /** 钉钉 JSAPI openLink 优先：landray HTTPS */
  openInDingtalkH5Url: string;
  /** 钉钉 JSAPI 备选：page/link 协议 */
  openInDingtalkClientLink: string;
  /** dingtalk:// openapp 直达日志容器 */
  openInDingtalkOpenApp: string;
  /** applink 侧栏包装 H5 */
  openInDingtalkApplinkSlide?: string;
  /** applink 侧栏包装 openapp（工作台内首选） */
  openInDingtalkApplinkSlideOpenApp?: string;
}

export function buildOpenAppReportUrl(input: {
  reportId: string;
  corpId: string;
  creatorUserId?: string;
  createTime?: number;
}): string {
  const h5 = buildReportDetailH5Url(input);
  const params = new URLSearchParams({
    corpid: input.corpId.trim(),
    container_type: "work_platform",
    app_id: "2",
    redirect_type: "jump",
    redirect_url: h5,
  });
  return `dingtalk://dingtalkclient/action/openapp?${params.toString()}`;
}

export function buildOpenReportInDingtalkUrls(input: {
  reportId: string;
  corpId: string;
  creatorUserId?: string;
  createTime?: number;
}): OpenReportInDingtalkUrls {
  const h5 = buildReportDetailH5Url(input);
  const openApp = buildOpenAppReportUrl(input);
  const slideOpenApp = wrapReportUrlForDingtalkSlide(openApp);
  const slideH5 = wrapReportUrlForDingtalkSlide(h5);
  return {
    openInDingtalkH5Url: h5,
    openInDingtalkClientLink: buildDingtalkClientPageLink(h5),
    openInDingtalkOpenApp: openApp,
    openInDingtalkApplinkSlide: slideH5,
    openInDingtalkApplinkSlideOpenApp: slideOpenApp,
    openInDingtalkUrl: slideOpenApp,
  };
}

export function buildOpenReportInDingtalkUrl(input: {
  reportId?: string;
  corpId?: string;
  creatorUserId?: string;
}): string | undefined {
  const payload = buildOpenReportInDingtalkPayload(input);
  return payload?.openInDingtalkUrl;
}

/** 下发前端：默认 slide-openapp，侧栏打开且带日志容器登录态。 */
export function buildOpenReportInDingtalkPayload(input: {
  reportId?: string;
  corpId?: string;
  creatorUserId?: string;
  createTime?: number;
}): OpenReportInDingtalkUrls | undefined {
  const reportId = input.reportId?.trim();
  if (!reportId) return undefined;
  const corpId = input.corpId?.trim() || resolveDailyReportCorpId();
  if (!corpId) return undefined;
  const urls = buildOpenReportInDingtalkUrls({
    reportId,
    corpId,
    creatorUserId: input.creatorUserId,
    createTime: input.createTime,
  });
  const mode = process.env.DAILY_REPORT_REPORT_LINK_MODE?.trim().toLowerCase() || "slide-openapp";
  if (mode === "h5") {
    return {
      ...urls,
      openInDingtalkUrl: urls.openInDingtalkApplinkSlide ?? urls.openInDingtalkH5Url,
    };
  }
  if (mode === "openapp") {
    return {
      ...urls,
      openInDingtalkUrl: `https://applink.dingtalk.com/page/link?url=${encodeURIComponent(urls.openInDingtalkOpenApp)}`,
    };
  }
  return urls;
}
