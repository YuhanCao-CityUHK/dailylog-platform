import type { SessionUser } from "../auth/types";
import { CONFIG } from "../infra/config";
import type { EvidenceWithReference } from "./evidence-store";
import type { CollectedEvidence, EvidenceRelationToSelf } from "./schema";

export interface EvidenceEligibilityResult {
  candidateEvidence: EvidenceWithReference[];
  backgroundEvidence: EvidenceWithReference[];
  discardedEvidence: EvidenceWithReference[];
}

export function relationToSelf(
  evidence: CollectedEvidence,
  user: Pick<SessionUser, "ddUserid">,
): EvidenceRelationToSelf {
  if (evidence.relationToSelf) return evidence.relationToSelf;
  const selfId = String(user.ddUserid ?? "").trim();
  if (selfId && evidence.actorUserIds.includes(selfId)) return "self";
  return "bot_or_unknown";
}

export function shouldPersistAsReference(
  evidence: CollectedEvidence,
  user: Pick<SessionUser, "ddUserid">,
): boolean {
  return relationToSelf(evidence, user) !== "bot_or_unknown";
}

/** 人员关系资格先于时态资格；无法识别时按 bot_or_unknown 丢弃。 */
export function applyEvidenceEligibility(
  items: EvidenceWithReference[],
  user: Pick<SessionUser, "ddUserid">,
  maxGroupMembers = CONFIG.assistant.groupOthersSignalMaxMembers,
): EvidenceEligibilityResult {
  const candidateEvidence: EvidenceWithReference[] = [];
  const backgroundEvidence: EvidenceWithReference[] = [];
  const discardedEvidence: EvidenceWithReference[] = [];
  for (const item of items) {
    const relation = relationToSelf(item.evidence, user);
    if (relation === "bot_or_unknown") {
      discardedEvidence.push(item);
      continue;
    }
    if (relation === "self" || relation === "addressed") {
      candidateEvidence.push(item);
      continue;
    }
    const largeGroup = item.evidence.sourceType === "chat_group"
      && Number(item.evidence.groupMemberCount ?? item.evidence.participantNames.length) > maxGroupMembers;
    backgroundEvidence.push(largeGroup
      ? { ...item, evidence: { ...item.evidence, projectSignals: [] } }
      : item);
  }
  return { candidateEvidence, backgroundEvidence, discardedEvidence };
}
