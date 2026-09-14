import { chatJson, llmAvailable } from "../llm/client";
import { logStructured } from "../infra/logger";
import type { AssistantAction, AssistantSession } from "./conversation-schema";
import { validateAssistantAction } from "./structured-validation";
import { CONVERSATION_PLANNER_SYSTEM_PROMPT } from "./prompts/conversation-planner-prompt";

export interface VisibleConversationProject {
  id: number;
  name: string;
}

export interface ConversationPlanInput {
  session: AssistantSession;
  message: string;
  projects: VisibleConversationProject[];
}

export interface ConversationPlannerService {
  plan(input: ConversationPlanInput): Promise<AssistantAction[] | null>;
}

function validatePlannerOutput(value: unknown): AssistantAction[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("规划输出必须是对象");
  const actions = (value as Record<string, unknown>).actions;
  if (!Array.isArray(actions) || actions.length > 20) throw new Error("actions 必须是最多 20 项的数组");
  return actions.map(validateAssistantAction);
}

export class LlmConversationPlannerService implements ConversationPlannerService {
  async plan(input: ConversationPlanInput): Promise<AssistantAction[] | null> {
    if (!llmAvailable()) return null;
    const payload = {
      stage: input.session.items.some((item) => !item.employeeConfirmed) ? "confirm_candidates" : "complete_facts",
      items: input.session.items.map((item) => ({
        id: item.id,
        order: item.order,
        origin: item.origin,
        employeeConfirmed: item.employeeConfirmed,
        scopeType: item.scopeType,
        projectId: item.projectId,
        workStatus: item.workStatus,
        workSummary: item.workSummary,
        resultText: item.resultText,
        hours: item.hours,
        blockerText: item.blockerText,
        nextAction: item.nextAction,
      })),
      visibleProjects: input.projects,
      employeeMessage: input.message,
    };
    try {
      return await chatJson(
        [
          { role: "system", content: CONVERSATION_PLANNER_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
        validatePlannerOutput,
        { tier: "strong", temperature: 0.1, maxTokens: 1600 },
      );
    } catch (error) {
      logStructured({ evt: "assistant_conversation_planner_fallback", reason: "model_or_schema_error", error: String(error) });
      return null;
    }
  }
}
