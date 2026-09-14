import { getDb } from "../src/infra/db";
import { todayYmd } from "../src/infra/workcal";
import { CONFIG } from "../src/infra/config";
import { rowToSessionUser } from "../src/auth/session";
import { getAssistantRuntime } from "../src/assistant/runtime";
import { buildEvidenceBundles } from "../src/assistant/events/evidence-bundle-builder";
import { isSourceContainerTitle } from "../src/assistant/historical-report-parser";
import { modeFromCompleteness } from "../src/assistant/conversation-schema";

const platformUserId = Number(process.env.DWS_SMOKE_USER_ID ?? "4");
if (!Number.isSafeInteger(platformUserId) || platformUserId <= 0) throw new Error("invalid DWS_SMOKE_USER_ID");
if (!CONFIG.assistant.eventFusionEnabled) throw new Error("event fusion is not enabled");

const row = getDb().prepare(
  `SELECT id, kind, dd_userid, login_name, name, title, dept, role,
          is_external, active, must_change_pw
     FROM users WHERE id = ? AND active = 1`,
).get(platformUserId) as Parameters<typeof rowToSessionUser>[0] | undefined;
if (!row) throw new Error("acceptance user is missing or inactive");
const user = rowToSessionUser(row);
if (!user.ddUserid || !CONFIG.assistant.eventFusionPilotUserids.includes(user.ddUserid)) {
  throw new Error("acceptance user is not in the event-fusion pilot");
}

const runtime = getAssistantRuntime();
const workDate = todayYmd();
const reuseContext = process.env.ACCEPTANCE_REUSE_CONTEXT === "1";
const started = reuseContext
  ? runtime.orchestrator.get(user.id, workDate)
  : runtime.orchestrator.start(user, workDate, true);
if (!started) throw new Error("context job is missing");
if (!reuseContext) await runtime.orchestrator.waitForIdle(started.id);
const job = runtime.orchestrator.get(user.id, workDate);
if (!job || job.id !== started.id || job.status === "failed" || job.status === "queued" || job.status === "running") {
  throw new Error(`context refresh did not finish: ${job?.status ?? "missing"}`);
}

const build = await runtime.candidateService.build(user, job.id, workDate);
if (build.analysisMode !== "real_model") throw new Error(`unexpected analysis mode: ${build.analysisMode}`);
if (build.candidates.length === 0 || build.candidates.length > 8) {
  throw new Error(`unexpected candidate count: ${build.candidates.length}`);
}

const evidences = runtime.evidenceStore.listEvidenceForJob(job.id, user.id);
const byReference = new Map(evidences.map((item) => [item.referenceId, item]));
const directTodayForSelf = (referenceId: string): boolean => {
  const item = byReference.get(referenceId);
  if (!item) return false;
  const evidence = item.evidence;
  return evidence.temporalRole === "today"
    && evidence.workUse === "direct_work"
    && (evidence.relationToSelf === "self" || evidence.actorUserIds.includes(user.ddUserid!));
};
const sourcePayload = /(?:^|[\s：:])\{\s*"(?:doc|createTime|dentryKey|dentryUuid)"/i;
const normalizedTitles = new Set<string>();
for (const candidate of build.candidates) {
  if (isSourceContainerTitle(candidate.title)) throw new Error(`source container became candidate: ${candidate.title}`);
  if (sourcePayload.test(`${candidate.title}\n${candidate.resultHint}`)) throw new Error("raw source payload became candidate text");
  if (candidate.origin === "today" && !candidate.referenceIds.some(directTodayForSelf)) {
    throw new Error(`today candidate has no self direct evidence: ${candidate.candidateId}`);
  }
  if (candidate.scopeType === "project" && (!candidate.selectedProjectId || !candidate.selectedProjectName)) {
    throw new Error(`project candidate is not resolved: ${candidate.candidateId}`);
  }
  if (candidate.scopeType === "unconfirmed" && candidate.projectCandidates.length === 0) {
    throw new Error(`unconfirmed candidate has no plausible project: ${candidate.candidateId}`);
  }
  if (candidate.scopeType === "department_daily" && candidate.projectCandidates.length !== 0) {
    throw new Error(`department candidate still has a plausible project: ${candidate.candidateId}`);
  }
  const titleKey = candidate.title.normalize("NFKC").replace(/[^a-z0-9\u3400-\u9fff]/gi, "").toLowerCase();
  if (normalizedTitles.has(titleKey)) throw new Error(`duplicate candidate title: ${candidate.title}`);
  normalizedTitles.add(titleKey);
}

for (const item of evidences.filter((entry) => entry.evidence.sourceType === "wiki")) {
  if (sourcePayload.test(`${item.evidence.title}\n${item.evidence.summary}`)) {
    throw new Error("wiki reference exposes raw feed JSON");
  }
}

const bundles = buildEvidenceBundles(evidences);
const meaningfulMultiSourceBundles = bundles.bundles.filter((bundle) => (
  bundle.sourceTypes.length > 1
  && bundle.items.some((item) => item.temporalRole === "today" && item.workUse === "direct_work" && item.relationToSelf === "self")
));
const crossSourceCandidates = build.candidates.filter((candidate) => candidate.sourceTypes.length > 1);
if (meaningfulMultiSourceBundles.length > 0 && crossSourceCandidates.length === 0) {
  throw new Error("related cross-source evidence was not fused into a work item");
}

let sessionUpdated = false;
if (process.env.ACCEPTANCE_UPDATE_SESSION === "1") {
  runtime.conversationEngine.ensureSession(
    user.id,
    workDate,
    modeFromCompleteness(job.completeness),
    job.id,
    build.candidates,
    build.analysisMode,
  );
  sessionUpdated = true;
}

console.log(JSON.stringify({
  workDate,
  jobStatus: job.status,
  completeness: job.completeness,
  sourceStatuses: job.sources.map((source) => ({ source: source.source, status: source.status, itemCount: source.itemCount })),
  evidenceCount: evidences.length,
  bundleCount: bundles.bundles.length,
  meaningfulMultiSourceBundleCount: meaningfulMultiSourceBundles.length,
  candidateCount: build.candidates.length,
  crossSourceCandidateCount: crossSourceCandidates.length,
  sessionUpdated,
  candidates: build.candidates.map((candidate) => ({
    title: candidate.title,
    sourceTypes: candidate.sourceTypes,
    scopeType: candidate.scopeType,
    selectedProjectName: candidate.selectedProjectName,
    recommendedProjectName: candidate.projectCandidates[0]?.projectName,
    origin: candidate.origin,
  })),
}));
