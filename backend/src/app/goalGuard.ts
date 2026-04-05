import { config } from "../core/config.js";
import type { GoalGuardConfig } from "../types/models.js";

function buildDefaultResumePromptTemplate(successKeywords: string[]): string {
  const primaryKeyword = successKeywords.find((keyword) => keyword.trim().length > 0) ?? "SUCCESS";
  return `继续执行既定目标，未完成前不要停止。完成后必须输出 ${primaryKeyword}。`;
}

export function buildGoalGuardConfig(body: unknown): GoalGuardConfig {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const successKeywords = Array.isArray(data.successKeywords)
    ? data.successKeywords.map((item: unknown) => String(item)).filter(Boolean)
    : [];
  return {
    enabled: data.enabled === true,
    goalText: typeof data.goalText === "string" ? data.goalText : "",
    successKeywords,
    successCommand:
      typeof data.successCommand === "string" && data.successCommand.trim() ? data.successCommand : null,
    idleTimeoutSec: Number(data.idleTimeoutSec ?? config.defaultIdleTimeoutSec),
    resumePromptTemplate:
      typeof data.resumePromptTemplate === "string" && data.resumePromptTemplate.trim()
        ? data.resumePromptTemplate
        : buildDefaultResumePromptTemplate(successKeywords),
    allowManualStopAfterSuccess: data.allowManualStopAfterSuccess !== false,
  };
}
