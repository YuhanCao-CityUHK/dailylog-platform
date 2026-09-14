/** 钉钉日报 contents.type=9 表示附件字段。 */
export const REPORT_ATTACHMENT_FIELD_TYPE = "9";

export interface ReportAttachment {
  name: string;
  url?: string;
  fileId?: string;
  spaceId?: string;
}

export interface ReportFieldLike {
  key: string;
  value: string;
  type?: string;
  attachments?: ReportAttachment[];
}

export interface ReportLike {
  contents: ReportFieldLike[];
  images?: ReportAttachment[];
}

function asString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** 解析 type=9 字段 value（JSON 数组字符串）。 */
export function parseAttachmentsFromValue(raw: string): ReportAttachment[] {
  const text = raw.trim();
  if (!text || text === "[]") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "string") {
          const name = item.trim();
          return name ? { name } : null;
        }
        const o = (item ?? {}) as Record<string, unknown>;
        const name =
          asString(o.fileName ?? o.file_name ?? o.name ?? o.title) || "附件";
        const url = asString(o.url ?? o.downloadUrl ?? o.download_url) || undefined;
        const fileId = asString(o.fileId ?? o.file_id ?? o.id) || undefined;
        const spaceId = asString(o.spaceId ?? o.space_id) || undefined;
        return { name, url, fileId, spaceId };
      })
      .filter((a): a is ReportAttachment => Boolean(a?.name));
  } catch {
    return [];
  }
}

/** 解析 report/list 顶层 images 字段。 */
export function parseReportImages(raw: unknown): ReportAttachment[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      if (typeof item === "string") {
        const url = item.trim();
        if (!url) return [];
        const name = url.split("/").pop()?.split("?")[0] || "图片";
        return [{ name, url }];
      }
      const o = (item ?? {}) as Record<string, unknown>;
      const name = asString(o.fileName ?? o.name ?? o.title) || "图片";
      const url = asString(o.url ?? o.downloadUrl) || undefined;
      return name ? [{ name, url }] : [];
    });
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.string)) return parseReportImages(o.string);
  }
  return [];
}

export function formatAttachmentSummary(attachments: ReportAttachment[]): string {
  if (attachments.length === 0) return "";
  const names = attachments.map((a) => a.name).join("、");
  return `附件 ${attachments.length} 个：${names}`;
}

/** 字段展示：正文 + 附件摘要（表格 / 工作台 / full 模式共用）。 */
export function formatFieldDisplayValue(field: ReportFieldLike): string {
  const parts: string[] = [];
  const value = field.value.trim();
  if (value) parts.push(value);
  const att = field.attachments ?? [];
  if (att.length > 0) {
    parts.push(att.length === 1 && !value ? formatAttachmentSummary(att) : `[附件] ${att.map((a) => a.name).join("、")}`);
  }
  return parts.join("\n");
}

export function fieldHasDisplayBody(field: ReportFieldLike): boolean {
  if ((field.attachments?.length ?? 0) > 0) return true;
  const value = field.value.trim();
  if (!value) return false;
  if (
    value === "[]" &&
    (field.type === REPORT_ATTACHMENT_FIELD_TYPE || field.key.includes("附件"))
  ) {
    return false;
  }
  return true;
}

export function countReportAttachments(report: ReportLike): number {
  let n = report.images?.length ?? 0;
  for (const f of report.contents) {
    n += f.attachments?.length ?? 0;
  }
  return n;
}

export function reportHasDisplayBody(report: ReportLike): boolean {
  if ((report.images?.length ?? 0) > 0) return true;
  return report.contents.some(fieldHasDisplayBody);
}

/** 正文内嵌图片占位（report/list 不返回 URL，仅有 [图片] 文本）。 */
export const INLINE_IMAGE_MARKER = "[图片]";

export function contentHasInlineImageMarker(value: string): boolean {
  return value.includes(INLINE_IMAGE_MARKER);
}

export function reportHasResolvableImages(report: ReportLike): boolean {
  if ((report.images?.length ?? 0) > 0) return true;
  return report.contents.some((f) => contentHasInlineImageMarker(f.value));
}
