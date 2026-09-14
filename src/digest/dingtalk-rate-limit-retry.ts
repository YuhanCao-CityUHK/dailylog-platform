export interface DingTalkRateLimitRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function envInt(name: string, defaultValue: number): number {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isDingTalkRateLimitError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  return (
    /"errcode"\s*:\s*88/.test(text) ||
    /errcode\D+88/.test(text) ||
    /\b429\b/.test(text) ||
    /qps/i.test(text) ||
    /rate\s*limit/i.test(text) ||
    /too\s*many\s*requests/i.test(text) ||
    /total\s+requests/i.test(text) ||
    /limit\s+until/i.test(text) ||
    /throttl/i.test(text) ||
    /限流/.test(text)
  );
}

export async function withDingTalkRateLimitRetry<T>(
  operation: () => Promise<T>,
  options?: DingTalkRateLimitRetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    options?.maxAttempts ?? envInt("DINGTALK_RATE_LIMIT_RETRY_ATTEMPTS", 3),
  );
  const delayMs = options?.delayMs ?? envInt("DINGTALK_RATE_LIMIT_RETRY_DELAY_MS", 1000);
  const sleep = options?.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isDingTalkRateLimitError(err)) {
        throw err;
      }
      if (delayMs > 0) {
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
