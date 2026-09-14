import type { DatabaseSync } from "node:sqlite";

export interface TaskSignalSecret {
  itemKey: string;
  title: string;
  referenceIds: string[];
}

interface DraftTaskSignalLike {
  itemId: string;
  summary: string;
  result: string;
  blocker: string;
  nextAction: string;
  supportNeeded: string;
  supportPeople: string[];
  tomorrowPlan: string;
  confirmed: boolean;
  referenceIds: string[];
  needsConfirmation: string[];
}

function stringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function uniqueTerms(secrets: TaskSignalSecret[]): string[] {
  return [...new Set(secrets.flatMap((secret) => [secret.title, ...secret.referenceIds]).map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

function redactText(value: string, terms: string[]): string {
  return terms.reduce((result, term) => result.split(term).join("[已清除的任务线索]"), value);
}

function redactValue(value: unknown, terms: string[], removedItemKeys: Set<string>): unknown {
  if (typeof value === "string") return redactText(value, terms);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, terms, removedItemKeys));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "items" && Array.isArray(child)) {
      result[key] = child
        .filter((entry) => !entry || typeof entry !== "object" || !removedItemKeys.has(String((entry as Record<string, unknown>).itemId ?? "")))
        .map((entry) => redactValue(entry, terms, removedItemKeys));
      continue;
    }
    result[key] = redactValue(child, terms, removedItemKeys);
  }
  return result;
}

function redactJson(value: string, terms: string[], removedItemKeys: Set<string>): string {
  try {
    return JSON.stringify(redactValue(JSON.parse(value) as unknown, terms, removedItemKeys));
  } catch {
    return redactText(value, terms);
  }
}

function redactSnapshotJson(value: string, terms: string[], removedItemKeys: Set<string>): string {
  try {
    const parsed = JSON.parse(value) as { items?: unknown[] };
    if (Array.isArray(parsed.items)) {
      parsed.items = parsed.items.filter(
        (entry) => !entry || typeof entry !== "object" || !removedItemKeys.has(String((entry as Record<string, unknown>).itemId ?? "")),
      );
      parsed.items.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") return;
        (entry as Record<string, unknown>).order = index + 1;
        (entry as Record<string, unknown>).displayAlias = `第 ${index + 1} 项`;
      });
    }
    return JSON.stringify(redactValue(parsed, terms, removedItemKeys));
  } catch {
    return redactText(value, terms);
  }
}

export function isUnconfirmedTaskSignal(item: Pick<DraftTaskSignalLike, "confirmed" | "needsConfirmation">): boolean {
  return !item.confirmed && item.needsConfirmation.includes("task_signal");
}

export function taskSignalSecretFromDraft(item: DraftTaskSignalLike): TaskSignalSecret {
  return {
    itemKey: item.itemId,
    title: item.summary,
    referenceIds: [...item.referenceIds],
  };
}

export function taskSignalSecretFromRow(row: Record<string, unknown>): TaskSignalSecret {
  return {
    itemKey: String(row.item_key ?? ""),
    title: String(row.work_summary ?? "").trim(),
    referenceIds: stringArray(row.reference_ids_json),
  };
}

export function listUnconfirmedTaskSignalSecrets(db: DatabaseSync, sessionId: number): TaskSignalSecret[] {
  return (db.prepare(
    `SELECT item_key, work_summary, reference_ids_json
       FROM assistant_session_items
      WHERE session_id = ? AND source_kind = 'candidate' AND employee_confirmed = 0
        AND needs_confirmation_json LIKE '%"task_signal"%'`,
  ).all(sessionId) as unknown as Array<Record<string, unknown>>).map(taskSignalSecretFromRow);
}

export function redactTaskSignalValue<T>(value: T, secrets: TaskSignalSecret[]): T {
  return redactValue(value, uniqueTerms(secrets), new Set()) as T;
}

/**
 * Remove candidate-derived task details from durable assistant output and change snapshots.
 * Call this inside the same transaction that hard-deletes the corresponding session items.
 */
export function scrubTaskSignalSecrets(db: DatabaseSync, sessionId: number, secrets: TaskSignalSecret[]): void {
  if (!secrets.length) return;
  const terms = uniqueTerms(secrets);
  const removedItemKeys = new Set(secrets.map((secret) => secret.itemKey).filter(Boolean));

  const messages = db.prepare(
    `SELECT id, content, structured_json, focus_json, tool_trace_json
       FROM assistant_messages
      WHERE session_id = ? AND role <> 'user'`,
  ).all(sessionId) as unknown as Array<{
    id: number;
    content: string;
    structured_json: string;
    focus_json: string;
    tool_trace_json: string;
  }>;
  const updateMessage = db.prepare(
    `UPDATE assistant_messages
        SET content = ?, structured_json = ?, focus_json = ?, tool_trace_json = ?
      WHERE id = ? AND session_id = ?`,
  );
  for (const message of messages) {
    updateMessage.run(
      redactText(message.content, terms),
      redactJson(message.structured_json, terms, removedItemKeys),
      redactJson(message.focus_json, terms, removedItemKeys),
      redactJson(message.tool_trace_json, terms, removedItemKeys),
      message.id,
      sessionId,
    );
  }

  const changes = db.prepare(
    `SELECT change_id, before_json, after_json, receipts_json, operations_json
       FROM assistant_changes
      WHERE session_id = ?`,
  ).all(sessionId) as unknown as Array<{
    change_id: string;
    before_json: string;
    after_json: string;
    receipts_json: string;
    operations_json: string;
  }>;
  const updateChange = db.prepare(
    `UPDATE assistant_changes
        SET before_json = ?, after_json = ?, receipts_json = ?, operations_json = ?
      WHERE change_id = ? AND session_id = ?`,
  );
  for (const change of changes) {
    updateChange.run(
      redactSnapshotJson(change.before_json, terms, removedItemKeys),
      redactSnapshotJson(change.after_json, terms, removedItemKeys),
      redactJson(change.receipts_json, terms, removedItemKeys),
      redactJson(change.operations_json, terms, removedItemKeys),
      change.change_id,
      sessionId,
    );
  }
}
