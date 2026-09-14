import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createContextDatabase, listContextMigrations } from "../src/assistant/context-db";
import { ContextJobStore } from "../src/assistant/context-jobs";
import { EvidenceStore } from "../src/assistant/evidence-store";

test("临时证据加密保存、仅本人可见并在过期后清理", () => {
  const db = createContextDatabase(":memory:");
  assert.deepEqual(listContextMigrations(db).map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  const jobs = new ContextJobStore(db);
  const now = new Date("2026-08-25T08:00:00.000Z");
  const job = jobs.createOrReuse(1, "2026-08-25", 12, false, now).job;
  const store = new EvidenceStore(db, Buffer.alloc(32, 7));
  const expiresAt = "2026-08-25T20:00:00.000Z";
  const referenceId = store.put(
    job.id,
    1,
    "2026-08-25",
    {
      sourceType: "chat_private",
      externalId: "message-sensitive-id",
      title: "私聊中的项目结论",
      summary: "完成账号隔离验证",
      occurredAt: "2026-08-25T09:00:00+08:00",
      actorUserIds: ["user-1"],
      actorNames: ["测试员工"],
      participantNames: ["协作员工"],
      privacyScope: "employee_only",
      projectSignals: ["日报项目"],
      evidenceStrength: "medium",
    },
    expiresAt,
    now,
  );
  const raw = db
    .prepare("SELECT external_id, payload_cipher FROM context_evidences")
    .get() as { external_id: string; payload_cipher: string };
  assert.notEqual(raw.external_id, "message-sensitive-id");
  assert.doesNotMatch(raw.payload_cipher, /私聊|账号隔离|测试员工/);
  assert.equal(store.get(referenceId, 2, now), null, "其他员工不能读取 Reference");
  assert.equal(store.get(referenceId, 1, now)?.summary, "完成账号隔离验证");
  assert.equal(store.get(referenceId, 1, new Date(expiresAt)), null, "到期时立即不可访问");
  const deleted = store.cleanupExpired(new Date(expiresAt));
  assert.deepEqual(deleted, { references: 1, evidences: 1, jobs: 1 });
  db.close();
});

test("v1 上下文库增量迁移到 v8 并使旧活动任务失效", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dailylog-context-migration-"));
  const file = path.join(directory, "context.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE context_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO context_schema_migrations VALUES (1, 'context_jobs_and_evidence', '2026-08-24T00:00:00Z');
    CREATE TABLE context_jobs (id TEXT PRIMARY KEY, active INTEGER NOT NULL);
    INSERT INTO context_jobs VALUES ('old-job', 1);
    CREATE TABLE context_source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(job_id, source_type)
    );
  `);
  legacy.close();
  const migrated = createContextDatabase(file);
  assert.deepEqual(listContextMigrations(migrated).map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  const columns = migrated.prepare("PRAGMA table_info(context_source_runs)").all() as unknown as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "failure_stage"), true);
  assert.equal(columns.some((column) => column.name === "duration_ms"), true);
  assert.equal((migrated.prepare("SELECT active FROM context_jobs WHERE id = 'old-job'").get() as { active: number }).active, 0);
  migrated.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("助手页面以紧凑方式持续展示已读取、部分读取和暂不可用来源", () => {
  const script = fs.readFileSync(path.resolve("public/app.js"), "utf8");
  assert.match(script, /已读取：/);
  assert.match(script, /暂不可用：/);
  assert.match(script, /source\.status === "partial"/);
  assert.match(script, /assistantSourceStatusHtml\(\(contextData\.job/);
});
