/**
 * 日报汇总页外壳（新平台版）：提供与原任务工作台 renderWorkbenchPage 兼容的接口，
 * 保持日报汇总页内容与原版一致（CSS token 取自原工作台 :root），外框换成新平台顶栏。
 */
export type WorkbenchShellRole = "manager" | "employee" | "admin";
export type WorkbenchNavId = "daily-reports" | string;

const SHELL_CSS = `
:root {
  --bg: #f1f5f9; --surface: #ffffff; --border: #e2e8f0; --text: #0f172a; --muted: #64748b;
  --primary: #2563eb; --primary-hover: #1d4ed8; --primary-soft: #eff6ff;
  --danger: #dc2626; --success: #059669; --warn: #d97706;
  --radius: 12px; --radius-sm: 8px;
  --shadow: 0 1px 3px rgba(15,23,42,.06); --shadow-sm: 0 1px 2px rgba(15,23,42,.05);
  --shadow-md: 0 4px 12px rgba(15,23,42,.08); --shadow-lg: 0 12px 32px rgba(15,23,42,.12);
  --font: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
  --text-xs: 11px; --text-sm: 13px; --text-base: 14px; --text-md: 15px; --text-lg: 20px; --text-xl: 24px;
  --admin: #6366f1; --admin-soft: #eef2ff; --touch-min: 44px;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100vh; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
.wb-topbar {
  position: sticky; top: 0; z-index: 50; background: #fff; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 14px; padding: 0 20px; height: 54px;
}
.wb-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 16px; color: #0F766E; }
.wb-brand i { width: 10px; height: 10px; border-radius: 3px; background: #0F766E; display: inline-block; }
.wb-back { font-size: 13px; color: var(--muted); }
.wb-spacer { flex: 1; }
.wb-user { font-size: 13px; color: var(--muted); }
.wb-logout { border: 1px solid var(--border); background: #fff; border-radius: 7px; padding: 5px 12px; font-size: 13px; cursor: pointer; color: var(--text); }
.wb-logout:hover { border-color: #0F766E; color: #0F766E; }
.wb-main { max-width: 1200px; margin: 0 auto; padding: 20px 18px 48px; }
.wb-page-head { margin-bottom: 14px; }
.wb-page-head h1 { font-size: 20px; margin: 0 0 4px; }
.wb-page-head p { margin: 0; color: var(--muted); font-size: 13px; }
`;

export function renderWorkbenchPage(params: {
  role: WorkbenchShellRole;
  activeNav: WorkbenchNavId;
  title: string;
  pageTitle: string;
  description?: string;
  userLabel?: string;
  sessionUserId?: string;
  portfolioEnabled?: boolean;
  showAdminOpsLink?: boolean;
  canExecuteAsManager?: boolean;
  qualityAccessDisabled?: boolean;
  extraCss?: string;
  mainHtml: string;
  scriptHtml?: string;
}): string {
  const esc = (s: unknown): string =>
    String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(params.pageTitle)} · 中科微光工作日志平台</title>
<style>${SHELL_CSS}\n${params.extraCss ?? ""}</style>
</head>
<body>
<header class="wb-topbar">
  <span class="wb-brand"><i></i>中科微光 · 工作日志平台</span>
  <a class="wb-back" href="/">← 返回平台</a>
  <span class="wb-spacer"></span>
  <span class="wb-user">${esc(params.userLabel ?? "")}</span>
  <button class="wb-logout" id="logoutBtn" type="button">退出登录</button>
</header>
<main class="wb-main">
  <div class="wb-page-head">
    <h1>${esc(params.title)}</h1>
    ${params.description ? `<p>${esc(params.description)}</p>` : ""}
  </div>
  ${params.mainHtml}
</main>
${params.scriptHtml ?? ""}
</body>
</html>`;
}
