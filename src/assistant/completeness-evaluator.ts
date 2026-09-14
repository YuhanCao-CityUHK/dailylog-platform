import type { DatabaseSync } from "node:sqlite";
import { listFinanceProjectCodes } from "../platform/finance-project-codes";
import type { AssistantSession, AssistantSessionItem } from "./conversation-schema";

export type MissingFact =
  | { kind: "confirm_candidates"; itemIds: number[] }
  | { kind: "result"; itemIds: number[] }
  | { kind: "person"; itemIds: number[] }
  | { kind: "outside_work"; itemIds: number[] }
  | { kind: "project"; itemIds: number[] }
  | { kind: "finance_code"; itemIds: number[] }
  | { kind: "hours"; itemIds: number[] }
  | { kind: "blocked_loop"; itemIds: number[] }
  | { kind: "manual_start"; itemIds: number[] };

function itemHasResult(item: AssistantSessionItem): boolean {
  if (item.resultText.trim()) return true;
  return item.workStatus === "no_progress" && Boolean(item.blockerText.trim() || item.nextAction.trim());
}

/** 按工作闭环评估，不机械要求本来就不适用的空字段。 */
export function nextMissingFact(session: AssistantSession, db?: DatabaseSync): MissingFact | null {
  if (session.items.length === 0) return { kind: "manual_start", itemIds: [] };
  const unconfirmed = session.items.filter((item) => !item.employeeConfirmed).map((item) => item.id);
  if (unconfirmed.length) return { kind: "confirm_candidates", itemIds: unconfirmed };
  const missingResult = session.items.filter((item) => !itemHasResult(item)).map((item) => item.id);
  if (missingResult.length) return { kind: "result", itemIds: missingResult };
  const ambiguousPeople = session.items
    .filter((item) => /(?:同事|领导|他们|她们|研发那边)/.test(`${item.resultText} ${item.blockerText} ${item.nextAction}`))
    .map((item) => item.id);
  if (ambiguousPeople.length) return { kind: "person", itemIds: ambiguousPeople };
  const missingProject = session.items.filter((item) => item.scopeType === "unconfirmed").map((item) => item.id);
  if (missingProject.length) return { kind: "project", itemIds: missingProject };
  const missingFinanceCode = session.items
    .filter((item) => item.scopeType === "project" && item.projectId && !item.financeCodeId && db && listFinanceProjectCodes(item.projectId, db).length > 0)
    .map((item) => item.id);
  if (missingFinanceCode.length) return { kind: "finance_code", itemIds: missingFinanceCode };
  const missingHours = session.items.filter((item) => item.hours === null).map((item) => item.id);
  if (missingHours.length) return { kind: "hours", itemIds: missingHours };
  const openBlocked = session.items
    .filter(
      (item) =>
        (item.workStatus === "blocked" || item.blockerText.trim()) &&
        !item.nextAction.trim() &&
        !item.supportNeeded.trim(),
    )
    .map((item) => item.id);
  if (openBlocked.length) return { kind: "blocked_loop", itemIds: openBlocked };
  return session.outsideWorkAnswered ? null : { kind: "outside_work", itemIds: [] };
}
