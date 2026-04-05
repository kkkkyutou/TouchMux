import fs from "node:fs";
import path from "node:path";
import { config } from "../core/config.js";
import type {
  CodexAssistantMessageRecord,
  CodexObservation,
  CodexObservationMatchMode,
  CodexObservedTurnState,
  GoalGuardConfig,
  ManagedSessionRecord,
} from "../types/models.js";

interface CodexObserverInspectOptions {
  sinceTimestamp?: number | null;
  goalConfig?: GoalGuardConfig;
}

interface CachedResolvedMatch {
  expiresAt: number;
  filePath: string | null;
  matchedBy: CodexObservationMatchMode;
}

interface CachedParsedRollout {
  cachedAt: number;
  mtimeMs: number;
  size: number;
  parsed: ParsedCodexRollout;
}

interface ParsedCodexRollout {
  filePath: string;
  sessionId: string | null;
  cwd: string | null;
  sessionStartedAt: number | null;
  lastEventAt: number | null;
  turnState: CodexObservedTurnState;
  currentTurnStartedAt: number | null;
  lastTurnCompletedAt: number | null;
  assistantMessages: CodexAssistantMessageRecord[];
  errors: Array<{
    timestamp: number;
    message: string;
  }>;
  commands: Array<{
    timestamp: number;
    command: string;
  }>;
}

const resolvedMatchTtlMs = 15_000;
const parsedRolloutTtlMs = 2_000;
const matchWindowBeforeMs = 5 * 60 * 1000;
const matchWindowAfterMs = 6 * 60 * 60 * 1000;
const maxRecentAssistantMessages = 6;
const maxRecentErrors = 5;
const maxRecentCommands = 6;

const fatalErrorPatterns = [
  /exceeded retry limit/i,
  /last status:\s*429\b/i,
  /\b429 Too Many Requests\b/i,
  /rate limit(ed|ing)?/i,
  /quota exceeded/i,
  /insufficient[_ ]quota/i,
  /authentication failed/i,
  /invalid api key/i,
  /network error/i,
  /connection (?:failed|lost|reset|timed out)/i,
  /timed out while/i,
  /temporary failure in name resolution/i,
  /ENOTFOUND\b/i,
  /ECONNRESET\b/i,
  /ECONNREFUSED\b/i,
  /EHOSTUNREACH\b/i,
];

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeGoalText(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\r/g, "\n");
}

function compactGoalText(value: string): string {
  return normalizeGoalText(value).replace(/\s+/g, " ").trim();
}

function getPrimarySuccessMarker(goalConfig: GoalGuardConfig | null | undefined): string | null {
  const firstKeyword = goalConfig?.successKeywords.find((keyword) => keyword.trim().length > 0) ?? null;
  return firstKeyword ? compactGoalText(firstKeyword) || null : null;
}

function tailNonEmptyMessages(messages: CodexAssistantMessageRecord[], limit: number): CodexAssistantMessageRecord[] {
  return messages
    .filter((message) => message.text.trim().length > 0)
    .slice(-limit);
}

function hasStandaloneSuccessMarker(value: string, goalConfig: GoalGuardConfig | null | undefined): boolean {
  const marker = getPrimarySuccessMarker(goalConfig);
  if (!marker) {
    return false;
  }
  return normalizeGoalText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .some((line) => compactGoalText(line) === marker);
}

const incompleteSignalPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "仍未完成", pattern: /仍未完成/ },
  { label: "当前项目仍未完成", pattern: /当前项目仍未完成/ },
  { label: "还在继续", pattern: /还在继续/ },
  { label: "构建还在继续", pattern: /构建还在继续/ },
  { label: "本轮只完成一步", pattern: /本轮只完成了?一步/ },
  { label: "只执行一步", pattern: /只执行了?一.*步/ },
  { label: "下一轮应", pattern: /下一轮应/ },
  { label: "继续开发", pattern: /继续开发/ },
  { label: "未进入", pattern: /未进入/ },
  { label: "尚未完成", pattern: /尚未完成/ },
  { label: "无剩余但增强项", pattern: /没有剩余.*但.*增强项/ },
];

function findIncompleteProgressSignals(value: string): string[] {
  const normalized = normalizeGoalText(value);
  return incompleteSignalPatterns.filter((entry) => entry.pattern.test(normalized)).map((entry) => entry.label);
}

