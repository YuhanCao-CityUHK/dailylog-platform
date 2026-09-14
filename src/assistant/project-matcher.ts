import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { listFormalProjects } from "../projects/service";
import type { WorkItemCluster } from "./work-item-clusterer";

export type ProjectMatchInput = Pick<
  WorkItemCluster,
  "title" | "resultHint" | "projectSignals" | "participantNames" | "sourceTypes"
>;

export const HIGH_PROJECT_CONFIDENCE = 0.8;
export const MEDIUM_PROJECT_CONFIDENCE = 0.55;

export interface ProjectMatchCandidate {
  projectId: number;
  projectName: string;
  score: number;
  reason: string;
}

export interface ProjectMatchResult {
  scopeType: "project" | "department_daily" | "unconfirmed";
  selectedProjectId?: number;
  selectedProjectName?: string;
  candidates: ProjectMatchCandidate[];
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s，。、“”‘’：:；;！？!?（）()[\]【】_\-—]/g, "");
}

function bigrams(value: string): Set<string> {
  const clean = normalize(value);
  const out = new Set<string>();
  for (let index = 0; index + 1 < clean.length; index += 1) out.add(clean.slice(index, index + 2));
  return out;
}

function similarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

function recentProjectIds(userId: number, workDate: string, db: DatabaseSync): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT i.project_id
         FROM log_items i JOIN logs l ON l.id = i.log_id
        WHERE l.user_id = ? AND l.status = 'submitted' AND l.date < ? AND i.project_id IS NOT NULL
        ORDER BY l.date DESC LIMIT 20`,
    )
    .all(userId, workDate) as unknown as Array<{ project_id: number }>;
  return new Set(rows.map((row) => row.project_id));
}

export function matchProject(
  user: SessionUser,
  cluster: ProjectMatchInput,
  workDate: string,
  db: DatabaseSync,
): ProjectMatchResult {
  const projects = listFormalProjects(user, db, true);
  const recent = recentProjectIds(user.id, workDate, db);
  const text = [cluster.title, cluster.resultHint, ...cluster.projectSignals].join(" ");
  const normalizedText = normalize(text);
  const matches = projects.flatMap((project): ProjectMatchCandidate[] => {
    const normalizedName = normalize(project.name);
    const exact = normalizedName.length >= 2 && normalizedText.includes(normalizedName);
    const wasRecent = recent.has(project.id);
    if (project.status === "completed" && !exact && !wasRecent) return [];
    const semantic = similarity(project.name, text);
    const participantOverlap = project.members.some((member) =>
      cluster.participantNames.some((name) => normalize(name) === normalize(member.name)),
    );
    const ownProject = project.owner.id === user.id || project.members.some((member) => member.id === user.id);
    let score = 0;
    const reasons: string[] = [];
    if (exact) {
      score += 0.7;
      reasons.push("事项中出现项目名称");
    } else if (semantic >= 0.3) {
      score += semantic * 0.5;
      reasons.push("事项与项目名称相似");
    }
    if (participantOverlap) {
      score += 0.15;
      reasons.push("参与人与项目成员重合");
    }
    if (wasRecent) {
      score += 0.15;
      reasons.push("近期日报确认过该项目");
    }
    if (ownProject && score > 0) score += 0.08;
    if (cluster.sourceTypes.length >= 2 && score > 0) score += 0.05;
    score = Math.min(1, Math.round(score * 100) / 100);
    return score > 0
      ? [{ projectId: project.id, projectName: project.name, score, reason: reasons.join("；") || "项目成员关系" }]
      : [];
  });
  matches.sort((a, b) => b.score - a.score || a.projectId - b.projectId);
  const candidates = matches.slice(0, 3);
  const best = candidates[0];
  if (best && best.score >= HIGH_PROJECT_CONFIDENCE) {
    return {
      scopeType: "project",
      selectedProjectId: best.projectId,
      selectedProjectName: best.projectName,
      candidates,
    };
  }
  if (best && best.score >= MEDIUM_PROJECT_CONFIDENCE) {
    return { scopeType: "unconfirmed", candidates };
  }
  if (best) return { scopeType: "unconfirmed", candidates };
  return { scopeType: "department_daily", candidates };
}
