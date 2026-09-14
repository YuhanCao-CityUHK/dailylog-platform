import assert from "node:assert/strict";
import test from "node:test";
import { createFormalProject } from "../src/projects/service";
import { beijingDate, progressText, VivoError, workDate } from "../src/vivoflow/types";
import { fixture, ORIGIN, progress, task } from "./vivoflow-fixture";
import { VivoStore } from "../src/vivoflow/store";
import { INITIAL_VIVOFLOW_ORIGIN } from "../src/vivoflow/initial-links";
import { VivoService } from "../src/vivoflow/service";

test("统一数据源自动读取，仍校验查看者项目权限，缓存不向无权限用户泄露", async () => {
  const f = fixture();
  const service = new VivoService(f.client, f.admin.id);
  try {
    const viewer = { ...f.other, role: "exec" as const };
    assert.equal(f.client.connection(viewer.id), null);
    await assert.rejects(service.view(f.other, f.project.id, "2026-09-08"), VivoError);
    assert.equal(f.remote.calls.length, 0);
    const first = await service.view(viewer, f.project.id, "2026-09-08");
    assert.equal(first.shared, true);
    assert.equal(first.syncing, true);
    await service.waitForIdle();
    const result = await service.view(viewer, f.project.id, "2026-09-08");
    assert.equal(result.snapshot?.tasks.length, 2);
    assert.equal(f.client.connection(viewer.id), null);
    await assert.rejects(service.view(f.other, f.project.id, "2026-09-08"), VivoError);
    await assert.rejects(service.view({ ...viewer, isExternal: true }, f.project.id, "2026-09-08"), VivoError);
    f.db.prepare("UPDATE users SET active=0 WHERE id=?").run(f.admin.id);
    await assert.rejects(service.view(viewer, f.project.id, "2026-09-08"), VivoError);
  } finally { await service.waitForIdle(); f.db.close(); }
});

test("初始业务关联优先于名称包含关系，产品线可归集细项目，人工调整仍优先", () => {
  const f = fixture();
  try {
    const water = createFormalProject(f.admin, { name: "水锤项目" }, f.db);
    const oct = createFormalProject(f.admin, { name: "OCT" }, f.db);
    const store = new VivoStore(f.db, INITIAL_VIVOFLOW_ORIGIN, "initial-links-test-key");
    const catalog = [{ id: "81", name: "水锤OCT", status: "IN_PROGRESS", productLine: "水锤OCT" }, { id: "888", name: "新增导管注册", status: "IN_PROGRESS", productLine: "OCT" }];
    assert.equal(store.autoLink(f.admin, catalog), 2);
    assert.deepEqual(store.links(water.id).map((l) => l.sourceId), ["81"]);
    assert.deepEqual(store.links(oct.id).map((l) => l.sourceId), ["888"]);
    store.replaceLinks(f.admin, water.id, [], catalog);
    store.replaceLinks(f.admin, oct.id, ["81", "888"], catalog);
    assert.equal(store.autoLink(f.admin, catalog), 0);
    assert.equal(store.links(water.id).length, 0);
    assert.equal(store.links(oct.id).length, 2);
    assert.equal(store.assignments(f.admin, catalog).find((l) => l.sourceId === "81")?.projectName, "OCT");
  } finally { f.db.close(); }
});

test("按名称自动关联、支持一对多，人工解除后不会重新关联；不改项目和财务记录", () => {
  const f = fixture();
  try {
    const before = f.db.prepare("SELECT * FROM projects").all();
    const finance = f.db.prepare("SELECT * FROM finance_project_codes").all();
    assert.equal(f.store.autoLink(f.admin, f.remote.projects), 1);
    assert.equal(f.store.links(f.project.id)[0].sourceId, "101");
    const second = { id: "102", name: "光学二代", status: "PAUSED" };
    f.store.replaceLinks(f.admin, f.project.id, ["101", "102"], [...f.remote.projects, second]);
    assert.equal(f.store.links(f.project.id).length, 2);
    f.store.replaceLinks(f.admin, f.project.id, [], [...f.remote.projects, second]);
    assert.equal(f.store.autoLink(f.admin, f.remote.projects), 0);
    assert.equal(f.store.links(f.project.id).length, 0);
    assert.deepEqual(f.db.prepare("SELECT * FROM projects").all(), before);
    assert.deepEqual(f.db.prepare("SELECT * FROM finance_project_codes").all(), finance);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM logs").get()!.n, 0);
    assert.ok(Number(f.db.prepare("SELECT COUNT(*) AS n FROM vivoflow_link_audit").get()!.n) >= 4);
  } finally { f.db.close(); }
});

