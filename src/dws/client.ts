/** DWS 连接检查：每个平台用户使用独立凭证目录，并严格核验钉钉身份。 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "../infra/config";
import { Semaphore } from "../infra/semaphore";

export type DwsConnectionState =
  | "disabled"
  | "unavailable"
  | "unauthenticated"
  | "identity_mismatch"
  | "connected"
  | "error";

export interface DwsIdentity {
  corpId: string;
  userId: string;
  userIds?: string[];
  name: string;
  corpName: string;
  deptName: string;
}

export interface DwsConnectionStatus {
  enabled: boolean;
  available: boolean;
  connected: boolean;
  state: DwsConnectionState;
  profile?: string;
  identity?: DwsIdentity;
  error?: string;
}

export interface DwsUserContext {
  platformUserId: number;
  corpId: string;
  ddUserid: string;
}

export interface DwsRunOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

export type DwsRunner = (args: string[], options?: DwsRunOptions) => Promise<string>;

export class DwsCommandError extends Error {
  constructor(
    readonly safeCode: string,
    readonly failureStage: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number,
    options?: ErrorOptions,
  ) {
    super(safeCode, options);
    this.name = "DwsCommandError";
  }
}

interface DwsProfile {
  profile?: string;
  corpId?: string;
  status?: string;
}

export function parseDwsJson(stdout: string): Record<string, unknown> {
  const text = stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("DWS 未返回 JSON");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseDwsPayload(value: string): Record<string, unknown> | null {
  try {
    return parseDwsJson(value);
  } catch {
    return null;
  }
}

export function classifyDwsFailure(payload: Record<string, unknown> | null, err: Error & { code?: string; killed?: boolean; signal?: string }) {
  const envelope = object(payload?.error);
  const category = String(envelope?.category ?? envelope?.type ?? "").toLowerCase();
  const subtype = String(envelope?.subtype ?? "").toLowerCase();
  const stage = String(envelope?.stage ?? "execution").slice(0, 80) || "execution";
  const message = String(envelope?.message ?? "").toLowerCase();
  const retryable = envelope?.retryable === true;
  const retryAfterSeconds = Number(envelope?.retry_after_seconds ?? envelope?.retryAfterSeconds ?? 0);
  const retryAfterMs = Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds * 1000) : 0;

  let safeCode = "service_unavailable";
  if (err.code === "ENOENT") safeCode = "dws_unavailable";
  else if (err.killed || err.signal === "SIGTERM" || /timeout|deadline/.test(`${subtype} ${message}`)) safeCode = "timeout";
  else if (/permission|forbidden|unauthorized|access_denied/.test(`${category} ${subtype} ${message}`)) safeCode = "permission_denied";
  else if (/auth|token|login/.test(`${category} ${subtype}`)) safeCode = "unauthenticated";
  else if (/rate|thrott/.test(`${category} ${subtype}`)) safeCode = "rate_limited";
  else if (
    category === "validation" ||
    /schema|malformed|invalid_|blocked_flag|unknown_flag|unknown_command|parse/.test(`${subtype} ${message}`)
  ) safeCode = "schema_error";
  else if (/unavailable|upstream|service/.test(`${category} ${subtype}`)) safeCode = "service_unavailable";

  return { safeCode, stage, retryable, retryAfterMs };
}

function errorText(err: unknown): string {
  if (err instanceof DwsCommandError) {
    if (err.safeCode === "dws_unavailable") return "服务器未安装 DWS";
    if (err.safeCode === "timeout") return "DWS 连接检查超时";
    if (err.safeCode === "permission_denied") return "当前账号无权限读取 DWS 身份";
    if (err.safeCode === "unauthenticated") return "DWS 登录态已失效，请重新授权";
    return "DWS 调用失败";
  }
  if (!(err instanceof Error)) return "DWS 调用失败";
  const withCode = err as Error & { code?: string };
  if (withCode.code === "ENOENT") return "服务器未安装 DWS";
  return err.message.split(/\r?\n/)[0].slice(0, 180) || "DWS 调用失败";
}

function isUnavailable(err: unknown): boolean {
  return err instanceof DwsCommandError
    ? err.safeCode === "dws_unavailable"
    : err instanceof Error && (err as Error & { code?: string }).code === "ENOENT";
}

function selectExactProfile(profiles: DwsProfile[], corpId: string, userId: string): DwsProfile | undefined {
  const exact = `${corpId}:${userId}`;
  return profiles.find((profile) => profile.profile === exact && profile.corpId === corpId && profile.status !== "revoked");
}

function extractIdentity(payload: Record<string, unknown>): DwsIdentity | null {
  const result = Array.isArray(payload.result) ? payload.result : [];
  const first = result[0] as { orgEmployeeModel?: Record<string, unknown> } | undefined;
  const employee = first?.orgEmployeeModel;
  if (!employee) return null;
  const depts = Array.isArray(employee.depts) ? employee.depts : [];
  const firstDept = depts[0] as { deptName?: unknown } | undefined;
  const userIds = [...new Set([
    employee.userId,
    employee.userid,
    employee.staffId,
    employee.openDingTalkId,
    employee.openDingtalkId,
    employee.openId,
    employee.unionId,
  ].map((value) => String(value ?? "").trim()).filter(Boolean))];
  return {
    corpId: String(employee.corpId ?? ""),
    userId: userIds[0] ?? "",
    userIds,
    name: String(employee.orgUserName ?? ""),
    corpName: String(employee.orgName ?? ""),
    deptName: String(firstDept?.deptName ?? ""),
  };
}

export function dwsUserHome(platformUserId: number): string {
  if (!Number.isSafeInteger(platformUserId) || platformUserId <= 0) {
    throw new Error("无效的平台用户 ID");
  }
  return path.resolve(CONFIG.dws.usersDir, String(platformUserId));
}

export function dwsEnvironmentForUser(platformUserId: number): NodeJS.ProcessEnv {
  const home = dwsUserHome(platformUserId);
  const configDir = path.join(home, ".dws");
  const dataHome = path.join(home, ".local", "share");
  const configHome = path.join(home, ".config");
  const appData = path.join(home, ".appdata", "roaming");
  const localAppData = path.join(home, ".appdata", "local");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
  fs.mkdirSync(localAppData, { recursive: true, mode: 0o700 });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    DWS_CONFIG_DIR: configDir,
  };
}

const globalDwsGate = new Semaphore(CONFIG.assistant.globalConcurrency);
const userDwsGates = new Map<number, Semaphore>();

function userDwsGate(platformUserId: number): Semaphore {
  const existing = userDwsGates.get(platformUserId);
  if (existing) return existing;
  const created = new Semaphore(CONFIG.assistant.perUserConcurrency);
  userDwsGates.set(platformUserId, created);
  return created;
}

export async function runDwsForUser(
  platformUserId: number,
  args: string[],
  options: DwsRunOptions = {},
): Promise<string> {
  return await globalDwsGate.run(
    () =>
      userDwsGate(platformUserId).run(
        async () =>
          await new Promise<string>((resolve, reject) => {
            execFile(
              CONFIG.dws.binary,
              args,
              {
                encoding: "utf8",
                timeout: options.timeoutMs ?? CONFIG.dws.timeoutMs,
                maxBuffer: options.maxBufferBytes ?? CONFIG.dws.maxBufferBytes,
                windowsHide: true,
                env: dwsEnvironmentForUser(platformUserId),
                signal: options.signal,
              },
              (err, stdout, stderr) => {
                if (err) {
                  const error = err as Error & { code?: string; killed?: boolean; signal?: string };
                  const payload = parseDwsPayload(stdout) ?? parseDwsPayload(stderr);
                  const failure = classifyDwsFailure(payload, error);
                  reject(new DwsCommandError(
                    failure.safeCode,
                    failure.stage,
                    failure.retryable,
                    failure.retryAfterMs,
                    { cause: error },
                  ));
                  return;
                }
                resolve(stdout);
              },
            );
          }),
        options.signal,
      ),
    options.signal,
  );
}

export async function inspectDwsConnection(
  input: DwsUserContext,
  runner: DwsRunner = (args) => runDwsForUser(input.platformUserId, args),
  enabled = CONFIG.dws.enabled,
): Promise<DwsConnectionStatus> {
  if (!enabled) {
    return { enabled: false, available: false, connected: false, state: "disabled" };
  }

  let profilesPayload: Record<string, unknown>;
  try {
    profilesPayload = parseDwsJson(await runner(["profile", "list", "--format", "json"]));
  } catch (err) {
    return {
      enabled: true,
      available: !isUnavailable(err),
      connected: false,
      state: isUnavailable(err) ? "unavailable" : "error",
      error: errorText(err),
    };
  }

  const profiles = Array.isArray(profilesPayload.profiles) ? (profilesPayload.profiles as DwsProfile[]) : [];
  const selected = selectExactProfile(profiles, input.corpId, input.ddUserid);
  const profile = String(selected?.profile ?? "");
  if (!profile) {
    return {
      enabled: true,
      available: true,
      connected: false,
      state: "unauthenticated",
      error: "当前钉钉账号尚未授权 DWS",
    };
  }

  try {
    const authPayload = parseDwsJson(
      await runner(["--profile", profile, "auth", "status", "--format", "json"]),
    );
    const authenticated = authPayload.authenticated === true;
    const tokenValid = authPayload.token_valid === true || authPayload.refresh_token_valid === true;
    if (!authenticated || !tokenValid) {
      return {
        enabled: true,
        available: true,
        connected: false,
        state: "unauthenticated",
        profile,
        error: "DWS 登录态已失效，请重新授权",
      };
    }

    const selfPayload = parseDwsJson(
      await runner(["--profile", profile, "contact", "user", "get-self", "--format", "json"]),
    );
    const identity = extractIdentity(selfPayload);
    if (!identity || identity.corpId !== input.corpId || !(identity.userIds ?? [identity.userId]).includes(input.ddUserid)) {
      return {
        enabled: true,
        available: true,
        connected: false,
        state: "identity_mismatch",
        profile,
        identity: identity ?? undefined,
        error: "授权账号与当前钉钉账号不一致",
      };
    }

    return {
      enabled: true,
      available: true,
      connected: true,
      state: "connected",
      profile,
      identity,
    };
  } catch (err) {
    return {
      enabled: true,
      available: true,
      connected: false,
      state: "error",
      profile,
      error: errorText(err),
    };
  }
}
