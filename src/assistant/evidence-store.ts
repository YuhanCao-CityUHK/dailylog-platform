import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { CollectedEvidence, EvidenceSourceType } from "./schema";
import { decryptJson, encryptJson } from "./crypto";

export interface ReferenceView {
  referenceId: string;
  sourceType: EvidenceSourceType;
  title: string;
  summary: string;
  occurredAt: string;
  actorNames: string[];
  participantNames: string[];
  url?: string;
  privacyScope: "employee_only" | "normal";
  evidenceStrength: "strong" | "medium" | "weak";
  expiresAt: string;
}

export interface EvidenceWithReference {
  referenceId: string;
  jobId: string;
  userId: number;
  workDate: string;
  evidence: CollectedEvidence;
  expiresAt: string;
}

interface StoredPayload extends CollectedEvidence {}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function aad(userId: number, workDate: string, sourceType: string): string {
  return `${userId}:${workDate}:${sourceType}`;
}

export class EvidenceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
  ) {}

  put(
    jobId: string,
    userId: number,
    workDate: string,
    evidence: CollectedEvidence,
    expiresAt: string,
    now = new Date(),
  ): string {
    const contentHash = digest(
      JSON.stringify([evidence.title, evidence.summary, evidence.occurredAt, evidence.actorUserIds, evidence.participantNames]),
    );
    const externalHash = digest(evidence.externalId);
    const encrypted = encryptJson(evidence, this.key, aad(userId, workDate, evidence.sourceType));
    const stamp = now.toISOString();
    const existing = this.db
      .prepare(
        `SELECT id FROM context_evidences
          WHERE user_id = ? AND source_type = ? AND external_id = ? AND content_hash = ?`,
      )
      .get(userId, evidence.sourceType, externalHash, contentHash) as { id: string } | undefined;
    const evidenceId = existing?.id ?? randomUUID();
    if (existing) {
      this.db.prepare(
        `UPDATE context_evidences
            SET job_id = ?, privacy_scope = ?, occurred_at = ?, payload_cipher = ?, payload_iv = ?,
                payload_tag = ?, expires_at = ?
          WHERE id = ?`,
      ).run(
        jobId,
        evidence.privacyScope,
        evidence.occurredAt,
        encrypted.cipher,
        encrypted.iv,
        encrypted.tag,
        expiresAt,
        evidenceId,
      );
    } else {
      this.db.prepare(
        `INSERT INTO context_evidences
          (id, job_id, user_id, work_date, source_type, external_id, content_hash, privacy_scope,
           occurred_at, payload_cipher, payload_iv, payload_tag, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        evidenceId,
        jobId,
        userId,
        workDate,
        evidence.sourceType,
        externalHash,
        contentHash,
        evidence.privacyScope,
        evidence.occurredAt,
        encrypted.cipher,
        encrypted.iv,
        encrypted.tag,
        stamp,
        expiresAt,
      );
    }
    const reference = this.db
      .prepare("SELECT id FROM context_references WHERE evidence_id = ?")
      .get(evidenceId) as { id: string } | undefined;
    const referenceId = reference?.id ?? randomUUID();
    if (reference) {
      this.db.prepare("UPDATE context_references SET expires_at = ? WHERE id = ?").run(expiresAt, referenceId);
    } else {
      this.db.prepare(
        `INSERT INTO context_references
          (id, evidence_id, user_id, work_date, privacy_scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(referenceId, evidenceId, userId, workDate, evidence.privacyScope, stamp, expiresAt);
    }
    return referenceId;
  }

  get(referenceId: string, userId: number, now = new Date()): ReferenceView | null {
    const row = this.db
      .prepare(
        `SELECT r.id AS reference_id, r.user_id, r.work_date, r.privacy_scope, r.expires_at,
                e.source_type, e.payload_cipher, e.payload_iv, e.payload_tag
           FROM context_references r JOIN context_evidences e ON e.id = r.evidence_id
          WHERE r.id = ? AND r.user_id = ? AND r.expires_at > ? AND e.expires_at > ?`,
      )
      .get(referenceId, userId, now.toISOString(), now.toISOString()) as
      | {
          reference_id: string;
          user_id: number;
          work_date: string;
          privacy_scope: "employee_only" | "normal";
          expires_at: string;
          source_type: EvidenceSourceType;
          payload_cipher: string;
          payload_iv: string;
          payload_tag: string;
        }
      | undefined;
    if (!row) return null;
    const payload = decryptJson<StoredPayload>(
      { cipher: row.payload_cipher, iv: row.payload_iv, tag: row.payload_tag },
      this.key,
      aad(row.user_id, row.work_date, row.source_type),
    );
    return {
      referenceId: row.reference_id,
      sourceType: row.source_type,
      title: payload.title,
      summary: payload.summary,
      occurredAt: payload.occurredAt,
      actorNames: payload.actorNames,
      participantNames: payload.participantNames,
      url: payload.url,
      privacyScope: row.privacy_scope,
      evidenceStrength: payload.evidenceStrength,
      expiresAt: row.expires_at,
    };
  }

  listForJob(jobId: string, userId: number, now = new Date()): ReferenceView[] {
    const ids = this.db
      .prepare(
        `SELECT r.id FROM context_references r
           JOIN context_evidences e ON e.id = r.evidence_id
          WHERE e.job_id = ? AND r.user_id = ? AND r.expires_at > ?
          ORDER BY e.occurred_at, r.id`,
      )
      .all(jobId, userId, now.toISOString()) as unknown as Array<{ id: string }>;
    return ids.map((row) => this.get(row.id, userId, now)).filter((item): item is ReferenceView => Boolean(item));
  }

  /** 仅供服务端事项聚合使用，包含加密载荷中的匹配信号，不直接返回给主管或前端。 */
  listEvidenceForJob(jobId: string, userId: number, now = new Date()): EvidenceWithReference[] {
    const rows = this.db
      .prepare(
        `SELECT r.id AS reference_id, r.expires_at, e.job_id, e.user_id, e.work_date, e.source_type,
                e.payload_cipher, e.payload_iv, e.payload_tag
           FROM context_references r JOIN context_evidences e ON e.id = r.evidence_id
          WHERE e.job_id = ? AND e.user_id = ? AND r.expires_at > ? AND e.expires_at > ?
          ORDER BY e.occurred_at, r.id`,
      )
      .all(jobId, userId, now.toISOString(), now.toISOString()) as unknown as Array<{
      reference_id: string;
      expires_at: string;
      job_id: string;
      user_id: number;
      work_date: string;
      source_type: EvidenceSourceType;
      payload_cipher: string;
      payload_iv: string;
      payload_tag: string;
    }>;
    return rows.map((row) => ({
      referenceId: row.reference_id,
      jobId: row.job_id,
      userId: row.user_id,
      workDate: row.work_date,
      expiresAt: row.expires_at,
      evidence: decryptJson<CollectedEvidence>(
        { cipher: row.payload_cipher, iv: row.payload_iv, tag: row.payload_tag },
        this.key,
        aad(row.user_id, row.work_date, row.source_type),
      ),
    }));
  }

  cleanupExpired(now = new Date()): { references: number; evidences: number; jobs: number } {
    const stamp = now.toISOString();
    const references = Number(this.db.prepare("DELETE FROM context_references WHERE expires_at <= ?").run(stamp).changes);
    const evidences = Number(this.db.prepare("DELETE FROM context_evidences WHERE expires_at <= ?").run(stamp).changes);
    const jobs = Number(this.db.prepare("DELETE FROM context_jobs WHERE expires_at <= ?").run(stamp).changes);
    return { references, evidences, jobs };
  }
}
