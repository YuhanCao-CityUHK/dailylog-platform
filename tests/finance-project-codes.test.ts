import assert from "node:assert/strict";
import test from "node:test";
import type { DraftAffiliation } from "../src/platform/store";
import { validateFinanceCodeSelections } from "../src/platform/routes-fill";
import {
  ensureFinanceProjectCodeTable,
  listFinanceProjectCodes,
  replaceFinanceProjectCodes,
} from "../src/platform/finance-project-codes";
import { createFormalProject } from "../src/projects/service";
import { addUser, createMigratedFixtureDb } from "./helpers";

function affiliation(projectId: number, financeCodeId?: number): DraftAffiliation {
  return {
    affId: String(projectId),
    financeCodeId,
    items: [{ text: "完成项目工作", hours: 2, cats: [], atts: [] }],
  };
}

test("项目未配置财务编码时不阻止日报提交，已有编码时仍要求选择", () => {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "项目负责人", role: "lead", dept: "研发部" });
  const user = {
    id: userId,
    kind: "dingtalk" as const,
    ddUserid: "finance-code-user",
    name: "项目负责人",
    title: "",
    dept: "研发部",
    role: "lead" as const,
    isExternal: false,
    mustChangePw: false,
  };
  const project = createFormalProject(user, { name: "无财务编码项目" }, db);
  ensureFinanceProjectCodeTable(db);
  const availableProjects = new Map([[project.id, { id: project.id, name: project.name }]]);

  assert.equal(validateFinanceCodeSelections([affiliation(project.id)], availableProjects, db), null);

  const codes = replaceFinanceProjectCodes(project.id, ["FIN-001", "FIN-001", "FIN-002"], db);
  assert.equal(codes.length, 2);
  assert.match(validateFinanceCodeSelections([affiliation(project.id)], availableProjects, db) ?? "", /请选择/);
  assert.equal(validateFinanceCodeSelections([affiliation(project.id, codes[0].id)], availableProjects, db), null);

  replaceFinanceProjectCodes(project.id, ["FIN-003"], db);
  assert.deepEqual(listFinanceProjectCodes(project.id, db).map((code) => code.code), ["FIN-003"]);
  assert.equal(
    (db.prepare("SELECT active FROM finance_project_codes WHERE project_id = ? AND code = 'FIN-001'").get(project.id) as { active: number }).active,
    0,
  );
  db.close();
});
