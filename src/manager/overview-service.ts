import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { addDaysYmd } from "../infra/workcal";
import { canViewProjectReports } from "../projects/permissions";

interface ManagerItemRow {
  item_id: number;
  user_id: number;
  employee_name: string;
  employee_dept: string;
  project_id: number | null;
  project_name: string | null;
  project_status: string | null;
  owner_name: string | null;
  work_status: string;
  work_summary: string;
  result_text: string;
  hours: number;
  blocker_text: string;
  next_action: string;
  support_needed: string;
  support_people_json: string;
  tomorrow_plan: string;
}

function managedDepartments(user: SessionUser, db: DatabaseSync): Set<string> {
  const departments = new Set<string>();
  const rows = db
    .prepare("SELECT department_name FROM department_managers WHERE manager_user_id = ?")
    .all(user.id) as unknown as Array<{ department_name: string }>;
  for (const row of rows) if (row.department_name.trim()) departments.add(row.department_name.trim());
  if (departments.size === 0 && user.role === "mgr" && user.dept.trim()) departments.add(user.dept.trim());
  return departments;
}

function scopedEmployeeIds(user: SessionUser, db: DatabaseSync): number[] | null {
  if (user.role === "exec" || user.role === "admin") return null;
  if (user.role === "lead") {
    const rows = db
      .prepare(
        `SELECT DISTINCT pm.user_id AS id FROM projects p
          JOIN project_members pm ON pm.project_id = p.id
         WHERE p.owner_user_id = ? AND p.source <> 'dingtalk'`,
      )
      .all(user.id) as unknown as Array<{ id: number }>;
    return [...new Set([user.id, ...rows.map((row) => row.id)])];
  }
  const departments = [...managedDepartments(user, db)];
  if (!departments.length) return [user.id];
  const rows = db
    .prepare(`SELECT id FROM users WHERE active = 1 AND is_external = 0 AND dept IN (${departments.map(() => "?").join(",")})`)
    .all(...(departments as never[])) as unknown as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

function departmentDailyIds(user: SessionUser, db: DatabaseSync): number[] | null {
  if (user.role === "exec" || user.role === "admin") return null;
  if (user.role === "lead") return [user.id];
  return scopedEmployeeIds(user, db);
}

function safePeople(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function publicItem(row: ManagerItemRow) {
  return {
    itemId: row.item_id,
    employeeId: row.user_id,
    employeeName: row.employee_name,
    employeeDepartment: row.employee_dept,
    status: row.work_status,
    workSummary: row.work_summary,
    resultText: row.result_text,
    hours: Number(row.hours) || 0,
    blockerText: row.blocker_text || undefined,
    nextAction: row.next_action || undefined,
    supportNeeded: row.support_needed || undefined,
    supportPeople: safePeople(row.support_people_json),
    tomorrowPlan: row.tomorrow_plan || undefined,
  };
}

function sumHours(rows: ManagerItemRow[]): number {
  return Math.round(rows.reduce((sum, row) => sum + (Number(row.hours) || 0), 0) * 100) / 100;
}

function itemRows(workDate: string, db: DatabaseSync): ManagerItemRow[] {
  return db
    .prepare(
      `SELECT i.id AS item_id, l.user_id, u.name AS employee_name, u.dept AS employee_dept,
              i.project_id, COALESCE(i.project_name_snapshot, p.name) AS project_name,
              p.status AS project_status, owner.name AS owner_name,
              COALESCE(i.work_status, 'in_progress') AS work_status,
              COALESCE(NULLIF(i.work_summary, ''), i.text) AS work_summary,
              COALESCE(NULLIF(i.result_text, ''), i.text) AS result_text,
              i.hours, COALESCE(i.blocker_text, '') AS blocker_text,
              COALESCE(i.next_action, '') AS next_action,
              COALESCE(i.support_needed, '') AS support_needed,
              COALESCE(i.support_people_json, '[]') AS support_people_json,
              COALESCE(i.tomorrow_plan, '') AS tomorrow_plan
         FROM log_items i JOIN logs l ON l.id = i.log_id
         JOIN users u ON u.id = l.user_id
         LEFT JOIN projects p ON p.id = i.project_id
         LEFT JOIN users owner ON owner.id = p.owner_user_id
        WHERE l.status = 'submitted' AND l.date = ?
        ORDER BY i.project_id, i.id`,
    )
    .all(workDate) as unknown as ManagerItemRow[];
}

export interface ManagerOverview {
  workDate: string;
  submission: {
    expected: number;
    submitted: number;
    rate: number;
    missingPeople: Array<{ id: number; name: string; department: string }>;
  };
  totals: { projects: number; resultItems: number; blockedItems: number };
  needsAttention: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  departmentDaily: Array<Record<string, unknown>>;
  hoursByDepartment: Array<{ department: string; hours: number }>;
}

/** 只从正式 logs/log_items 读取；从不接触助手会话、Reference 或临时上下文库。 */
export function buildManagerOverview(user: SessionUser, workDate: string, db: DatabaseSync): ManagerOverview {
  if (!/[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(workDate)) throw new Error("invalid_work_date");
  const rows = itemRows(workDate, db);
  const visibleProjectIds = new Set(
    (db.prepare("SELECT id FROM projects WHERE source <> 'dingtalk'").all() as unknown as Array<{ id: number }>)
      .filter((project) => canViewProjectReports(user, project.id, db))
      .map((project) => project.id),
  );
  const projectRows = rows.filter((row) => row.project_id && visibleProjectIds.has(row.project_id));
  const dailyScope = departmentDailyIds(user, db);
  const departmentRows = rows.filter(
    (row) => !row.project_id && (dailyScope === null || dailyScope.includes(row.user_id)),
  );
  const visibleRows = [...projectRows, ...departmentRows];

  const expectedScope = scopedEmployeeIds(user, db);
  const expected = db
    .prepare(
      `SELECT u.id, u.name, u.dept FROM users u
        LEFT JOIN employee_day_status ds ON ds.user_id = u.id AND ds.work_date = ?
        WHERE u.active = 1 AND u.is_external = 0 AND u.should_submit = 1
          AND COALESCE(ds.status, 'normal') <> 'full_leave'
          ${expectedScope === null ? "" : `AND u.id IN (${expectedScope.map(() => "?").join(",") || "0"})`}
        ORDER BY u.id`,
    )
    .all(workDate, ...((expectedScope ?? []) as never[])) as unknown as Array<{ id: number; name: string; dept: string }>;
  const expectedIds = new Set(expected.map((person) => person.id));
  const submittedIds = new Set(
    (db
      .prepare(
        `SELECT DISTINCT user_id FROM logs WHERE status = 'submitted' AND date = ?
          ${expectedScope === null ? "" : `AND user_id IN (${expectedScope.map(() => "?").join(",") || "0"})`}`,
      )
      .all(workDate, ...((expectedScope ?? []) as never[])) as unknown as Array<{ user_id: number }>).map((row) => row.user_id).filter((id) => expectedIds.has(id)),
  );
  const missingPeople = expected.filter((person) => !submittedIds.has(person.id)).map((person) => ({
    id: person.id,
    name: person.name,
    department: person.dept,
  }));

  const grouped = new Map<number, ManagerItemRow[]>();
  for (const row of projectRows) {
    const list = grouped.get(row.project_id!) ?? [];
    list.push(row);
    grouped.set(row.project_id!, list);
  }
  const projects = [...grouped.entries()].map(([projectId, items]) => ({
    projectId,
    projectName: items[0].project_name || `项目 ${projectId}`,
    status: items[0].project_status === "completed" ? "completed" : "in_progress",
    ownerName: items[0].owner_name || "",
    participantCount: new Set(items.map((item) => item.user_id)).size,
    totalHours: sumHours(items),
    results: items.filter((item) => item.result_text).map(publicItem),
    blockers: items.filter((item) => item.blocker_text || item.work_status === "blocked").map(publicItem),
    support: items.filter((item) => item.support_needed).map(publicItem),
    tomorrowPlans: items.filter((item) => item.tomorrow_plan).map(publicItem),
    employeeItems: items.map(publicItem),
  }));

  const dailyByEmployee = new Map<number, ManagerItemRow[]>();
  for (const row of departmentRows) {
    const list = dailyByEmployee.get(row.user_id) ?? [];
    list.push(row);
    dailyByEmployee.set(row.user_id, list);
  }
  const departmentDaily = [...dailyByEmployee.entries()].map(([employeeId, items]) => ({
    employeeId,
    employeeName: items[0].employee_name,
    employeeDepartment: items[0].employee_dept,
    totalHours: sumHours(items),
    items: items.map(publicItem),
  }));

  const needsAttention: Array<Record<string, unknown>> = missingPeople.map((person) => ({ type: "missing", ...person }));
  for (const row of visibleRows) {
    if (row.blocker_text || row.work_status === "blocked") needsAttention.push({ type: "blocked", ...publicItem(row) });
    if (row.support_needed) needsAttention.push({ type: "support", ...publicItem(row) });
  }
  const totalsByUser = new Map<number, { row: ManagerItemRow; hours: number }>();
  for (const row of visibleRows) {
    const total = totalsByUser.get(row.user_id) ?? { row, hours: 0 };
    total.hours += Number(row.hours) || 0;
    totalsByUser.set(row.user_id, total);
  }
  for (const total of totalsByUser.values()) {
    if (total.hours > 16) needsAttention.push({
      type: "abnormal_hours",
      employeeId: total.row.user_id,
      employeeName: total.row.employee_name,
      employeeDepartment: total.row.employee_dept,
      hours: Math.round(total.hours * 100) / 100,
    });
  }
  const noProgress = visibleRows.filter((row) => row.work_status === "no_progress");
  for (const row of noProgress) {
    const history = db
      .prepare(
        `SELECT COUNT(*) AS value FROM log_items i JOIN logs l ON l.id = i.log_id
          WHERE l.user_id = ? AND l.status = 'submitted' AND l.date BETWEEN ? AND ?
            AND i.work_status = 'no_progress'
            AND COALESCE(i.project_id, 0) = COALESCE(?, 0)`,
      )
      .get(row.user_id, addDaysYmd(workDate, -14), workDate, row.project_id) as { value: number };
    if (Number(history.value) >= 2) needsAttention.push({ type: "long_no_progress", ...publicItem(row) });
  }

  const departmentHours = new Map<string, number>();
  const departmentStatsRows = expectedScope === null ? visibleRows : visibleRows.filter((row) => expectedScope.includes(row.user_id));
  for (const row of departmentStatsRows) {
    const department = row.employee_dept || "未同步部门";
    departmentHours.set(department, (departmentHours.get(department) ?? 0) + (Number(row.hours) || 0));
  }
  return {
    workDate,
    submission: {
      expected: expected.length,
      submitted: submittedIds.size,
      rate: expected.length ? Math.round((submittedIds.size / expected.length) * 100) : 0,
      missingPeople,
    },
    totals: {
      projects: projects.length,
      resultItems: new Set(visibleRows.map((row) => row.item_id)).size,
      blockedItems: new Set(visibleRows.filter((row) => row.blocker_text || row.work_status === "blocked").map((row) => row.item_id)).size,
    },
    needsAttention,
    projects,
    departmentDaily,
    hoursByDepartment: [...departmentHours.entries()].map(([department, hours]) => ({
      department,
      hours: Math.round(hours * 100) / 100,
    })),
  };
}
