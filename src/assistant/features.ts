export interface AssistantRolloutFlags {
  enabled: boolean;
  conversationEnabled: boolean;
  submitEnabled: boolean;
  managerOverviewEnabled: boolean;
  prewarmEnabled: boolean;
  reminderEnabled: boolean;
}

export type AssistantFeature = "context" | "conversation" | "submit" | "manager" | "prewarm" | "reminder";

/** 子功能必须同时满足总开关，关闭后旧填写和旧主管首页仍可工作。 */
export function assistantFeatureEnabled(feature: AssistantFeature, flags: AssistantRolloutFlags): boolean {
  if (!flags.enabled) return false;
  if (feature === "context") return true;
  if (feature === "conversation") return flags.conversationEnabled;
  if (feature === "submit") return flags.conversationEnabled && flags.submitEnabled;
  if (feature === "manager") return flags.managerOverviewEnabled;
  if (feature === "prewarm") return flags.prewarmEnabled;
  return flags.reminderEnabled;
}

export function assistantEventFusionEnabledForUser(
  ddUserid: string | null | undefined,
  enabled: boolean,
  pilotUserids: readonly string[],
): boolean {
  const userId = String(ddUserid ?? "").trim();
  return enabled && Boolean(userId) && pilotUserids.includes(userId);
}

/** 工作发现与事件融合分开灰度，避免扩大召回范围影响非试点员工。 */
export function assistantWorkDiscoveryEnabledForUser(
  ddUserid: string | null | undefined,
  enabled: boolean,
  pilotUserids: readonly string[],
): boolean {
  const userId = String(ddUserid ?? "").trim();
  return enabled && Boolean(userId) && pilotUserids.includes(userId);
}
