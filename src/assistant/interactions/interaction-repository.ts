import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptJson, encryptJson } from "../crypto";
import type { InteractionCandidate, InteractionDiscoveryCoverage } from "./interaction-types";

export interface InteractionRunRecord extends InteractionDiscoveryCoverage {
  id: string;
  status: "running" | "complete" | "partial" | "failed";
  provider?: string;
  model?: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  retryCount: number;
  errorCode?: string;
}
export interface FinishInteractionRunInput {
  status: InteractionRunRecord["status"];
  provider?: string;
  model?: string;
  inputEvidenceCount: number;
  signalEvidenceCount: number;
  candidateCount: number;
  ignoredEvidenceCount: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  retryCount?: number;
  errorCode?: string;
}

function candidateAad(userId: number, workDate: string, candidateId: string): string {
  return `${userId}:${workDate}:interaction:${candidateId}`;
}

function signalAad(userId: number, workDate: string, signalId: string): string {
  return `${userId}:${workDate}:task-signal:${signalId}`;
}

export class InteractionRepository {
  constructor(private readonly db: DatabaseSync, private readonly key: Buffer) {}

  createRun(jobId: string, userId: number, workDate: string, promptVersion: string, expiresAt: string, now = new Date()): string {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO assistant_interaction_runs
        (id, job_id, user_id, work_date, status, prompt_version, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(id, jobId, userId, workDate, promptVersion, now.toISOString(), expiresAt);
    return id;
  }

  finishRun(runId: string, input: FinishInteractionRunInput, now = new Date()): void {
    this.db.prepare(
      `UPDATE assistant_interaction_runs SET
        status = ?, provider = ?, model = ?, input_evidence_count = ?, signal_evidence_count = ?,
        candidate_count = ?, ignored_evidence_count = ?, input_tokens = ?, output_tokens = ?,
        duration_ms = ?, retry_count = ?, error_code = ?, finished_at = ?
       WHERE id = ?`,
    ).run(
      input.status,
      input.provider ?? null,
      input.model ?? null,
      input.inputEvidenceCount,
      input.signalEvidenceCount,
      input.candidateCount,
      input.ignoredEvidenceCount,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.durationMs ?? 0,
      input.retryCount ?? 0,
      input.errorCode ?? null,
      now.toISOString(),
      runId,
    );
  }

  replaceCandidates(
    runId: string,
    jobId: string,
    userId: number,
    workDate: string,
    candidates: InteractionCandidate[],
    expiresAt: string,
    now = new Date(),
  ): void {
    const stamp = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM assistant_interaction_candidates WHERE run_id = ?").run(runId);
      for (const candidate of candidates) {
        const candidateId = randomUUID();
        const encrypted = encryptJson(candidate, this.key, candidateAad(userId, workDate, candidateId));
        this.db.prepare(
          `INSERT INTO assistant_interaction_candidates
            (id, run_id, job_id, user_id, work_date, candidate_key, direction, state, priority,
             confidence, latest_at, signal_count, self_action_supported, result_supported,
             payload_cipher, payload_iv, payload_tag, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          candidateId, runId, jobId, userId, workDate, candidate.candidateKey, candidate.direction,
          candidate.state, candidate.priority, candidate.confidence, candidate.latestAt,
          candidate.evidenceIds.length, candidate.selfActionSupported ? 1 : 0, candidate.resultSupported ? 1 : 0,
          encrypted.cipher, encrypted.iv, encrypted.tag, stamp, expiresAt,
        );
        for (const referenceId of candidate.evidenceIds) {
          const signalId = randomUUID();
          const signal = encryptJson({
            title: candidate.title,
            intent: candidate.intent,
            direction: candidate.direction,
          }, this.key, signalAad(userId, workDate, signalId));
          this.db.prepare(
            `INSERT INTO assistant_task_signals
              (id, run_id, candidate_id, reference_id, user_id, work_date, direction, intent,
               target_relation, confidence, action_supported, result_supported,
               payload_cipher, payload_iv, payload_tag, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            signalId, runId, candidateId, referenceId, userId, workDate, candidate.direction, candidate.intent,
            candidate.direction === "assigned_to_me" ? "explicit_self" : candidate.direction === "self_initiated" ? "self" : "unknown",
            candidate.confidence, candidate.selfActionSupported ? 1 : 0, candidate.resultSupported ? 1 : 0,
            signal.cipher, signal.iv, signal.tag, stamp, expiresAt,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listForJob(jobId: string, userId: number, workDate: string, now = new Date()): InteractionCandidate[] {
    const rows = this.db.prepare(
      `SELECT c.id, c.payload_cipher, c.payload_iv, c.payload_tag
         FROM assistant_interaction_candidates c JOIN assistant_interaction_runs r ON r.id = c.run_id
        WHERE c.job_id = ? AND c.user_id = ? AND c.work_date = ? AND c.expires_at > ?
          AND r.status IN ('complete', 'partial')
          AND r.id = (
            SELECT id FROM assistant_interaction_runs
             WHERE job_id = ? AND user_id = ? AND work_date = ?
               AND status IN ('complete', 'partial') AND expires_at > ?
             ORDER BY created_at DESC LIMIT 1
          )
        ORDER BY c.latest_at DESC, c.id`,
    ).all(
      jobId, userId, workDate, now.toISOString(),
      jobId, userId, workDate, now.toISOString(),
    ) as unknown as Array<{ id: string; payload_cipher: string; payload_iv: string; payload_tag: string }>;
    return rows.map((row) => decryptJson<InteractionCandidate>(
      { cipher: row.payload_cipher, iv: row.payload_iv, tag: row.payload_tag },
      this.key,
      candidateAad(userId, workDate, row.id),
    ));
  }

  getRun(runId: string, userId: number): InteractionRunRecord | null {
    const row = this.db.prepare(
      `SELECT id, status, provider, model, prompt_version, input_evidence_count, signal_evidence_count,
              candidate_count, ignored_evidence_count, input_tokens, output_tokens, duration_ms,
              retry_count, error_code
         FROM assistant_interaction_runs WHERE id = ? AND user_id = ?`,
    ).get(runId, userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      status: row.status as InteractionRunRecord["status"],
      provider: row.provider ? String(row.provider) : undefined,
      model: row.model ? String(row.model) : undefined,
      promptVersion: String(row.prompt_version),
      scannedReferences: Number(row.input_evidence_count),
      signalEvidence: Number(row.signal_evidence_count),
      interactionCandidates: Number(row.candidate_count),
      ignoredEvidence: Number(row.ignored_evidence_count),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      durationMs: Number(row.duration_ms),
      retryCount: Number(row.retry_count),
      errorCode: row.error_code ? String(row.error_code) : undefined,
    };
  }

  latestRunForJob(jobId: string, userId: number, workDate: string, now = new Date()): InteractionRunRecord | null {
    const row = this.db.prepare(
      `SELECT id FROM assistant_interaction_runs
        WHERE job_id = ? AND user_id = ? AND work_date = ? AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(jobId, userId, workDate, now.toISOString()) as { id: string } | undefined;
    return row ? this.getRun(row.id, userId) : null;
  }
}