test("同名歧义不自动猜测，既有关联冲突拒绝，越权和不可见项目不能新增关联", () => {
  const f = fixture();
  try {
    const p2 = createFormalProject(f.admin, { name: "光学项目" }, f.db);
    assert.equal(f.store.autoLink(f.admin, f.remote.projects), 0);
    f.store.replaceLinks(f.admin, f.project.id, ["101"], f.remote.projects);
    assert.throws(() => f.store.replaceLinks(f.admin, p2.id, ["101"], f.remote.projects), (e: unknown) => e instanceof VivoError && e.code === "link_conflict");
    assert.throws(() => f.store.replaceLinks(f.other, f.project.id, [], f.remote.projects), (e: unknown) => e instanceof VivoError && e.status === 403);
    assert.throws(() => f.store.replaceLinks(f.admin, f.project.id, ["999"], f.remote.projects), (e: unknown) => e instanceof VivoError && e.code === "source_forbidden");
    f.store.replaceLinks(f.admin, f.project.id, ["101"], []);
    assert.equal(f.store.links(f.project.id).length, 1, "保留失去远端可见性的既有关联");
  } finally { f.db.close(); }
});

test("任务与进展完整分页，按北京时间自然日过滤，统计不混入日报工时", async () => {
  const f = fixture();
  try {
    f.remote.tasks.set("101", [task("1001"), task("1002", { status: "DONE" }), task("1003", { status: "CANCELLED" }), task("1004", { endDate: null })]);
    f.remote.logs.set("1001", [
      progress("2001", "2026-09-07T15:59:59Z", "前一天"),
      progress("2002", "2026-09-07T16:00:00Z", "当天起点"),
      progress("2003", "2026-09-08T15:59:59Z", "当天终点之前"),
      progress("2004", "2026-09-08T16:00:00Z", "次日"),
    ]);
    const first = await f.service.view(f.admin, f.project.id, "2026-09-08");
    assert.equal(first.syncing, true);
    await f.service.waitForIdle();
    const result = await f.service.view(f.admin, f.project.id, "2026-09-08");
    assert.equal(result.snapshot!.tasks.length, 4);
    assert.deepEqual(result.snapshot!.tasks[0].progress.map((p) => p.text), ["当天终点之前", "当天起点"]);
    assert.equal(result.snapshot!.tasks.find((t) => t.status === "DONE")!.overdue, false);
    assert.equal(result.snapshot!.tasks.find((t) => t.status === "CANCELLED")!.overdue, false);
    assert.equal(result.snapshot!.tasks.find((t) => !t.endDate)!.overdue, false);
    assert.equal(result.snapshot!.tasks[0].url, `${ORIGIN}/tasks/1001`);
    assert.equal(result.snapshot!.complete, true);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM log_items").get()!.n, 0);
    assert.ok(f.remote.calls.filter((c) => c.name === "get_task_progress" && c.args?.taskId === "1001").length >= 2);
  } finally { await f.service.waitForIdle(); f.db.close(); }
});

test("本地权限和远端可见范围都校验，缓存不能跨账号或在撤权后泄露", async () => {
  const f = fixture();
  try {
    await f.service.view(f.admin, f.project.id, "2026-09-08"); await f.service.waitForIdle();
    const calls = f.remote.calls.length;
    await assert.rejects(f.service.view(f.other, f.project.id, "2026-09-08"), (e: unknown) => e instanceof VivoError && e.status === 403);
    assert.equal(f.remote.calls.length, calls);
    assert.equal(f.store.get(f.other.id, "connection"), null);
    f.remote.projects = [];
    const revoked = await f.service.view(f.admin, f.project.id, "2026-09-08");
    assert.equal(revoked.snapshot, null);
    assert.equal(revoked.unavailableCount, 1);
    assert.deepEqual(revoked.links, []);
  } finally { await f.service.waitForIdle(); f.db.close(); }
});

test("进展读取失败明确显示部分数据；循环分页报错而不是假装抓全", async () => {
  const f = fixture();
  try {
    f.remote.deniedTasks.add("1001");
    await f.service.view(f.admin, f.project.id, "2026-09-08"); await f.service.waitForIdle();
    const result = await f.service.view(f.admin, f.project.id, "2026-09-08");
    assert.equal(result.snapshot!.complete, false);
    assert.equal(result.snapshot!.tasks[0].progressComplete, false);
    assert.match(result.snapshot!.warnings[0], /未读取完整/);
    f.remote.duplicateCursor = true;
    await assert.rejects(f.client.projects(f.admin.id), (e: unknown) => e instanceof VivoError && e.code === "pagination_loop");
  } finally { await f.service.waitForIdle(); f.db.close(); }
});

test("断开连接不会被进行中的读取重新建回，日期校验和富文本提取有边界", async () => {
  const f = fixture();
  try {
    await f.service.view(f.admin, f.project.id, "2026-09-08");
    f.store.remove(f.admin.id); await f.service.waitForIdle();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM vivoflow_private").get()!.n, 0);
    assert.equal((await f.service.view(f.admin, f.project.id, "2026-09-08")).connected, false);
    for (const value of ["2026-02-30", "2026-13-01", "invalid"]) assert.throws(() => workDate(value), VivoError);
    assert.equal(beijingDate(new Date("2026-09-07T16:00:00Z")), "2026-09-08");
    assert.equal(progressText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<script>不执行</script>" }] }] }), "<script>不执行</script>");
  } finally { await f.service.waitForIdle(); f.db.close(); }
});
