import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { CollectorResult, CollectorSourceType } from "./schema";

export type ContextJobStatus = "queued" | "running" | "complete" | "partial" | "manual" | "failed";
export type ContextCompleteness = "complete" | "partial" | "manual";

export interface ContextSourceRunView {
  source: CollectorSourceType;
  status: string;
  itemCount: number;
  pagesFetched: number;
  hasMore: boolean;
  complete: boolean;
  failures: number;
  details?: NonNullable<CollectorResult["completeness"]>["details"];
  stopReason?: string;
  errorCode?: string;
  failureStage?: string;
  durationMs?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface ContextJobView {
  id: string;
  userId: number;
  workDate: string;
  status: ContextJobStatus;
  completeness: ContextCompleteness;
  refreshCount: number;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  sources: ContextSourceRunView[];
}

function jobExpiry(now: Date, ttlHours: number): string {
  return new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();
}

export class ContextJobStore {
  constructor(private readonly db: DatabaseSync) {}

  createOrReuse(
    userId: number,
    workDate: string,
    ttlHours: number,
    refresh: boolean,
    now = new Date(),
  ): { job: ContextJobView; shouldRun: boolean } {
    const stamp = now.toISOString();
    const existing = this.db
      .prepare("SELECT id, status, expires_at, refresh_count FROM context_jobs WHERE user_id = ? AND work_date = ? AND active = 1")
      .get(userId, workDate) as { id: string; status: ContextJobStatus; expires_at: string; refresh_count: number } | undefined;
    if (existing && existing.expires_at <= stamp) {
      this.db.prepare("UPDATE context_jobs SET active = 0 WHERE id = ?").run(existing.id);
    } else if (existing) {
      if (refresh && existing.status !== "running" && existing.status !== "queued") {
        const id = randomUUID();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare("UPDATE context_jobs SET active = 0, updated_at = ? WHERE id = ?").run(stamp, existing.id);
          this.db.prepare(
            `INSERT INTO context_jobs
              (id, user_id, work_date, status, completeness, active, refresh_count, created_at, updated_at, expires_at)
             VALUES (?, ?, ?, 'queued', 'manual', 1, ?, ?, ?, ?)`,
          ).run(id, userId, workDate, existing.refresh_count + 1, stamp, stamp, jobExpiry(now, ttlHours));
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        return { job: this.get(id, userId)!, shouldRun: true };
      }
      return { job: this.get(existing.id, userId)!, shouldRun: existing.status === "queued" };
    }

    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO context_jobs
        (id, user_id, work_date, status, completeness, active, refresh_count, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, 'queued', 'manual', 1, 0, ?, ?, ?)`,
    ).run(id, userId, workDate, stamp, stamp, jobExpiry(now, ttlHours));
    return { job: this.get(id, userId)!, shouldRun: true };
  }

  markRunning(jobId: string, now = new Date()): void {
    this.db.prepare("UPDATE context_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(now.toISOString(), jobId);
  }

  markSourceRunning(
    jobId: string,
    userId: number,
    workDate: string,
    source: CollectorSourceType,
    expiresAt: string,
    now = new Date(),
  ): void {
    this.db.prepare(
      `INSERT INTO context_source_runs
        (job_id, user_id, work_date, source_type, status, started_at, expires_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)
       ON CONFLICT(job_id, source_type) DO UPDATE SET
         status = 'running', item_count = 0, pages_fetched = 0, has_more = 0,
         complete = 0, failures = 0, details_json = NULL,
         stop_reason = NULL, error_code = NULL, failure_stage = NULL, duration_ms = NULL,
         started_at = excluded.started_at,
         finished_at = NULL, expires_at = excluded.expires_at`,
    ).run(jobId, userId, workDate, source, now.toISOString(), expiresAt);
  }

  markSourceResult(jobId: string, result: CollectorResult, now = new Date()): void {
    const complete = result.completeness?.complete ?? (result.status === "complete" || result.status === "empty");
    const failures = result.completeness?.failures ?? (result.status === "error" ? 1 : 0);
    this.db.prepare(
      `UPDATE context_source_runs
          SET status = ?, item_count = ?, pages_fetched = ?, has_more = ?, complete = ?, failures = ?,
              details_json = ?, stop_reason = ?,
              error_code = ?, failure_stage = ?, duration_ms = ?, finished_at = ?
        WHERE job_id = ? AND source_type = ?`,
    ).run(
      result.status,
      result.completeness?.itemCount ?? result.evidences.length,
      result.completeness?.pagesFetched ?? 0,
      result.completeness?.hasMore ? 1 : 0,
      complete ? 1 : 0,
      failures,
      result.completeness?.details ? JSON.stringify(result.completeness.details) : null,
      result.completeness?.stopReason ?? (result.status === "error" ? result.errorCode ?? "collector_failed" : null),
      result.errorCode ?? null,
      result.failureStage ?? null,
      result.durationMs ?? null,
      now.toISOString(),
      jobId,
      result.source,
    );
  }

  finish(
    jobId: string,
    status: ContextJobStatus,
    completeness: ContextCompleteness,
    errorCode?: string,
    now = new Date(),
  ): void {
    this.db.prepare(
      "UPDATE context_jobs SET status = ?, completeness = ?, error_code = ?, updated_at = ? WHERE id = ?",
    ).run(status, completeness, errorCode ?? null, now.toISOString(), jobId);
  }

  get(jobId: string, userId: number): ContextJobView | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, work_date, status, completeness, refresh_count, error_code,
                created_at, updated_at, expires_at
           FROM context_jobs WHERE id = ? AND user_id = ? AND active = 1`,
      )
      .get(jobId, userId) as
      | {
          id: string;
          user_id: number;
          work_date: string;
          status: ContextJobStatus;
          completeness: ContextCompleteness;
          refresh_count: number;
          error_code: string | null;
          created_at: string;
          updated_at: string;
          expires_at: string;
        }
      | undefined;
    if (!row) return null;
    const sources = this.db
      .prepare(
        `SELECT source_type, status, item_count, pages_fetched, has_more, complete, failures, details_json, stop_reason,
                error_code, failure_stage, duration_ms, started_at, finished_at
           FROM context_source_runs WHERE job_id = ? ORDER BY id`,
      )
      .all(jobId) as unknown as Array<{
      source_type: CollectorSourceType;
      status: string;
      item_count: number;
      pages_fetched: number;
      has_more: number;
      complete: number;
      failures: number;
      details_json: string | null;
      stop_reason: string | null;
      error_code: string | null;
      failure_stage: string | null;
      duration_ms: number | null;
      started_at: string;
      finished_at: string | null;
    }>;
    return {
      id: row.id,
      userId: row.user_id,
      workDate: row.work_date,
      status: row.status,
      completeness: row.completeness,
      refreshCount: row.refresh_count,
      errorCode: row.error_code ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      sources: sources.map((source) => ({
        source: source.source_type,
        status: source.status,
        itemCount: source.item_count,
        pagesFetched: source.pages_fetched,
        hasMore: source.has_more === 1,
        complete: source.complete === 1,
        failures: source.failures,
        details: source.details_json ? JSON.parse(source.details_json) : undefined,
        stopReason: source.stop_reason ?? undefined,
        errorCode: source.error_code ?? undefined,
        failureStage: source.failure_stage ?? undefined,
        durationMs: source.duration_ms ?? undefined,
        startedAt: source.started_at,
        finishedAt: source.finished_at ?? undefined,
      })),
    };
  }

  getActive(userId: number, workDate: string, now = new Date()): ContextJobView | null {
    const row = this.db
      .prepare(
        `SELECT id FROM context_jobs
          WHERE user_id = ? AND work_date = ? AND active = 1 AND expires_at > ?`,
      )
      .get(userId, workDate, now.toISOString()) as { id: string } | undefined;
    return row ? this.get(row.id, userId) : null;
  }
}
