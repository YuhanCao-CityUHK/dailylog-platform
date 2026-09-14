/** 从日报项目组查看人与早报接收人中移除指定 userid；校验命中数后原子写回。 */
import * as fs from "node:fs";
import * as path from "node:path";

const configFile = String(process.env.DAILY_REPORT_DIGEST_CONFIG_FILE ?? "").trim();
const targetUserId = String(process.env.REMOVE_DAILY_REPORT_USERID ?? "").trim();
const expectedViewerRefs = Number(process.env.EXPECT_VIEWER_REFS ?? "-1");
const expectedRecipientRefs = Number(process.env.EXPECT_RECIPIENT_REFS ?? "-1");

if (!configFile || !targetUserId) {
  throw new Error("缺少 DAILY_REPORT_DIGEST_CONFIG_FILE 或 REMOVE_DAILY_REPORT_USERID");
}

const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
  orgs?: Array<{
    projectViews?: Array<{
      viewers?: string[];
      digest?: { recipients?: string[] };
    }>;
  }>;
};

let viewerRefs = 0;
let recipientRefs = 0;
for (const org of raw.orgs ?? []) {
  for (const view of org.projectViews ?? []) {
    if (Array.isArray(view.viewers)) {
      viewerRefs += view.viewers.filter((id) => id === targetUserId).length;
      view.viewers = view.viewers.filter((id) => id !== targetUserId);
    }
    if (Array.isArray(view.digest?.recipients)) {
      recipientRefs += view.digest.recipients.filter((id) => id === targetUserId).length;
      view.digest.recipients = view.digest.recipients.filter((id) => id !== targetUserId);
    }
  }
}

if (expectedViewerRefs >= 0 && viewerRefs !== expectedViewerRefs) {
  throw new Error(`查看人命中数应为 ${expectedViewerRefs}，实际为 ${viewerRefs}`);
}
if (expectedRecipientRefs >= 0 && recipientRefs !== expectedRecipientRefs) {
  throw new Error(`接收人命中数应为 ${expectedRecipientRefs}，实际为 ${recipientRefs}`);
}

const tempFile = path.join(path.dirname(configFile), `.${path.basename(configFile)}.${process.pid}.tmp`);
fs.writeFileSync(tempFile, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
fs.renameSync(tempFile, configFile);

console.log(JSON.stringify({ removedUserId: targetUserId, viewerRefs, recipientRefs }));
