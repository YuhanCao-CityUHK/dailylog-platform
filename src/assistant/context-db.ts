import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "../infra/config";

let contextDb: DatabaseSync | null = null;

function migrateContextDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = db.prepare("SELECT 1 AS x FROM context_schema_migrations WHERE version = 1").get();
  if (!applied) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
      CREATE TABLE context_jobs (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        work_date TEXT NOT NULL,
        status TEXT NOT NULL,
        completeness TEXT NOT NULL DEFAULT 'manual',
        active INTEGER NOT NULL DEFAULT 1,
        refresh_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_context_jobs_active_user_date
        ON context_jobs(user_id, work_date) WHERE active = 1;
      CREATE INDEX idx_context_jobs_expires ON context_jobs(expires_at);

      CREATE TABLE context_source_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES context_jobs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        work_date TEXT NOT NULL,
        source_type TEXT NOT NULL,
        status TEXT NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 0,
        pages_fetched INTEGER NOT NULL DEFAULT 0,
        has_more INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT,
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        expires_at TEXT NOT NULL,
        UNIQUE (job_id, source_type)
      );
      CREATE INDEX idx_context_source_runs_job ON context_source_runs(job_id);
      CREATE INDEX idx_context_source_runs_expires ON context_source_runs(expires_at);

      CREATE TABLE context_evidences (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES context_jobs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        work_date TEXT NOT NULL,
        source_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        privacy_scope TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_cipher TEXT NOT NULL,
        payload_iv TEXT NOT NULL,
        payload_tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (user_id, source_type, external_id, content_hash)
      );
      CREATE INDEX idx_context_evidences_job ON context_evidences(job_id);
      CREATE INDEX idx_context_evidences_expires ON context_evidences(expires_at);

      CREATE TABLE context_references (
        id TEXT PRIMARY KEY,
        evidence_id TEXT NOT NULL REFERENCES context_evidences(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        work_date TEXT NOT NULL,
        privacy_scope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (evidence_id)
      );
      CREATE INDEX idx_context_references_user_date ON context_references(user_id, work_date);
      CREATE INDEX idx_context_references_expires ON context_references(expires_at);
      `);
      db.prepare(
        "INSERT INTO context_schema_migrations (version, name, applied_at) VALUES (1, 'context_jobs_and_evidence', ?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const sourceDiagnostics = db.prepare("SELECT 1 AS x FROM context_schema_migrations WHERE version = 2").get();
  if (!sourceDiagnostics) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE context_source_runs ADD COLUMN failure_stage TEXT;
        ALTER TABLE context_source_runs ADD COLUMN duration_ms INTEGER;
        UPDATE context_jobs SET active = 0 WHERE active = 1;
      `);
      db.prepare(
        "INSERT INTO context_schema_migrations (version, name, applied_at) VALUES (2, 'source_diagnostics_and_contract_refresh', ?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const responseContracts = db.prepare("SELECT 1 AS x FROM context_schema_migrations WHERE version = 3").get();
  if (!responseContracts) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("UPDATE context_jobs SET active = 0 WHERE active = 1;");
      db.prepare(
        "INSERT INTO context_schema_migrations (version, name, applied_at) VALUES (3, 'response_contract_shape_refresh', ?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const atomicTodoAndDocumentTargets = db.prepare("SELECT 1 AS x FROM context_schema_migrations WHERE version = 4").get();
  if (!atomicTodoAndDocumentTargets) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("UPDATE context_jobs SET active = 0 WHERE active = 1;");
      db.prepare(
        "INSERT INTO context_schema_migrations (version, name, applied_at) VALUES (4, 'atomic_todo_and_document_target_refresh', ?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const documentOptionalReadIsolation = db.prepare("SELECT 1 AS x FROM context_schema_migrations WHERE version = 5").get();
  if (!documentOptionalReadIsolation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("UPDATE context_jobs SET active = 0 WHERE active = 1;");
      db.prepare(
        "INSERT INTO context_schema_migrations (version, name, applied_at) VALUES (5, 'document_optional_read_isolation', ?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const completenessLedger = db.prepare("SELECT 1 AS x FROM context_schema_migrations WHERE version = 6").get();
  if (!completenessLedger) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE context_source_runs ADD COLUMN complete INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE context_source_runs ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE context_source_runs ADD COLUMN details_json TEXT;
        UPDATE context_jobs SET active = 0 WHERE active = 1;
      `);
      db.prepare(
        "INSERT INTO context_schema_migrations (version, name, applied_at) VALUES (6, 'source_completeness_ledger', ?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const workEvents = db.prepare("SELECT 1 AS x FROM context_schema_migrations WHERE version = 7").get();
  if (!workEvents) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE assistant_event_runs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES context_jobs(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL,
          work_date TEXT NOT NULL,
          status TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          prompt_version TEXT NOT NULL,
          input_evidence_count INTEGER NOT NULL DEFAULT 0,
          covered_evidence_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          created_at TEXT NOT NULL,
          finished_at TEXT,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_assistant_event_runs_job ON assistant_event_runs(job_id, user_id, work_date);
        CREATE INDEX idx_assistant_event_runs_expires ON assistant_event_runs(expires_at);

        CREATE TABLE assistant_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES assistant_event_runs(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          work_date TEXT NOT NULL,
          event_key TEXT NOT NULL,
          status TEXT NOT NULL,
          confidence REAL NOT NULL,
          payload_cipher TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_tag TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          UNIQUE (run_id, event_key)
        );
        CREATE INDEX idx_assistant_events_job ON assistant_events(job_id, user_id, work_date);
        CREATE INDEX idx_assistant_events_expires ON assistant_events(expires_at);

        CREATE TABLE assistant_event_claims (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES assistant_events(id) ON DELETE CASCADE,
          claim_type TEXT NOT NULL,
          payload_cipher TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_tag TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_assistant_event_claims_event ON assistant_event_claims(event_id);
        CREATE INDEX idx_assistant_event_claims_expires ON assistant_event_claims(expires_at);
        UPDATE context_jobs SET active = 0 WHERE active = 1;
      `);
      db.prepare(
        "INSERT INTO context_schema_migrations (version, name, applied_at) VALUES (7, 'encrypted_work_events_and_claims', ?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const interactionDiscovery = db.prepare("SELECT 1 AS x FROM context_schema_migrations WHERE version = 8").get();
  if (!interactionDiscovery) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE assistant_interaction_runs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES context_jobs(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL,
          work_date TEXT NOT NULL,
          status TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          prompt_version TEXT NOT NULL,
          input_evidence_count INTEGER NOT NULL DEFAULT 0,
          signal_evidence_count INTEGER NOT NULL DEFAULT 0,
          candidate_count INTEGER NOT NULL DEFAULT 0,
          ignored_evidence_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          created_at TEXT NOT NULL,
          finished_at TEXT,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_assistant_interaction_runs_job
          ON assistant_interaction_runs(job_id, user_id, work_date, created_at);
        CREATE INDEX idx_assistant_interaction_runs_expires ON assistant_interaction_runs(expires_at);

        CREATE TABLE assistant_interaction_candidates (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES assistant_interaction_runs(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          work_date TEXT NOT NULL,
          candidate_key TEXT NOT NULL,
          direction TEXT NOT NULL,
          state TEXT NOT NULL,
          priority TEXT NOT NULL,
          confidence REAL NOT NULL,
          latest_at TEXT NOT NULL,
          signal_count INTEGER NOT NULL DEFAULT 0,
          self_action_supported INTEGER NOT NULL DEFAULT 0,
          result_supported INTEGER NOT NULL DEFAULT 0,
          payload_cipher TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_tag TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          UNIQUE (run_id, candidate_key)
        );
        CREATE INDEX idx_assistant_interaction_candidates_job
          ON assistant_interaction_candidates(job_id, user_id, work_date);
        CREATE INDEX idx_assistant_interaction_candidates_expires ON assistant_interaction_candidates(expires_at);

        CREATE TABLE assistant_task_signals (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES assistant_interaction_runs(id) ON DELETE CASCADE,
          candidate_id TEXT REFERENCES assistant_interaction_candidates(id) ON DELETE CASCADE,
          reference_id TEXT NOT NULL REFERENCES context_references(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL,
          work_date TEXT NOT NULL,
          direction TEXT NOT NULL,
          intent TEXT NOT NULL,
          target_relation TEXT NOT NULL,
          confidence REAL NOT NULL,
          action_supported INTEGER NOT NULL DEFAULT 0,
          result_supported INTEGER NOT NULL DEFAULT 0,
          ignored_reason TEXT,
          payload_cipher TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_tag TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          UNIQUE (run_id, reference_id, candidate_id)
        );
        CREATE INDEX idx_assistant_task_signals_run ON assistant_task_signals(run_id, candidate_id);
        CREATE INDEX idx_assistant_task_signals_reference ON assistant_task_signals(reference_id);
        CREATE INDEX idx_assistant_task_signals_expires ON assistant_task_signals(expires_at);
      `);
      db.prepare(
        "INSERT INTO context_schema_migrations (version, name, applied_at) VALUES (8, 'encrypted_interaction_discovery', ?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createContextDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateContextDatabase(db);
  return db;
}

export function getContextDb(): DatabaseSync {
  if (!contextDb) contextDb = createContextDatabase(CONFIG.assistant.contextDbPath);
  return contextDb;
}

export function listContextMigrations(db: DatabaseSync): Array<{ version: number; name: string; applied_at: string }> {
  return db
    .prepare("SELECT version, name, applied_at FROM context_schema_migrations ORDER BY version")
    .all() as unknown as Array<{ version: number; name: string; applied_at: string }>;
}
