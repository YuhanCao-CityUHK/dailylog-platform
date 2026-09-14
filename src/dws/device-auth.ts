/** DWS 设备授权：只向前端暴露授权地址和一次性代码，不暴露 Token 或 CLI 原始输出。 */
import { spawn, type ChildProcess } from "node:child_process";
import { CONFIG } from "../infra/config";
import { dwsEnvironmentForUser } from "./client";

export type DwsAuthorizationState = "starting" | "pending" | "completed" | "expired" | "error";

export interface DwsAuthorizationView {
  state: DwsAuthorizationState;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  error?: string;
}

interface DwsAuthorizationEntry extends DwsAuthorizationView {
  child: ChildProcess;
  output: string;
  ready: Promise<DwsAuthorizationView>;
  resolveReady: (value: DwsAuthorizationView) => void;
  readyResolved: boolean;
  timeout: NodeJS.Timeout;
}

const authorizations = new Map<number, DwsAuthorizationEntry>();
const MAX_CONCURRENT_AUTHORIZATIONS = 20;

function publicView(entry: DwsAuthorizationEntry): DwsAuthorizationView {
  return {
    state: entry.state,
    verificationUrl: entry.verificationUrl,
    userCode: entry.userCode,
    expiresAt: entry.expiresAt,
    error: entry.error,
  };
}

function resolveReady(entry: DwsAuthorizationEntry): void {
  if (entry.readyResolved) return;
  entry.readyResolved = true;
  entry.resolveReady(publicView(entry));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
}

export function parseDwsDeviceAuthorization(output: string): Pick<DwsAuthorizationView, "verificationUrl" | "userCode"> | null {
  const text = stripAnsi(output);
  const complete = text.match(/https:\/\/login\.dingtalk\.com\/oauth2\/device\/verify\.htm\?user_code=([A-Z0-9-]+)/i);
  const code = complete?.[1] ?? text.match(/(?:authorization code|授权码)\s*[:：]\s*([A-Z0-9-]+)/i)?.[1];
  if (!code) return null;
  return {
    userCode: code.toUpperCase(),
    verificationUrl: `https://login.dingtalk.com/oauth2/device/verify.htm?user_code=${encodeURIComponent(code.toUpperCase())}`,
  };
}

function acceptOutput(entry: DwsAuthorizationEntry, chunk: Buffer | string): void {
  entry.output = `${entry.output}${String(chunk)}`.slice(-64 * 1024);
  const prompt = parseDwsDeviceAuthorization(entry.output);
  if (!prompt || entry.state !== "starting") return;
  entry.state = "pending";
  entry.verificationUrl = prompt.verificationUrl;
  entry.userCode = prompt.userCode;
  entry.expiresAt = new Date(Date.now() + CONFIG.dws.authTimeoutMs).toISOString();
  resolveReady(entry);
}

export function getDwsAuthorization(platformUserId: number): DwsAuthorizationView | undefined {
  const entry = authorizations.get(platformUserId);
  return entry ? publicView(entry) : undefined;
}

export function clearDwsAuthorization(platformUserId: number): void {
  const entry = authorizations.get(platformUserId);
  if (!entry) return;
  clearTimeout(entry.timeout);
  if (entry.child.exitCode === null && !entry.child.killed) entry.child.kill("SIGTERM");
  authorizations.delete(platformUserId);
}

export async function startDwsAuthorization(platformUserId: number): Promise<DwsAuthorizationView> {
  const existing = authorizations.get(platformUserId);
  if (existing && (existing.state === "starting" || existing.state === "pending")) {
    return existing.state === "starting" ? await existing.ready : publicView(existing);
  }
  if ([...authorizations.values()].filter((entry) => entry.state === "starting" || entry.state === "pending").length >= MAX_CONCURRENT_AUTHORIZATIONS) {
    throw new Error("当前授权人数较多，请稍后重试");
  }

  const child = spawn(CONFIG.dws.binary, ["auth", "login", "--device", "--format", "json"], {
    env: dwsEnvironmentForUser(platformUserId),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolve!: (value: DwsAuthorizationView) => void;
  const ready = new Promise<DwsAuthorizationView>((done) => {
    resolve = done;
  });
  const entry: DwsAuthorizationEntry = {
    child,
    state: "starting",
    output: "",
    ready,
    resolveReady: resolve,
    readyResolved: false,
    timeout: setTimeout(() => undefined, 0),
  };
  authorizations.set(platformUserId, entry);

  entry.child.stdout?.on("data", (chunk: Buffer) => acceptOutput(entry, chunk));
  entry.child.stderr?.on("data", (chunk: Buffer) => acceptOutput(entry, chunk));
  entry.child.on("error", (err) => {
    entry.state = "error";
    entry.error = err.message.split(/\r?\n/)[0].slice(0, 180) || "无法启动 DWS 授权";
    clearTimeout(entry.timeout);
    resolveReady(entry);
  });
  entry.child.on("exit", (code) => {
    clearTimeout(entry.timeout);
    if (entry.state === "expired") return;
    if (code === 0) {
      entry.state = "completed";
    } else {
      entry.state = "error";
      entry.error = "DWS 授权未完成，请重试";
    }
    resolveReady(entry);
  });
  entry.timeout = setTimeout(() => {
    entry.state = "expired";
    entry.error = "授权码已过期，请重新授权";
    if (entry.child.exitCode === null && !entry.child.killed) entry.child.kill("SIGTERM");
    resolveReady(entry);
  }, CONFIG.dws.authTimeoutMs);
  entry.timeout.unref();

  const startGuard = setTimeout(() => {
    if (entry.state !== "starting") return;
    entry.state = "error";
    entry.error = "DWS 未返回授权码，请重试";
    if (entry.child.exitCode === null && !entry.child.killed) entry.child.kill("SIGTERM");
    resolveReady(entry);
  }, 10_000);
  startGuard.unref();
  const result = await ready;
  clearTimeout(startGuard);
  return result;
}
