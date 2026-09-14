function readPublicBaseUrl(): string | null {
  const u = process.env.ASSIGNMENT_WEB_PUBLIC_BASE_URL?.trim();
  if (!u) return null;
  return u.replace(/\/+$/, "");
}

export interface ManagerChatDeepLinkInput {
  threadId?: "main" | string;
  threadKind?: "main" | "side";
  /** Deep-link into Excel draft editor on chat page load. */
  openDraftEditor?: boolean;
}

function appendOpenDraftEditorParam(url: string, openDraftEditor?: boolean): string {
  if (!openDraftEditor) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("openDraftEditor", "1");
  return parsed.toString();
}

/** Collapse accidental `//` in pathname (breaks DingTalk in-app browser with -379). */
export function normalizePublicPageUrl(pageUrl: string): string {
  const parsed = new URL(pageUrl);
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  return parsed.toString();
}

function buildWorkbenchChatPath(input: ManagerChatDeepLinkInput, base: string): string {
  const basePath = base.replace(/\/+$/, "");
  const underWorkbench = basePath.endsWith("/workbench");
  const kind = input.threadKind ?? (input.threadId === "main" || !input.threadId ? "main" : "side");

  if (kind === "main" || input.threadId === "main" || !input.threadId) {
    return underWorkbench
      ? `${basePath}/manager/chat?thread=main`
      : `${basePath}/workbench/manager/chat?thread=main`;
  }

  const threadId = String(input.threadId ?? "").trim();
  if (!threadId) {
    return underWorkbench
      ? `${basePath}/manager/chat?thread=main`
      : `${basePath}/workbench/manager/chat?thread=main`;
  }

  const sideQuery = `thread=side&threadId=${encodeURIComponent(threadId)}`;
  return underWorkbench
    ? `${basePath}/manager/chat?${sideQuery}`
    : `${basePath}/workbench/manager/chat?${sideQuery}`;
}

/** Public workbench chat URL for manager planning assistant. */
export function buildManagerChatDeepLink(input: ManagerChatDeepLinkInput = {}): string | null {
  const base = readPublicBaseUrl();
  if (!base) return null;
  const url = buildWorkbenchChatPath(input, base);
  return normalizePublicPageUrl(appendOpenDraftEditorParam(url, input.openDraftEditor));
}

/** Micro-app homepage path in DingTalk (应用首页), default /workbench. */
function readWorkbenchH5AppHomePath(): string {
  const raw = process.env.WORKBENCH_H5_APP_HOME_PATH?.trim() || "/workbench";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, "") || "/workbench";
}

/**
 * Optional h5_app_open path (only when DINGTALK_WORKBENCH_APPLINK_MODE=h5).
 * Relative to configured micro-app home to avoid `//workbench` join bugs.
 */
export function toH5AppOpenPath(pageUrl: string): string {
  const parsed = new URL(pageUrl);
  const homePath = readWorkbenchH5AppHomePath();
  let rel = parsed.pathname;
  if (homePath !== "/" && rel.startsWith(`${homePath}/`)) {
    rel = rel.slice(homePath.length + 1);
  } else if (rel.startsWith("/")) {
    rel = rel.slice(1);
  }
  return rel ? `${rel}${parsed.search}` : parsed.search.replace(/^\?/, "") || "manager/chat";
}

function readApplinkMode(): "link" | "h5" {
  const raw = String(process.env.DINGTALK_WORKBENCH_APPLINK_MODE ?? "link").trim().toLowerCase();
  return raw === "h5" || raw === "h5_app_open" ? "h5" : "link";
}

/**
 * Wrap a HTTPS workbench URL so DingTalk opens it inside the client, not the system browser.
 * Default: page/link with full normalized URL (reliable). Set DINGTALK_WORKBENCH_APPLINK_MODE=h5 to try h5_app_open.
 */
export function wrapUrlForDingtalkClient(pageUrl: string): string {
  const disabled = String(process.env.DINGTALK_WORKBENCH_APPLINK ?? "1").trim().toLowerCase();
  const normalized = normalizePublicPageUrl(pageUrl);
  if (disabled === "0" || disabled === "false" || disabled === "no") {
    return normalized;
  }

  if (readApplinkMode() === "h5") {
    const corpId =
      process.env.DINGTALK_CORP_ID?.trim() || process.env.DINGTALK_CORP_ID_ALT?.trim() || "";
    const agentId = process.env.DINGTALK_AGENT_ID?.trim() || "";
    if (corpId && agentId) {
      try {
        const params = new URLSearchParams({
          appId: agentId,
          corpId,
          appType: "2",
          path: toH5AppOpenPath(normalized),
        });
        return `https://applink.dingtalk.com/page/h5_app_open?${params.toString()}`;
      } catch {
        // fall through to page/link
      }
    }
  }

  const encoded = encodeURIComponent(normalized);
  return `https://applink.dingtalk.com/page/link?url=${encoded}&target=fullScreen&targetDesktop=workbench`;
}

/** Outbound DingTalk bot markdown link — opens workbench chat inside DingTalk web app. */
export function buildManagerChatDeepLinkForDingtalkOutbound(
  input: ManagerChatDeepLinkInput = {},
): string | null {
  const direct = buildManagerChatDeepLink({ ...input, openDraftEditor: true });
  if (!direct) return null;
  return wrapUrlForDingtalkClient(direct);
}

export function appendWorkbenchChatLinkFooter(markdown: string, link: string | null): string {
  if (!link) return markdown;
  const trimmed = markdown.trim();
  const footer = `\n\n---\n[在工作台继续编辑草案](${link})`;
  return trimmed ? `${trimmed}${footer}` : footer.trimStart();
}

/** Public workbench admin ops dashboard URL. */
export function buildAdminOpsDeepLink(): string | null {
  const base = readPublicBaseUrl();
  if (!base) return null;
  const basePath = base.replace(/\/+$/, "");
  const underWorkbench = basePath.endsWith("/workbench");
  const path = underWorkbench
    ? `${basePath}/admin/ops`
    : `${basePath}/workbench/admin/ops`;
  return normalizePublicPageUrl(path);
}

export function buildAdminOpsDeepLinkForDingtalkOutbound(): string | null {
  const direct = buildAdminOpsDeepLink();
  if (!direct) return null;
  return wrapUrlForDingtalkClient(direct);
}

export function appendAdminOpsLinkFooter(markdown: string, link: string | null): string {
  if (!link) return markdown;
  const trimmed = markdown.trim();
  const footer = `\n\n---\n[打开运营看板（Admin）](${link})`;
  return trimmed ? `${trimmed}${footer}` : footer.trimStart();
}
