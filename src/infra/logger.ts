/** One-line JSON log for operators (e.g. grep / log aggregation). */
export function logStructured(payload: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      ...payload,
    })
  );
}
