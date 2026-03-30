import { config } from "../core/config.js";
import type { GoalGuardConfig } from "../types/models.js";

export function buildGoalGuardConfig(body: unknown): GoalGuardConfig {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    enabled: data.enabled === true,
    goalText: typeof data.goalText === "string" ? data.goalText : "",
    successKeywords: Array.isArray(data.successKeywords)
      ? data.successKeywords.map((item: unknown) => String(item)).filter(Boolean)
      : [],
    successCommand:
      typeof data.successCommand === "string" && data.successCommand.trim() ? data.successCommand : null,
    idleTimeoutSec: Number(data.idleTimeoutSec ?? config.defaultIdleTimeoutSec),
    resumePromptTemplate:
      typeof data.resumePromptTemplate === "string" && data.resumePromptTemplate.trim()
        ? data.resumePromptTemplate
        : "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。",
    allowManualStopAfterSuccess: data.allowManualStopAfterSuccess !== false,
  };
}
