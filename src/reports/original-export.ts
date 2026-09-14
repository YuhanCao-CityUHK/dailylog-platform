import type { DatabaseSync } from "node:sqlite";

/** Only formats saved report fields. Never calls AI or reads source/context summaries. */
export function exportOriginalReport(db: DatabaseSync, userId: number, date: string): string | null {
  const log = db.prepare("SELECT id FROM logs WHERE user_id = ? AND date = ? AND status = 'submitted'")
    .get(userId, date) as { id: number } | undefined;
  if (!log) return null;
  const rows = db.prepare(`SELECT i.*, p.name AS current_project_name FROM log_items i
    LEFT JOIN projects p ON p.id = COALESCE(i.project_id, CAST(i.aff AS INTEGER))
    WHERE i.log_id = ? ORDER BY i.ord, i.id`).all(log.id) as Array<Record<string, unknown>>;
  const groups = new Map<string, { name: string; items: Array<Record<string, unknown>> }>();
  const hasText = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  for (const row of rows) {
    const key = String(row.project_id || row.aff || "dept");
    if (!groups.has(key)) groups.set(key, {
      name: key === "dept" ? "部门日常" : String(row.project_name_snapshot || row.current_project_name || "项目 " + key),
      items: [],
    });
    groups.get(key)!.items.push(row);
  }
  const lines = [date + " 工作日报"];
  let groupIndex = 0;
  for (const group of groups.values()) {
    lines.push("", "（" + (++groupIndex) + "）" + group.name);
    group.items.forEach((row, index) => {
      // Legacy form text and structured fields can coexist; preserve distinct saved content.
      const summary = hasText(row.work_summary) ? String(row.work_summary) : String(row.text ?? "");
      lines.push((index + 1) + ". " + summary);
      const seen = new Set([summary]);
      for (const [label, value] of [["结果 / 进展", row.result_text], ["原文补充", row.text]]) {
        if (hasText(value) && !seen.has(String(value))) {
          lines.push("   " + label + "：" + value);
          seen.add(String(value));
        }
      }
      if (row.hours !== null && row.hours !== undefined && row.hours !== "") {
        lines.push("   工时：" + row.hours + " 小时");
      }
      for (const [label, value] of [
        ["问题卡点", row.blocker_text], ["下一步计划", row.next_action],
        ["明日计划", row.tomorrow_plan], ["需要支持", row.support_needed],
      ]) {
        if (hasText(value)) lines.push("   " + label + "：" + value);
      }
      if (row.support_people_json) {
        try {
          const people: unknown = JSON.parse(String(row.support_people_json));
          if (Array.isArray(people) && people.some(hasText)) lines.push("   协作人：" + people.filter(hasText).join("、"));
        } catch { /* Old invalid optional metadata must not prevent exporting report text. */ }
      }
      lines.push("");
    });
    lines.pop();
  }
  return lines.join("\n");
}