function formatCommand(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

function buildUnavailableObservation(): CodexObservation {
  return {
    available: false,
    matchedSessionId: null,
    matchedBy: null,
    sessionCwd: null,
    sessionStartedAt: null,
    lastEventAt: null,
    turnState: "unavailable",
    appServerTurnStateSource: null,
    currentTurnStartedAt: null,
    lastTurnCompletedAt: null,
    recentAssistantMessages: [],
    recentErrors: [],
    recentCommands: [],
    matchedSuccessKeyword: null,
    matchedStandaloneSuccess: false,
    matchedIncompleteSignals: [],
    successMessage: null,
    successMessageAt: null,
    fatalError: null,
  };
}

export class CodexObserver {
  private readonly resolvedMatchCache = new Map<string, CachedResolvedMatch>();
  private readonly parsedRolloutCache = new Map<string, CachedParsedRollout>();

  inspectSession(session: ManagedSessionRecord, options: CodexObserverInspectOptions = {}): CodexObservation {
    const match = this.resolveMatch(session);
    if (!match.filePath) {
      return buildUnavailableObservation();
    }

    const parsed = this.parseRollout(match.filePath);
    const sinceTimestamp = options.sinceTimestamp ?? null;
    const assistantMessages = parsed.assistantMessages.filter((message) =>
      sinceTimestamp === null ? true : message.timestamp >= sinceTimestamp,
    );
    const errors = parsed.errors.filter((entry) => (sinceTimestamp === null ? true : entry.timestamp >= sinceTimestamp));
    const commands = parsed.commands.filter((entry) => (sinceTimestamp === null ? true : entry.timestamp >= sinceTimestamp));

    const preferredMessages = assistantMessages.filter((message) => message.phase !== "commentary");
    const successCandidateMessages = preferredMessages.length > 0 ? preferredMessages : assistantMessages;
    const successText = successCandidateMessages.map((message) => message.text).join("\n");
    const allAssistantText = assistantMessages.map((message) => message.text).join("\n");
    const fatalErrorFloor = parsed.currentTurnStartedAt ?? sinceTimestamp;
    const fatalRelevantErrors = errors.filter((entry) => (fatalErrorFloor === null ? true : entry.timestamp >= fatalErrorFloor));
    const matchedStandaloneSuccess = hasStandaloneSuccessMarker(successText, options.goalConfig);
    const matchedSuccessKeyword = options.goalConfig
      ? options.goalConfig.successKeywords.find((keyword) =>
          compactGoalText(successText).toLowerCase().includes(compactGoalText(keyword).toLowerCase()),
        ) ?? null
      : null;
    const matchedIncompleteSignals = findIncompleteProgressSignals(allAssistantText);
    const successMessageRecord =
      successCandidateMessages.find((message) => hasStandaloneSuccessMarker(message.text, options.goalConfig)) ??
      successCandidateMessages.find((message) =>
        options.goalConfig
          ? options.goalConfig.successKeywords.some((keyword) =>
              compactGoalText(message.text).toLowerCase().includes(compactGoalText(keyword).toLowerCase()),
            )
          : false,
      ) ??
      null;
    const fatalError = fatalRelevantErrors.map((entry) => entry.message).find((message) =>
      fatalErrorPatterns.some((pattern) => pattern.test(message)),
    ) ?? null;

    return {
      available: true,
      matchedSessionId: parsed.sessionId,
      matchedBy: match.matchedBy,
      sessionCwd: parsed.cwd,
      sessionStartedAt: parsed.sessionStartedAt,
      lastEventAt: parsed.lastEventAt,
      turnState: parsed.turnState,
      appServerTurnStateSource: null,
      currentTurnStartedAt: parsed.currentTurnStartedAt,
      lastTurnCompletedAt: parsed.lastTurnCompletedAt,
      recentAssistantMessages: tailNonEmptyMessages(assistantMessages, maxRecentAssistantMessages),
      recentErrors: errors.map((entry) => entry.message).slice(-maxRecentErrors),
      recentCommands: commands.map((entry) => entry.command).slice(-maxRecentCommands),
      matchedSuccessKeyword,
      matchedStandaloneSuccess,
      matchedIncompleteSignals,
      successMessage: successMessageRecord?.text ?? null,
      successMessageAt: successMessageRecord?.timestamp ?? null,
      fatalError,
    };
  }

  private resolveMatch(session: ManagedSessionRecord): CachedResolvedMatch {
    const now = Date.now();
    const cached = this.resolvedMatchCache.get(session.id);
    if (cached && cached.expiresAt > now && (cached.filePath === null || fs.existsSync(cached.filePath))) {
      return cached;
    }

    const resolved = this.resolveMatchUncached(session);
    const next = {
      ...resolved,
      expiresAt: now + resolvedMatchTtlMs,
    };
    this.resolvedMatchCache.set(session.id, next);
    return next;
  }

  private resolveMatchUncached(session: ManagedSessionRecord): Omit<CachedResolvedMatch, "expiresAt"> {
    const candidateFiles = this.listCandidateFiles(session.createdAt);
    if (session.currentCodexSessionId) {
      const exactFile = candidateFiles.find((filePath) => filePath.endsWith(`-${session.currentCodexSessionId}.jsonl`));
      if (exactFile) {
        return {
          filePath: exactFile,
          matchedBy: "current_session_id",
        };
      }
    }
    if (session.mode === "resume" && session.sourceCodexSessionId) {
      const exactFile = candidateFiles.find((filePath) => filePath.endsWith(`-${session.sourceCodexSessionId}.jsonl`));
      if (exactFile) {
        return {
          filePath: exactFile,
          matchedBy: "source_session_id",
        };
      }
    }

    const sessionCwd = path.resolve(session.workspaceRoot, session.cwd);
    let bestMatch: { filePath: string; score: number } | null = null;
    for (const filePath of candidateFiles) {
      const parsed = this.parseRollout(filePath);
      if (!parsed.cwd || path.resolve(parsed.cwd) !== sessionCwd || parsed.sessionStartedAt === null) {
        continue;
      }
      const diff = parsed.sessionStartedAt - session.createdAt;
      if (diff < -matchWindowBeforeMs || diff > matchWindowAfterMs) {
        continue;
      }
      const score = diff >= 0 ? diff : Math.abs(diff) + matchWindowAfterMs;
      if (!bestMatch || score < bestMatch.score) {
        bestMatch = { filePath, score };
      }
    }

    return {
      filePath: bestMatch?.filePath ?? null,
      matchedBy: bestMatch ? "cwd_timestamp" : null,
    };
  }

  private listCandidateFiles(referenceTimestamp: number): string[] {
    if (!fs.existsSync(config.sessionsDir)) {
      return [];
    }
    const dateKeys = new Set<string>();
    for (const ts of [referenceTimestamp - matchWindowBeforeMs, referenceTimestamp, Date.now()]) {
      const date = new Date(ts);
      const year = String(date.getFullYear()).padStart(4, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      dateKeys.add(path.join(config.sessionsDir, year, month, day));
    }

    const files: string[] = [];
    for (const dirPath of dateKeys) {
      if (!fs.existsSync(dirPath)) {
        continue;
      }
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(path.join(dirPath, entry.name));
        }
      }
    }
    return files.sort();
  }

  private parseRollout(filePath: string): ParsedCodexRollout {
    const stat = fs.statSync(filePath);
    const now = Date.now();
    const cached = this.parsedRolloutCache.get(filePath);
    if (
      cached &&
      now - cached.cachedAt <= parsedRolloutTtlMs &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.parsed;
    }

    const content = fs.readFileSync(filePath, "utf8");
    const parsed: ParsedCodexRollout = {
      filePath,
      sessionId: null,
      cwd: null,
      sessionStartedAt: null,
      lastEventAt: null,
      turnState: "idle",
      currentTurnStartedAt: null,
      lastTurnCompletedAt: null,
      assistantMessages: [],
      errors: [],
      commands: [],
    };

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const timestamp = parseTimestamp(entry.timestamp);
      if (timestamp !== null) {
        parsed.lastEventAt = Math.max(parsed.lastEventAt ?? 0, timestamp);
      }
      const type = asString(entry.type);
      if (type === "session_meta") {
        const payload = asRecord(entry.payload);
        parsed.sessionId = asString(payload?.id);
        parsed.cwd = asString(payload?.cwd);
        parsed.sessionStartedAt = parseTimestamp(payload?.timestamp);
        continue;
      }
      if (type !== "event_msg") {
        continue;
      }
      const payload = asRecord(entry.payload);
      const payloadType = asString(payload?.type);
      if (!payloadType) {
        continue;
      }
      if (payloadType === "task_started") {
        parsed.turnState = "running";
        parsed.currentTurnStartedAt = timestamp;
        continue;
      }
      if (payloadType === "task_complete") {
        parsed.turnState = parsed.turnState === "failed" ? "failed" : "completed";
        parsed.lastTurnCompletedAt = timestamp;
        continue;
      }
      if (payloadType === "task_failed") {
        const message = asString(payload?.error) ?? "Codex task_failed";
        parsed.turnState = "failed";
        parsed.errors.push({
          timestamp: timestamp ?? Date.now(),
          message,
        });
        continue;
      }
      if (payloadType === "error") {
        const message = asString(payload?.message);
        if (message) {
          parsed.errors.push({
            timestamp: timestamp ?? Date.now(),
            message,
          });
          if (fatalErrorPatterns.some((pattern) => pattern.test(message))) {
            parsed.turnState = "failed";
          }
        }
        continue;
      }
      if (payloadType === "agent_message") {
        const message = asString(payload?.message);
        if (message) {
          parsed.assistantMessages.push({
            timestamp: timestamp ?? Date.now(),
            phase: asString(payload?.phase),
            text: message,
          });
        }
        continue;
      }
      if (payloadType === "exec_command_begin") {
        const command = formatCommand(payload?.command);
        if (command) {
          parsed.commands.push({
            timestamp: timestamp ?? Date.now(),
            command,
          });
        }
      }
    }

    this.parsedRolloutCache.set(filePath, {
      cachedAt: now,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      parsed,
    });
    return parsed;
  }
}
