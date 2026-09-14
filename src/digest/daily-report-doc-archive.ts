import * as fs from "fs";
import * as path from "path";
import { logStructured } from "../infra/logger";
import type { DailyReportDocConfig } from "./daily-report-config";
import { createDingTalkWorkbookClient } from "./dingtalk-workbook-client";

export interface MonthFolderCache {
  folderName: string;
  parentNodeId: string;
  cachedAt: string;
}

function asString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function cachePath(stateDir: string, folderName: string): string {
  return path.join(stateDir, "doc-folders", `${folderName}.json`);
}

function readCache(stateDir: string, folderName: string): MonthFolderCache | undefined {
  try {
    const raw = fs.readFileSync(cachePath(stateDir, folderName), "utf8");
    const parsed = JSON.parse(raw) as MonthFolderCache;
    if (parsed.folderName === folderName && parsed.parentNodeId) return parsed;
  } catch {
    /* miss */
  }
  return undefined;
}

function writeCache(stateDir: string, entry: MonthFolderCache): void {
  const file = cachePath(stateDir, entry.folderName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entry, null, 2), "utf8");
}

interface WikiNode {
  nodeId?: string;
  name?: string;
  type?: string;
}

async function listWikiNodes(
  token: string,
  parentNodeId: string,
  operatorId: string,
  fetchImpl: typeof fetch,
): Promise<WikiNode[]> {
  const nodes: WikiNode[] = [];
  let nextToken = "";
  for (let page = 0; page < 10; page += 1) {
    const qs = new URLSearchParams({
      parentNodeId,
      operatorId,
      maxResults: "50",
    });
    if (nextToken) qs.set("nextToken", nextToken);
    const res = await fetchImpl(`https://api.dingtalk.com/v2.0/wiki/nodes?${qs}`, {
      headers: { "x-acs-dingtalk-access-token": token },
    });
    const data = (await res.json().catch(() => ({}))) as {
      nodes?: WikiNode[];
      nextToken?: string;
    };
    if (!res.ok) {
      throw new Error(`list wiki nodes failed: ${res.status} ${JSON.stringify(data)}`);
    }
    nodes.push(...(data.nodes ?? []));
    nextToken = asString(data.nextToken);
    if (!nextToken) break;
  }
  return nodes;
}

async function resolveWorkspaceRootNodeId(
  token: string,
  workspaceId: string,
  operatorId: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(
    `https://api.dingtalk.com/v2.0/wiki/workspaces/${encodeURIComponent(workspaceId)}?operatorId=${encodeURIComponent(operatorId)}`,
    { headers: { "x-acs-dingtalk-access-token": token } },
  );
  const data = (await res.json().catch(() => ({}))) as {
    workspace?: { rootNodeId?: string };
    rootNodeId?: string;
  };
  if (!res.ok) {
    throw new Error(`get workspace failed: ${res.status} ${JSON.stringify(data)}`);
  }
  const root = asString(data.workspace?.rootNodeId ?? data.rootNodeId);
  if (!root) throw new Error("workspace rootNodeId missing");
  return root;
}

/**
 * 解析当月归档文件夹 parentNodeId。手动 parentNodeId 优先；否则查/建 YYYY-MM 文件夹。
 */
export async function resolveWorkbookParentNodeId(input: {
  doc: DailyReportDocConfig;
  labelYmd: string;
  stateDir: string;
  monthArchive?: boolean;
  appKey: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  if (input.doc.parentNodeId) return input.doc.parentNodeId;
  if (input.monthArchive === false) return undefined;

  const folderName = input.labelYmd.slice(0, 7);
  const cached = readCache(input.stateDir, folderName);
  if (cached) return cached.parentNodeId;

  const fetchImpl = input.fetchImpl ?? fetch;
  const wb = createDingTalkWorkbookClient({ fetchImpl });
  const token = await wb.getAccessToken(input.appKey, input.appSecret);

  const listParentId =
    input.doc.archiveBaseNodeId ??
    (await resolveWorkspaceRootNodeId(token, input.doc.workspaceId, input.doc.operatorUnionId, fetchImpl));

  const nodes = await listWikiNodes(token, listParentId, input.doc.operatorUnionId, fetchImpl);
  const existing = nodes.find((n) => n.type === "FOLDER" && n.name === folderName);
  if (existing?.nodeId) {
    const entry: MonthFolderCache = {
      folderName,
      parentNodeId: existing.nodeId,
      cachedAt: new Date().toISOString(),
    };
    writeCache(input.stateDir, entry);
    return existing.nodeId;
  }

  const created = await wb.createFolder(
    input.appKey,
    input.appSecret,
    input.doc,
    folderName,
    listParentId,
  );
  const entry: MonthFolderCache = {
    folderName,
    parentNodeId: created.nodeId,
    cachedAt: new Date().toISOString(),
  };
  writeCache(input.stateDir, entry);
  logStructured({
    event: "daily_report_month_folder_created",
    folderName,
    parentNodeId: created.nodeId,
  });
  return created.nodeId;
}
