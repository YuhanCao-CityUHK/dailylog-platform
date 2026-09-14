/**
 * 钉钉知识库表格（WORKBOOK）创建与写入。
 * 需应用开通「知识库写」「钉钉表格写」权限，并配置 workspaceId + operatorUnionId。
 */
import { createDingTalkReportClient } from "./dingtalk-report-client";

export interface DailyReportDocConfig {
  workspaceId: string;
  operatorUnionId: string;
  parentNodeId?: string;
  /** 月归档文件夹的父节点；缺省为知识库根 */
  archiveBaseNodeId?: string;
  /** 是否按 YYYY-MM 自动归档；默认 true（手动 parentNodeId 优先） */
  monthArchive?: boolean;
}

export interface CreatedWorkbook {
  workbookId: string;
  url: string;
  name: string;
}

export interface CreatedSheet {
  id: string;
  name: string;
}

export interface CreatedFolder {
  nodeId: string;
  url?: string;
  name: string;
}

export interface DingTalkSheetProperties {
  id: string;
  name: string;
  lastNonEmptyRow: number;
  lastNonEmptyColumn: number;
}

function asString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function colLetter(colIndex: number): string {
  let n = colIndex;
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + "A".charCodeAt(0)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

const DINGTALK_MAX_RANGE_CELLS = 30_000;

function colIndexFromLetter(column: string): number {
  let value = 0;
  for (const char of column.toUpperCase()) {
    value = value * 26 + char.charCodeAt(0) - 64;
  }
  return value - 1;
}

function splitRangeForRead(range: string): string[] {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range);
  if (!match) return [range];
  const startColumn = match[1]!.toUpperCase();
  const startRow = Number(match[2]);
  const endColumn = match[3]!.toUpperCase();
  const endRow = Number(match[4]);
  const columnCount = colIndexFromLetter(endColumn) - colIndexFromLetter(startColumn) + 1;
  if (
    !Number.isInteger(startRow)
    || !Number.isInteger(endRow)
    || startRow < 1
    || endRow < startRow
    || columnCount < 1
  ) {
    return [range];
  }
  const maxRowsPerRequest = Math.floor(DINGTALK_MAX_RANGE_CELLS / columnCount);
  if (maxRowsPerRequest < 1 || (endRow - startRow + 1) <= maxRowsPerRequest) {
    return [range];
  }
  const chunks: string[] = [];
  for (let row = startRow; row <= endRow; row += maxRowsPerRequest) {
    const chunkEndRow = Math.min(endRow, row + maxRowsPerRequest - 1);
    chunks.push(`${startColumn}${row}:${endColumn}${chunkEndRow}`);
  }
  return chunks;
}

function estimateRowHeight(cellValue: string): number {
  const lines = Math.max(1, cellValue.split("\n").length);
  return Math.min(180, Math.max(28, 28 + (lines - 1) * 18));
}

