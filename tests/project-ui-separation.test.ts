import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const projectRoutes = readFileSync(new URL("../src/projects/routes.ts", import.meta.url), "utf8");

test("日报归属选择器不再提供项目新建入口", () => {
  const picker = source.slice(source.indexOf("function openAffPicker"), source.indexOf("function strSimilarJs"));
  assert.doesNotMatch(picker, /\/api\/projects/);
  assert.doesNotMatch(picker, /新建项目名称|npBtn/);
  assert.match(picker, /只能选择已经建立并分配给你的项目/);
});

test("项目页提供独立的新建和设置入口", () => {
  assert.match(source, /id="projectCreate">新建项目/);
  assert.match(source, /function openProjectEditor/);
  assert.match(source, /function openProjectDirectory/);
  assert.match(source, /id="projectFinanceCodes"/);
  assert.match(projectRoutes, /\/api\/projects\/:id\/finance-codes/);
  assert.match(source, /person\.isExternal \? "外部账号"/);
});

test("项目成员候选包含启用的外部账号", () => {
  const manageMeta = projectRoutes.slice(
    projectRoutes.indexOf('router.get("/api/projects/manage-meta"'),
    projectRoutes.indexOf('router.post("/api/projects"'),
  );
  assert.match(manageMeta, /is_external AS isExternal/);
  assert.match(manageMeta, /WHERE active = 1/);
  assert.doesNotMatch(manageMeta, /active = 1 AND is_external = 0/);
});
