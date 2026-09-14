export function resolveWorkbenchSqlitePath(): string {
  return process.env.WORKBENCH_SQLITE_PATH?.trim() || "./data/workbench/workbench.sqlite";
}