export function createDingTalkWorkbookClient(opts?: { fetchImpl?: typeof fetch }) {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const tokenProvider = createDingTalkReportClient({ fetchImpl });

  async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
    return tokenProvider.getAccessToken(appKey, appSecret);
  }

  async function apiCall<T>(
    appKey: string,
    appSecret: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await getAccessToken(appKey, appSecret);
    const res = await fetchImpl(`https://api.dingtalk.com${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & {
      code?: string;
      message?: string;
    };
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
    }
    return data;
  }

  async function createWorkbook(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    name: string,
    parentNodeId?: string,
  ): Promise<CreatedWorkbook> {
    const body: Record<string, unknown> = {
      name,
      docType: "WORKBOOK",
      operatorId: doc.operatorUnionId,
    };
    const parent = parentNodeId ?? doc.parentNodeId;
    if (parent) body.parentNodeId = parent;

    const data = await apiCall<Record<string, unknown>>(
      appKey,
      appSecret,
      "POST",
      `/v1.0/doc/workspaces/${encodeURIComponent(doc.workspaceId)}/docs`,
      body,
    );
    const workbookId = asString(data.dentryUuid ?? data.nodeId ?? data.uuid ?? data.docKey);
    const url = asString(data.url ?? data.docUrl);
    if (!workbookId || !url) {
      throw new Error(`createWorkbook missing nodeId/url: ${JSON.stringify(data)}`);
    }
    return { workbookId, url, name };
  }

  async function createFolder(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    name: string,
    parentNodeId: string,
  ): Promise<CreatedFolder> {
    const data = await apiCall<Record<string, unknown>>(
      appKey,
      appSecret,
      "POST",
      `/v1.0/doc/workspaces/${encodeURIComponent(doc.workspaceId)}/docs`,
      {
        name,
        docType: "FOLDER",
        operatorId: doc.operatorUnionId,
        parentNodeId,
      },
    );
    const nodeId = asString(data.dentryUuid ?? data.nodeId ?? data.uuid);
    if (!nodeId) {
      throw new Error(`createFolder missing nodeId: ${JSON.stringify(data)}`);
    }
    return { nodeId, url: asString(data.url) || undefined, name };
  }

  async function createSheet(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    workbookId: string,
    name: string,
  ): Promise<CreatedSheet> {
    const data = await apiCall<Record<string, unknown>>(
      appKey,
      appSecret,
      "POST",
      `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
      { name },
    );
    const id = asString(data.id ?? data.name);
    const sheetName = asString(data.name ?? name);
    if (!id) {
      throw new Error(`createSheet missing id: ${JSON.stringify(data)}`);
    }
    return { id, name: sheetName };
  }

  async function listSheets(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    workbookId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const data = await apiCall<{ value?: Array<{ id?: string; name?: string }> }>(
      appKey,
      appSecret,
      "GET",
      `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
    );
    return (data.value ?? []).map((s) => ({
      id: asString(s.id ?? s.name),
      name: asString(s.name),
    }));
  }

  async function getSheetProperties(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    workbookId: string,
    sheetId: string,
  ): Promise<DingTalkSheetProperties> {
    const data = await apiCall<Record<string, unknown>>(
      appKey,
      appSecret,
      "GET",
      `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
    );
    const id = asString(data.id ?? sheetId);
    const name = asString(data.name);
    const lastNonEmptyRow = Number(data.lastNonEmptyRow);
    const lastNonEmptyColumn = Number(data.lastNonEmptyColumn);
    if (
      !id
      || !name
      || !Number.isInteger(lastNonEmptyRow)
      || lastNonEmptyRow < 0
      || !Number.isInteger(lastNonEmptyColumn)
      || lastNonEmptyColumn < 0
    ) {
      throw new Error(`getSheetProperties missing non-empty bounds: ${JSON.stringify(data)}`);
    }
    return { id, name, lastNonEmptyRow, lastNonEmptyColumn };
  }

  async function readSheetValues(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    workbookId: string,
    sheetId: string,
    rangeAddress: string,
  ): Promise<unknown[][]> {
    const range = rangeAddress.trim();
    if (!range) throw new Error("rangeAddress is required");
    const rows: unknown[][] = [];
    for (const chunk of splitRangeForRead(range)) {
      const data = await apiCall<{ values?: unknown[][] }>(
        appKey,
        appSecret,
        "GET",
        `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}/ranges/${encodeURIComponent(chunk)}?select=values&operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
      );
      if (!Array.isArray(data.values)) {
        throw new Error(`readSheetValues missing values: ${JSON.stringify(data)}`);
      }
      rows.push(...data.values);
    }
    return rows;
  }

  async function deleteSheet(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    workbookId: string,
    sheetId: string,
  ): Promise<void> {
    await apiCall(
      appKey,
      appSecret,
      "DELETE",
      `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
    );
  }

  async function writeSheetRangeValues(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    workbookId: string,
    sheetId: string,
    rangeAddress: string,
    values: string[][],
  ): Promise<void> {
    const range = rangeAddress.trim();
    if (!range) throw new Error("rangeAddress is required");
    if (values.length === 0 || values.some((row) => !Array.isArray(row))) {
      throw new Error("values must contain at least one row");
    }
    await apiCall(
      appKey,
      appSecret,
      "PUT",
      `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}/ranges/${encodeURIComponent(range)}?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
      { values },
    );
  }

  async function writeSheetValues(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    workbookId: string,
    rows: string[][],
    sheetId = "Sheet1",
  ): Promise<void> {
    if (rows.length === 0) return;
    const colCount = Math.max(...rows.map((r) => r.length));
    const rowCount = rows.length;
    const endCol = colLetter(colCount - 1);
    const rangeAddress = `A1:${endCol}${rowCount}`;

    const verticalAlignments: string[][] = [];
    const fontWeights: string[][] = [];
    const backgroundColors: string[][] = [];
    for (let r = 0; r < rowCount; r += 1) {
      verticalAlignments.push(Array(colCount).fill("top"));
      if (r === 0) {
        fontWeights.push(Array(colCount).fill("bold"));
        backgroundColors.push(Array(colCount).fill("#f5f5f5"));
      } else {
        fontWeights.push(Array(colCount).fill("normal"));
        backgroundColors.push(Array(colCount).fill("#ffffff"));
      }
    }

    // wordWrap 必须与 values 同一次 PUT，单独写格式不会生效
    await apiCall(
      appKey,
      appSecret,
      "PUT",
      `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}/ranges/${rangeAddress}?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
      {
        values: rows,
        wordWrap: "autoWrap",
        numberFormat: "@",
        verticalAlignments,
        fontWeights,
        backgroundColors,
      },
    );
  }

  async function formatSheetLayout(
    appKey: string,
    appSecret: string,
    doc: DailyReportDocConfig,
    workbookId: string,
    sheetId: string,
    rows: string[][],
  ): Promise<void> {
    if (rows.length === 0) return;
    const rowCount = rows.length;
    const colCount = Math.max(...rows.map((r) => r.length));

    try {
      await apiCall(
        appKey,
        appSecret,
        "POST",
        `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}/setColumnsWidth?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
        { column: 0, columnCount: 1, width: 120 },
      );
      if (colCount > 1) {
        await apiCall(
          appKey,
          appSecret,
          "POST",
          `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}/setColumnsWidth?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
          { column: 1, columnCount: colCount - 1, width: 480 },
        );
      }
    } catch {
      /* column width optional */
    }

    for (let r = 1; r < rowCount; r += 1) {
      const cellB = rows[r]?.[1] ?? rows[r]?.[0] ?? "";
      const height = estimateRowHeight(cellB);
      try {
        await apiCall(
          appKey,
          appSecret,
          "POST",
          `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets/${encodeURIComponent(sheetId)}/setRowsHeight?operatorId=${encodeURIComponent(doc.operatorUnionId)}`,
          { row: r, rowCount: 1, height },
        );
      } catch {
        break;
      }
    }
  }

  return {
    getAccessToken,
    createWorkbook,
    createFolder,
    createSheet,
    listSheets,
    getSheetProperties,
    readSheetValues,
    deleteSheet,
    writeSheetRangeValues,
    writeSheetValues,
    formatSheetLayout,
  };
}

export type DingTalkWorkbookClient = ReturnType<typeof createDingTalkWorkbookClient>;
