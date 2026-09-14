import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "../auth/types";
import { todayYmd } from "../infra/workcal";
import { AssistantV2Error, type AgentDraftState } from "./types";

/**
 * 提交授权是结构化的：只看“上一轮 Agent 是否以 focus.field=submit 明确询问过”。
 * 员工这句话是不是肯定答复由模型判断，Harness 不做任何原话匹配——
 * 原话白名单会退化成 V1 的“确认提交/提交这版”精确匹配，正是要废弃的东西。
 * 额外的确定性保护在事务层：同一轮不能既修改草稿又提交、preparedHash 必须对应当前 revision、缺口必须为空。
 */
export function submissionAuthorization(state: AgentDraftState): "focus_confirmed" | null {
  return state.lastFocus?.field === "submit" ? "focus_confirmed" : null;
}

export class AssistantV2PolicyGuard {
  constructor(private readonly db: DatabaseSync) {}

  assertTurn(user: SessionUser, state: AgentDraftState, sourceMessageId: number): void {
    if (state.userId !== user.id) throw new AssistantV2Error("session_forbidden", "无权访问该日报助手会话");
    if (state.workDate !== todayYmd()) throw new AssistantV2Error("work_date_forbidden", "日报助手只处理当天日报");
    // 已提交的当日日报仍可继续对话修改并再次确认（开发文档 §15.3）；只有 abandoned 会话拒绝写入。
    if (state.status === "abandoned") throw new AssistantV2Error("session_not_active", "该日报助手会话已结束");
    const message = this.db
      .prepare("SELECT session_id, role FROM assistant_messages WHERE id = ?")
      .get(sourceMessageId) as { session_id: number; role: string } | undefined;
    if (!message || message.session_id !== state.sessionId || message.role !== "user") {
      throw new AssistantV2Error("source_message_forbidden", "授权消息不属于当前用户会话");
    }
    const latest = this.db
      .prepare("SELECT id FROM assistant_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(state.sessionId) as { id: number } | undefined;
    if (!latest || latest.id !== sourceMessageId) {
      throw new AssistantV2Error("stale_source_message", "授权消息不是当前会话的最新用户消息", true);
    }
  }

  assertRevision(state: AgentDraftState, expectedRevision: number): void {
    if (state.revision !== expectedRevision) {
      throw new AssistantV2Error(
        "revision_conflict",
        `revision 冲突：期望 ${expectedRevision}，当前 ${state.revision}。请重新读取最新投影。`,
        true,
      );
    }
  }

  assertProjectVisible(state: AgentDraftState, projectId: number | null): void {
    if (projectId === null) return;
    if (!state.visibleProjects.some((project) => project.id === projectId)) {
      throw new AssistantV2Error("project_forbidden", `项目 ${projectId} 不在当前用户的可见项目列表中`);
    }
  }

  assertSubmissionAuthorized(state: AgentDraftState): "focus_confirmed" {
    const authorization = submissionAuthorization(state);
    if (!authorization) {
      throw new AssistantV2Error(
        "submission_not_authorized",
        "当前消息没有结构化提交授权：上一轮没有以 focus.field=submit 询问是否提交。本轮只能 reply(focus.field=submit) 询问，不能提交。",
        true,
      );
    }
    return authorization;
  }
}
