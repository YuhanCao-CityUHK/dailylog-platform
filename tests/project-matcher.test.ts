import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "../src/auth/types";
import { matchProject } from "../src/assistant/project-matcher";
import type { WorkItemCluster } from "../src/assistant/work-item-clusterer";
import { createFormalProject, setFormalProjectStatus } from "../src/projects/service";
import { addUser, createMigratedFixtureDb } from "./helpers";

function cluster(title: string, signals: string[] = [], participantNames: string[] = []): WorkItemCluster {
  return {
    clusterId: "cluster-1",
    title,
    resultHint: "完成接口联调",
    references: [],
    sourceTypes: ["document", "chat_group"],
    participantNames,
    projectSignals: signals,
    needsConfirmation: ["hours"],
    rank: 10,
  };
}

test("项目名强信号自动匹配，弱候选待确认，无候选才归部门日常", () => {
  const db = createMigratedFixtureDb();
  const userId = addUser(db, { name: "项目负责人", role: "lead", dept: "研发部" });
  const user: SessionUser = {
    id: userId,
    kind: "dingtalk",
    ddUserid: "owner",
    name: "项目负责人",
    title: "",
    dept: "研发部",
    role: "lead",
    isExternal: false,
    mustChangePw: false,
  };
  const project = createFormalProject(user, { name: "工作日志平台" }, db);
  const high = matchProject(user, cluster("完成工作日志平台上下文接口"), "2026-08-25", db);
  assert.equal(high.scopeType, "project");
  assert.equal(high.selectedProjectId, project.id);
  assert.ok((high.candidates[0]?.score ?? 0) >= 0.8);

  const low = matchProject(user, cluster("整理部门培训资料", ["培训"]), "2026-08-25", db);
  assert.equal(low.scopeType, "department_daily");

  const weak = matchProject(user, cluster("整理跨部门协作资料", [], ["项目负责人"]), "2026-08-25", db);
  assert.equal(weak.scopeType, "unconfirmed");
  assert.equal(weak.candidates[0]?.projectId, project.id);
  assert.ok((weak.candidates[0]?.score ?? 0) < 0.55);

  setFormalProjectStatus(user, project.id, "completed", db);
  const unrelatedCompleted = matchProject(user, cluster("处理临时行政支持"), "2026-08-25", db);
  assert.equal(unrelatedCompleted.candidates.some((candidate) => candidate.projectId === project.id), false);
  const explicitCompleted = matchProject(user, cluster("完成工作日志平台收尾验证"), "2026-08-25", db);
  assert.equal(explicitCompleted.selectedProjectId, project.id, "明确收尾上下文仍可关联已完成项目");
  db.close();
});
