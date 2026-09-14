import type { DatabaseSync } from "node:sqlite";

export interface FinanceProjectCodeRow {
  id: number;
  projectId: number;
  code: string;
  name: string;
  active: number;
}

/**
 * 财务核算使用的项目编码清单。项目日报选择的是左侧的业务大项目，
 * 这里保存其对应的完整财务项目编码名称，避免把简称写入人工成本账。
 * 生产库中已有的 project_aliases 也会在启动时同步进来，便于财务后续补充编码。
 */
export const FINANCE_PROJECT_CODE_SEEDS: Record<string, string[]> = {
  OCT: [
    "1411-IVOCT导管-一次性使用血管内成像导管-1411-Pathfinder164-运维",
    "1904-IVOCT主机-心血管光学相干影像系统-1904-P80-运维",
    "1905-IVOCT导管-一次性使用血管内成像导管-F2，F1、M1、M2，A2，C2，X2，E2",
    "2004-IVOCT主机-心血管光学相干影像系统-2004-P80-E",
    "2005-IVOCT主机-血管内光学相干影像系统-2005-ZERO",
    "2101-IVOCT主机-OCT科研工作站-2101-Desktop-运维",
    "2102-IVOCT主机-OCT科研工作站-2102-Laptop-运维",
    "2301-IVOCT主机-2301-Cornaris Mobile +",
    "2302-IVOCT主机-2302-Cornaris Intergrated",
    "2303-IVOCT主机-2303-Cornaris P80 Classic A",
    "2304-IVOCT主机-2304-Cornaris P80 Classic B",
    "2305-IVOCT主机-2305-Cornaris P80 Elite",
    "2306-IVOCT主机-2306-Cornaris P80 Plus",
    "2307-IVOCT主机-2307-基于OCT的血管内血流储备分数计算软件（OCT-FFR）",
    "2314-IVOCT主机-2314-心血管光学相干影像系统-P80-E（俄罗斯）",
    "2318-心血管光学相干影像系统-P80、P80-E（欧盟注册）",
    "2401-血管内光学相干影像系统-ZERO（ODM）",
    "2412-血管内光学相干影像系统-ZERO Mobile+",
    "2506-心血管光学相干影像系统-P80-E（NMPA）",
    "2601-冠脉造影影像处理软件-αFFR",
    "KY07财政-重202406018 颅内光学相干断层（OCT）影像系统关键技术研发（财政）",
    "KY08-重202406018颅内OCT影像系统关键技术研发",
    "Y026-预研-Y026-OCT主机系统优化",
    "Y033-冠脉OCT上市后临床课题项目",
    "Y036-AI OCT",
    "Y044-照片打印机 Photo Printer(PT11)",
    "Y049-OCT-IVUS-NIRS-octFFR四合一",
  ],
  CLA: [
    "2105-CLA-2105-冷激光斑块消融系统（CLA-355）",
    "2107-CLA-2107-激光消融导管（CLA导管）",
    "2315-CLA-2315-冷激光斑块消融系统（CLA-355C）",
    "2601融光-冷激光斑块消融系统-CLA-355（CE）",
    "2602融光-一次性冷激光斑块消融导管-LS300-12、LS300-20、LS300-25（CE）",
    "CLA",
    "Y004-预研-Y004-CLA光纤内核",
  ],
  "静脉腔闭合系统": [
    "2517-静脉腔内闭合系统（RFL-I）中国",
    "2519-静脉腔内闭合系统（RFL-I）美洲",
    "2511-一次性使用静脉腔内射频闭合导管（RF-3-60、RF-7-60）中国",
    "静脉腔闭合系统",
  ],
  AFD: ["Y029-阿凡达AFD技术", "AFD"],
  冲击波: ["Y050-355激光冲击波"],
  斑块减容: ["Y047-CLA旋转减容（大血管斑块减容方案）"],
};

export function ensureFinanceProjectCodeTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finance_project_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (project_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_finance_project_codes_project
      ON finance_project_codes(project_id, active, id);
  `);
}

/** 幂等同步内置清单和项目别名；项目目录重建后再次调用不会重复插入。 */
export function seedFinanceProjectCodes(db: DatabaseSync): void {
  ensureFinanceProjectCodeTable(db);
  const projects = db.prepare("SELECT id, name FROM projects").all() as unknown as Array<{ id: number; name: string }>;
  const byName = new Map(projects.map((project) => [project.name, project.id]));
  const insert = db.prepare(
    `INSERT INTO finance_project_codes (project_id, code, name)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id, code) DO UPDATE SET name = excluded.name, active = 1, updated_at = datetime('now')`,
  );
  for (const [projectName, codes] of Object.entries(FINANCE_PROJECT_CODE_SEEDS)) {
    const projectId = byName.get(projectName);
    if (!projectId) continue;
    for (const code of codes) insert.run(projectId, code, code);
  }

  // project_aliases 是财务/钉钉目录的增量来源，纳入对应大项目的可选编码。
  const hasAliases = Boolean(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'project_aliases'").get(),
  );
  if (!hasAliases) return;
  const aliases = db
    .prepare(
      `SELECT pa.project_id AS projectId, pa.alias
         FROM project_aliases pa
         JOIN projects p ON p.id = pa.project_id
        WHERE p.name IN (${Object.keys(FINANCE_PROJECT_CODE_SEEDS).map(() => "?").join(",")})`,
    )
    .all(...Object.keys(FINANCE_PROJECT_CODE_SEEDS)) as unknown as Array<{ projectId: number; alias: string }>;
  for (const alias of aliases) {
    const value = String(alias.alias ?? "").trim();
    if (value) insert.run(alias.projectId, value, value);
  }
}

export function listFinanceProjectCodes(projectId: number, db: DatabaseSync): FinanceProjectCodeRow[] {
  ensureFinanceProjectCodeTable(db);
  return db
    .prepare(
      `SELECT id, project_id AS projectId, code, name, active
         FROM finance_project_codes
        WHERE project_id = ? AND active = 1
        ORDER BY id`,
    )
    .all(projectId) as unknown as FinanceProjectCodeRow[];
}

/** 替换项目的可用财务编码；旧编码仅停用，避免影响已经提交的日报历史。 */
export function replaceFinanceProjectCodes(projectId: number, codes: string[], db: DatabaseSync): FinanceProjectCodeRow[] {
  ensureFinanceProjectCodeTable(db);
  const normalized = [...new Set(codes.map((code) => code.normalize("NFKC").trim()).filter(Boolean))];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE finance_project_codes SET active = 0, updated_at = datetime('now') WHERE project_id = ?").run(projectId);
    const upsert = db.prepare(
      `INSERT INTO finance_project_codes (project_id, code, name, active, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'))
       ON CONFLICT(project_id, code) DO UPDATE SET name = excluded.name, active = 1, updated_at = datetime('now')`,
    );
    for (const code of normalized) upsert.run(projectId, code, code);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listFinanceProjectCodes(projectId, db);
}

export function getFinanceProjectCode(
  projectId: number,
  codeId: number,
  db: DatabaseSync,
): FinanceProjectCodeRow | null {
  ensureFinanceProjectCodeTable(db);
  return (db
    .prepare(
      `SELECT id, project_id AS projectId, code, name, active
         FROM finance_project_codes
        WHERE id = ? AND project_id = ? AND active = 1`,
    )
    .get(codeId, projectId) as FinanceProjectCodeRow | undefined) ?? null;
}
