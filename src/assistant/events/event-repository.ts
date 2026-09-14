import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptJson, encryptJson } from "../crypto";
import type { EventClaim, WorkEvent } from "./event-types";

export interface EventRunRecord {
  id: string;
  status: "running" | "complete" | "partial" | "failed";
  provider?: string;
  model?: string;
  promptVersion: string;
  inputEvidenceCount: number;
  coveredEvidenceCount: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  retryCount: number;
  errorCode?: string;
}

export interface FinishEventRunInput {
  status: EventRunRecord["status"];
  provider?: string;
  model?: string;
  inputEvidenceCount: number;
  coveredEvidenceCount: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  retryCount?: number;
  errorCode?: string;
}

function eventAad(userId: number, workDate: string, eventId: string): string {
  return `${userId}:${workDate}:event:${eventId}`;
}

function claimAad(userId: number, workDate: string, eventId: string): string {
  return `${userId}:${workDate}:claim:${eventId}`;
}

export class EventRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
  ) {}

  createRun(
    jobId: string,
    userId: number,
    workDate: string,
    promptVersion: string,
    expiresAt: string,
    now = new Date(),
  ): string {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO assistant_event_runs
        (id, job_id, user_id, work_date, status, prompt_version, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(id, jobId, userId, workDate, promptVersion, now.toISOString(), expiresAt);
    return id;
  }

  finishRun(runId: string, input: FinishEventRunInput, now = new Date()): void {
    this.db.prepare(
      `UPDATE assistant_event_runs SET
        status = ?, provider = ?, model = ?, input_evidence_count = ?, covered_evidence_count = ?,
        input_tokens = ?, output_tokens = ?, duration_ms = ?, retry_count = ?, error_code = ?, finished_at = ?
       WHERE id = ?`,
    ).run(
      input.status,
      input.provider ?? null,
      input.model ?? null,
      input.inputEvidenceCount,
      input.coveredEvidenceCount,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.durationMs ?? 0,
      input.retryCount ?? 0,
      input.errorCode ?? null,
      now.toISOString(),
      runId,
    );
  }

  replaceEvents(
    runId: string,
    jobId: string,
    userId: number,
    workDate: string,
    events: WorkEvent[],
    expiresAt: string,
    now = new Date(),
  ): void {
    const stamp = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM assistant_events WHERE run_id = ?").run(runId);
      for (const event of events) {
        const eventId = randomUUID();
        const payload = encryptJson({ ...event, claims: [] }, this.key, eventAad(userId, workDate, eventId));
        this.db.prepare(
          `INSERT INTO assistant_events
            (id, run_id, job_id, user_id, work_date, event_key, status, confidence,
             payload_cipher, payload_iv, payload_tag, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          eventId, runId, jobId, userId, workDate, event.eventKey, event.status, event.confidence,
          payload.cipher, payload.iv, payload.tag, stamp, expiresAt,
        );
        for (const claim of event.claims) {
          const encrypted = encryptJson(claim, this.key, claimAad(userId, workDate, eventId));
          this.db.prepare(
            `INSERT INTO assistant_event_claims
              (id, event_id, claim_type, payload_cipher, payload_iv, payload_tag, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(randomUUID(), eventId, claim.type, encrypted.cipher, encrypted.iv, encrypted.tag, stamp, expiresAt);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listForJob(jobId: string, userId: number, workDate: string, now = new Date()): WorkEvent[] {
    const rows = this.db.prepare(
      `SELECT e.id, e.payload_cipher, e.payload_iv, e.payload_tag
         FROM assistant_events e JOIN assistant_event_runs r ON r.id = e.run_id
        WHERE e.job_id = ? AND e.user_id = ? AND e.work_date = ?
          AND e.expires_at > ? AND r.status IN ('complete', 'partial')
          AND r.id = (
            SELECT id FROM assistant_event_runs
             WHERE job_id = ? AND user_id = ? AND work_date = ? AND status IN ('complete', 'partial') AND expires_at > ?
             ORDER BY created_at DESC LIMIT 1
          )
        ORDER BY e.created_at, e.id`,
    ).all(
      jobId, userId, workDate, now.toISOString(),
      jobId, userId, workDate, now.toISOString(),
    ) as unknown as Array<{ id: string; payload_cipher: string; payload_iv: string; payload_tag: string }>;
    return rows.map((row) => {
      const event = decryptJson<WorkEvent>(
        { cipher: row.payload_cipher, iv: row.payload_iv, tag: row.payload_tag },
        this.key,
        eventAad(userId, workDate, row.id),
      );
      const claims = this.db.prepare(
        `SELECT payload_cipher, payload_iv, payload_tag FROM assistant_event_claims
          WHERE event_id = ? AND expires_at > ? ORDER BY created_at, id`,
      ).all(row.id, now.toISOString()) as unknown as Array<{ payload_cipher: string; payload_iv: string; payload_tag: string }>;
      return {
        ...event,
        claims: claims.map((claim) => decryptJson<EventClaim>(
          { cipher: claim.payload_cipher, iv: claim.payload_iv, tag: claim.payload_tag },
          this.key,
          claimAad(userId, workDate, row.id),
        )),
      };
    });
  }

  getRun(runId: string, userId: number): EventRunRecord | null {
    const row = this.db.prepare(
      `SELECT id, status, provider, model, prompt_version, input_evidence_count, covered_evidence_count,
              input_tokens, output_tokens, duration_ms, retry_count, error_code
         FROM assistant_event_runs WHERE id = ? AND user_id = ?`,
    ).get(runId, userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      status: row.status as EventRunRecord["status"],
      provider: row.provider ? String(row.provider) : undefined,
      model: row.model ? String(row.model) : undefined,
      promptVersion: String(row.prompt_version),
      inputEvidenceCount: Number(row.input_evidence_count),
      coveredEvidenceCount: Number(row.covered_evidence_count),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      durationMs: Number(row.duration_ms),
      retryCount: Number(row.retry_count),
      errorCode: row.error_code ? String(row.error_code) : undefined,
    };
  }

  latestRunForJob(jobId: string, userId: number, workDate: string, now = new Date()): EventRunRecord | null {
    const row = this.db.prepare(
      `SELECT id FROM assistant_event_runs
        WHERE job_id = ? AND user_id = ? AND work_date = ? AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(jobId, userId, workDate, now.toISOString()) as { id: string } | undefined;
    return row ? this.getRun(row.id, userId) : null;
  }
}
