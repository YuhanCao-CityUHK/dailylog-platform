import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { CONFIG } from "../src/infra/config";
import { recentWorkdays } from "../src/infra/workcal";
import { inspectDwsConnection, parseDwsJson, runDwsForUser } from "../src/dws/client";
import {
  attendanceApprovalCollector,
  calendarCollector,
  dingtalkReportCollector,
  documentCollector,
  minutesCollector,
  todoCollector,
  wikiCollector,
} from "../src/dws/collectors/index";

const platformUserId = Number(process.env.DWS_SMOKE_USER_ID ?? "4");
if (!Number.isSafeInteger(platformUserId) || platformUserId <= 0) {
  throw new Error("invalid DWS_SMOKE_USER_ID");
}

const db = new DatabaseSync(path.join(CONFIG.dataDir, "platform.sqlite"), { readOnly: true });
const user = db.prepare(
  "SELECT id, dd_userid AS ddUserid, name FROM users WHERE id = ? AND active = 1",
).get(platformUserId) as { id: number; ddUserid: string; name: string } | undefined;
db.close();
if (!user?.ddUserid) throw new Error("DWS smoke user is missing or inactive");

const connection = await inspectDwsConnection({
  platformUserId: user.id,
  corpId: CONFIG.dingtalk.corpId,
  ddUserid: user.ddUserid,
});
if (!connection.connected || !connection.profile) {
  throw new Error(`DWS smoke connection failed: ${connection.state}`);
}

const workDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 4 * 60 * 1000);
const collectors = [
  documentCollector,
  wikiCollector,
  calendarCollector,
  minutesCollector,
  todoCollector,
  dingtalkReportCollector,
  attendanceApprovalCollector,
];

try {
  const results = await Promise.all(collectors.map((collector) => collector.collect({
    platformUserId: user.id,
    ddUserid: user.ddUserid,
    displayName: user.name,
    profile: connection.profile!,
    workDate,
    historyWorkDates: recentWorkdays(5, workDate),
    now: new Date(),
    signal: controller.signal,
    run: (args, options) => runDwsForUser(user.id, args, options).then(parseDwsJson),
  })));
  const summary = results.map((result) => ({
    source: result.source,
    status: result.status,
    errorCode: result.errorCode,
    failureStage: result.failureStage,
    itemCount: result.completeness?.itemCount ?? result.evidences.length,
    pagesFetched: result.completeness?.pagesFetched ?? 0,
  }));
  console.log(JSON.stringify({ workDate, sources: summary }));
  const failed = results.filter((result) => result.status === "error" || result.errorCode === "schema_error");
  if (failed.length > 0) {
    throw new Error(`real DWS collector smoke failed: ${failed.map((result) => `${result.source}:${result.errorCode ?? result.status}`).join(",")}`);
  }
} finally {
  clearTimeout(timeout);
}
