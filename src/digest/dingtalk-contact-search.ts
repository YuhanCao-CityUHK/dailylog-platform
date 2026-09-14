/**
 * 钉钉通讯录枚举 / 按姓名搜索（用于「日报汇总」名单管理 UI）。
 *
 * - 每个组织用各自企业内部应用的 appKey/appSecret（需「通讯录部门/成员读」权限）。
 * - 钉钉没有「按姓名搜人」的直接接口，这里递归枚举部门（topapi/v2/department/listsub）
 *   再逐部门拉成员（topapi/v2/user/list），在内存按 appKey 缓存目录（默认 5 分钟 TTL），
 *   之后按姓名/userid 子串过滤。首次（或缓存过期后）较慢，命中缓存后即时。
 */
import { createDingTalkReportClient } from "./dingtalk-report-client";
import { withDingTalkRateLimitRetry } from "./dingtalk-rate-limit-retry";

export interface ContactCandidate {
  userid: string;
  name: string;
  departments: string[];
  departmentIds: number[];
}

interface DepartmentNode {
  id: number;
  name: string;
  parentId: number | null;
}

interface DirectorySnapshot {
  users: ContactCandidate[];
  departments: Map<number, DepartmentNode>;
}

interface CachedDirectory extends DirectorySnapshot {
  builtAt: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const ROOT_DEPT_ID = 1;
const MAX_DEPARTMENTS = 4000;
const USER_PAGE_SIZE = 100;
const MAX_USER_PAGES_PER_DEPT = 500;

interface DingTalkOapiError {
  errcode?: number;
  errmsg?: string;
}

function asString(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

export interface DingTalkContactDirectory {
  search(
    appKey: string,
    appSecret: string,
    query: string,
    limit?: number,
  ): Promise<ContactCandidate[]>;
  /** 枚举组织全部通讯录（空 query）；用于微光 org_all 日报发现。 */
  listAll(appKey: string, appSecret: string, limit?: number): Promise<ContactCandidate[]>;
  /** 枚举指定部门及全部下级部门成员。 */
  listDepartmentTree(
    appKey: string,
    appSecret: string,
    departmentName: string,
    limit?: number,
  ): Promise<ContactCandidate[]>;
  /** 强制重建某 appKey 的目录缓存（增删名单后可调用以反映最新通讯录）。 */
  invalidate(appKey: string): void;
}

export function createDingTalkContactDirectory(opts?: {
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}): DingTalkContactDirectory {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const tokenProvider = createDingTalkReportClient({ fetchImpl });
  const cache = new Map<string, CachedDirectory>();
  const inflight = new Map<string, Promise<DirectorySnapshot>>();

  async function callOapi<T>(
    token: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return withDingTalkRateLimitRetry(async () => {
      const res = await fetchImpl(
        `https://oapi.dingtalk.com/${path}?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as T & DingTalkOapiError;
      if (!res.ok || (typeof data.errcode === "number" && data.errcode !== 0)) {
        throw new Error(
          `${path} failed: ${res.status} ${JSON.stringify({
            errcode: data.errcode,
            errmsg: data.errmsg,
          })}`,
        );
      }
      return data;
    });
  }

  /** 递归枚举全部部门，并保留父子关系。 */
  async function enumerateDepartments(token: string): Promise<Map<number, DepartmentNode>> {
    const departments = new Map<number, DepartmentNode>();
    departments.set(ROOT_DEPT_ID, { id: ROOT_DEPT_ID, name: "", parentId: null });
    const queue: number[] = [ROOT_DEPT_ID];
    while (queue.length > 0 && departments.size < MAX_DEPARTMENTS) {
      const deptId = queue.shift() as number;
      const data = await callOapi<{
        result?: Array<{ dept_id?: number; name?: string }>;
      }>(token, "topapi/v2/department/listsub", { dept_id: deptId });
      for (const d of data.result ?? []) {
        const id = Number(d.dept_id);
        if (!Number.isFinite(id) || departments.has(id)) continue;
        departments.set(id, { id, name: asString(d.name), parentId: deptId });
        queue.push(id);
      }
    }
    return departments;
  }

  async function enumerateUsers(
    token: string,
    departments: Map<number, DepartmentNode>,
  ): Promise<ContactCandidate[]> {
    const byId = new Map<string, ContactCandidate>();
    for (const deptId of departments.keys()) {
      let cursor = 0;
      for (let page = 0; page < MAX_USER_PAGES_PER_DEPT; page += 1) {
        const data = await callOapi<{
          result?: {
            list?: Array<Record<string, unknown>>;
            next_cursor?: number;
            has_more?: boolean;
          };
        }>(token, "topapi/v2/user/list", {
          dept_id: deptId,
          cursor,
          size: USER_PAGE_SIZE,
        });
        const list = data.result?.list ?? [];
        for (const u of list) {
          const userid = asString(u.userid);
          if (!userid) continue;
          const name = asString(u.name);
          const deptIdList = Array.isArray(u.dept_id_list)
            ? (u.dept_id_list as unknown[]).map((x) => Number(x)).filter(Number.isFinite)
            : [];
          const resolvedDeptIds = deptIdList.length > 0 ? deptIdList : [deptId];
          const deptLabels = resolvedDeptIds
            .map((id) => departments.get(id)?.name ?? "")
            .filter((s) => s.length > 0);
          const existing = byId.get(userid);
          if (existing) {
            for (const d of deptLabels) {
              if (!existing.departments.includes(d)) existing.departments.push(d);
            }
            for (const id of resolvedDeptIds) {
              if (!existing.departmentIds.includes(id)) existing.departmentIds.push(id);
            }
          } else {
            byId.set(userid, {
              userid,
              name,
              departments: [...new Set(deptLabels)],
              departmentIds: [...new Set(resolvedDeptIds)],
            });
          }
        }
        const hasMore = Boolean(data.result?.has_more);
        const nextCursor = Number(data.result?.next_cursor ?? 0);
        if (!hasMore || list.length === 0) break;
        if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break;
        cursor = nextCursor;
      }
    }
    return [...byId.values()];
  }

  async function getDirectory(
    appKey: string,
    appSecret: string,
  ): Promise<DirectorySnapshot> {
    const cached = cache.get(appKey);
    if (cached && Date.now() - cached.builtAt < ttlMs) return cached;
    // 并发去重：预热与首次搜索可能同时触发，复用同一次枚举，避免重复拉通讯录。
    const existing = inflight.get(appKey);
    if (existing) return existing;
    const promise = (async () => {
      const token = await tokenProvider.getAccessToken(appKey, appSecret);
      const departments = await enumerateDepartments(token);
      const users = await enumerateUsers(token, departments);
      const snapshot = { users, departments };
      cache.set(appKey, { builtAt: Date.now(), ...snapshot });
      return snapshot;
    })().finally(() => inflight.delete(appKey));
    inflight.set(appKey, promise);
    return promise;
  }

  return {
    async search(appKey, appSecret, query, limit = 30) {
      if (!appKey || !appSecret) throw new Error("appKey / appSecret is required");
      const { users } = await getDirectory(appKey, appSecret);
      const q = asString(query).toLowerCase();
      const matched = q
        ? users.filter(
            (u) =>
              u.name.toLowerCase().includes(q) || u.userid.toLowerCase().includes(q),
          )
        : users;
      return matched
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
        .slice(0, Math.max(1, limit));
    },
    async listAll(appKey, appSecret, limit = 5000) {
      return this.search(appKey, appSecret, "", limit);
    },
    async listDepartmentTree(appKey, appSecret, departmentName, limit = 5000) {
      if (!appKey || !appSecret) throw new Error("appKey / appSecret is required");
      const targetName = asString(departmentName);
      if (!targetName) throw new Error("departmentName is required");
      const { users, departments } = await getDirectory(appKey, appSecret);
      const departmentIds = new Set(
        [...departments.values()].filter((d) => d.name === targetName).map((d) => d.id),
      );
      if (departmentIds.size === 0) throw new Error(`department not found: ${targetName}`);
      for (const department of departments.values()) {
        if (department.parentId != null && departmentIds.has(department.parentId)) {
          departmentIds.add(department.id);
        }
      }
      return users
        .filter((user) => user.departmentIds.some((id) => departmentIds.has(id)))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
        .slice(0, Math.max(1, limit));
    },
    invalidate(appKey) {
      cache.delete(appKey);
    },
  };
}
