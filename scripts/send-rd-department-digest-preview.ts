import { sendRdDepartmentDigestPreview } from "../src/digest/rd-department-digest-scheduler";

const recipientUserId = String(process.env.RD_DIGEST_PREVIEW_USERID ?? "").trim();
const expectedRecipientName = String(process.env.RD_DIGEST_PREVIEW_EXPECTED_NAME ?? "").trim();
const dateYmd = String(process.env.RD_DIGEST_PREVIEW_DATE ?? "").trim();
const refresh = String(process.env.RD_DIGEST_PREVIEW_REFRESH ?? "1").trim() !== "0";

if (!recipientUserId) throw new Error("RD_DIGEST_PREVIEW_USERID is required");

const result = await sendRdDepartmentDigestPreview({
  recipientUserId,
  expectedRecipientName: expectedRecipientName || undefined,
  dateYmd: dateYmd || undefined,
  refresh,
});

console.log(
  JSON.stringify({
    ok: true,
    dateYmd: result.digest.dateYmd,
    recipientUserId,
    departmentSubmitted: result.digest.departmentSubmitted,
    departmentTotal: result.digest.departmentTotal,
    platformSubmitted: result.digest.platformSubmitted,
    platformTotal: result.digest.platformTotal,
    projectCount: result.digest.projects.length,
    missingCount: result.digest.missingNames.length,
    robotMessageKey: result.robotMessageKey,
  }),
);
