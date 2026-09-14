/** 项目名称比较：统一常见全半角、大小写与多余空白。 */
export function cleanProjectName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function normalizeProjectName(value: string): string {
  return cleanProjectName(value).toLocaleLowerCase("zh-CN");
}
