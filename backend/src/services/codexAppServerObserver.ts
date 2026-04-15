import type {
  AppServerTurnStateSource,
  CodexAssistantMessageRecord,
  CodexObservation,
  CodexObservationMatchMode,
  CodexObservedTurnState,
  GoalGuardConfig,
  ManagedSessionRecord,
} from "../types/models.js";
import { codexAppServerNotificationCache } from "./codexAppServerNotificationCache.js";
import { codexAppServerThreadCache } from "./codexAppServerThreadCache.js";
import { CodexAppServerProbeClient, type CodexAppServerThreadReadResult } from "./codexAppServerProbe.js";

interface CodexAppServerObserverInspectOptions {
  sinceTimestamp?: number | null;
  goalConfig?: GoalGuardConfig;
}

type CodexAppServerProbeClientLike = Pick<CodexAppServerProbeClient, "initialize" | "readThread" | "disconnect">;

interface CachedObservationEntry {
  expiresAt: number;
  observation: CodexObservation;
}

interface ParsedTurnSnapshot {
  state: CodexObservedTurnState;
  assistantMessages: CodexAssistantMessageRecord[];
  errors: string[];
  commands: string[];
  matchedSuccessKeyword: string | null;
  matchedStandaloneSuccess: boolean;
  matchedIncompleteSignals: string[];
  successMessage: string | null;
  successMessageAt: number | null;
  fatalError: string | null;
  notificationUpdatedAt: number | null;
}

const observationTtlMs = 2_000;
const managerSnapshotMaxAgeMs = 15_000;
const maxRecentAssistantMessages = 6;
const maxRecentErrors = 5;
const maxRecentCommands = 6;

const fatalErrorPatterns = [
  /exceeded retry limit/i,
  /last status:\s*429\b/i,
  /\b429 Too Many Requests\b/i,
  /unexpected status\s*403\b.*\/v1\/responses\b/i,
  /\b403 Forbidden\b.*\/v1\/responses\b/i,
  /service error,\s*please retry.*\/v1\/responses\b/i,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
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

function resolveMatchMode(session: ManagedSessionRecord, threadId: string): CodexObservationMatchMode {
  if (session.currentCodexSessionId === threadId) {
    return "current_session_id";
  }
  if (session.mode === "resume" && session.sourceCodexSessionId === threadId) {
    return "source_session_id";
  }
  return null;
}

function extractCommandText(item: Record<string, unknown>): string | null {
  const command = asString(item.command) ?? asString(item.commandText) ?? asString(item.text);
  if (command) {
    return command;
  }
  if (Array.isArray(item.command)) {
    const parts = item.command.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  return null;
}

function extractNotificationField(notification: unknown, key: string): unknown {
  const record = asRecord(notification);
  const params = asRecord(record?.params);
  return params?.[key];
}

function parseNotificationSnapshot(threadId: string, sinceTimestamp: number | null): {
  state: CodexObservedTurnState | null;
  assistantMessages: CodexAssistantMessageRecord[];
  errors: string[];
  commands: string[];
  lastEventAt: number | null;
} {
  const notifications = codexAppServerNotificationCache.listThreadNotifications(threadId);
  if (notifications.length === 0) {
    return {
      state: null,
      assistantMessages: [],
      errors: [],
      commands: [],
      lastEventAt: null,
    };
  }

  let state: CodexObservedTurnState | null = null;
  const assistantMessages: CodexAssistantMessageRecord[] = [];
  const errors: string[] = [];
  const commands: string[] = [];
  let lastEventAt: number | null = null;

  for (const notification of notifications) {
    lastEventAt = notification.receivedAt;
    const withinGoalWindow = sinceTimestamp === null || notification.receivedAt >= sinceTimestamp;
    if (notification.method === "turn/started") {
      state = "running";
    }
    if (notification.method === "turn/completed") {
      const turn = asRecord(extractNotificationField(notification, "turn"));
      state = applySequentialObservedState(state, mapTurnState(turn?.status, null));
      const turnError = asRecord(turn?.error);
      const turnErrorMessage = asString(turn?.error) ?? asString(turnError?.message);
      if (turnErrorMessage && withinGoalWindow) {
        errors.push(turnErrorMessage);
      }
    }
    if (notification.method === "thread/status/changed") {
      const status = extractNotificationField(notification, "status");
      state = applySequentialObservedState(state, mapTurnState(null, status));
    }
    if (notification.method === "error") {
      const error = asRecord(extractNotificationField(notification, "error"));
      const message = asString(error?.message);
      if (message && withinGoalWindow) {
        errors.push(message);
      }
      state = "failed";
    }
    if (notification.method === "item/agentMessage/delta" && withinGoalWindow) {
      const delta = extractNotificationField(notification, "delta");
      if (typeof delta === "string" && delta.length > 0) {
        assistantMessages.push({
          timestamp: notification.receivedAt,
          phase: "delta",
          text: delta,
        });
      }
    }
    if (notification.method === "item/completed" && withinGoalWindow) {
      const item = asRecord(extractNotificationField(notification, "item"));
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.length > 0) {
        assistantMessages.push({
          timestamp: notification.receivedAt,
          phase: asString(item.phase),
          text: item.text,
        });
      }
      if (item?.type === "commandExecution") {
        const command = extractCommandText(item);
        if (command) {
          commands.push(command);
        }
        const error = asString(item.error);
        if (error) {
          errors.push(error);
        }
      }
    }
  }

  return {
    state,
    assistantMessages,
    errors,
    commands,
    lastEventAt,
  };
}

function extractStatusType(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  return asString(record?.type);
}

function mapTurnState(value: unknown, fallback: unknown): CodexObservedTurnState {
  const normalized = extractStatusType(value) ?? extractStatusType(fallback);
  switch (normalized) {
    case "inProgress":
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
    case "systemError":
      return "failed";
    case "idle":
      return "idle";
    default:
      return normalized ? "idle" : "unavailable";
  }
}

function mergeObservedTurnStates(
  primary: CodexObservedTurnState | null,
  secondary: CodexObservedTurnState | null,
): CodexObservedTurnState {
  const states = [primary, secondary].filter((value): value is CodexObservedTurnState => value !== null);
  if (states.includes("failed")) {
    return "failed";
  }
  if (states.includes("running")) {
    return "running";
  }
  if (states.includes("completed")) {
    return "completed";
  }
  if (states.includes("idle")) {
    return "idle";
  }
  return "unavailable";
}

function applySequentialObservedState(
  current: CodexObservedTurnState | null,
  next: CodexObservedTurnState,
): CodexObservedTurnState {
  if (current === "failed" || next === "failed") {
    return "failed";
  }
  return next === "unavailable" ? (current ?? "unavailable") : next;
}

function resolveThreadReadState(
  turnState: CodexObservedTurnState,
  threadState: CodexObservedTurnState,
): CodexObservedTurnState {
  if (turnState === "failed" || threadState === "failed") {
    return "failed";
  }
  if (turnState !== "unavailable") {
    return turnState;
  }
  return threadState;
}

function resolvePreferredObservedState(
  preferred: CodexObservedTurnState | null,
  fallback: CodexObservedTurnState | null,
): CodexObservedTurnState {
  if (preferred === "failed" || fallback === "failed") {
    return "failed";
  }
  if (preferred && preferred !== "unavailable") {
    return preferred;
  }
  if (fallback && fallback !== "unavailable") {
    return fallback;
  }
  return "unavailable";
}

function resolveObservedStateWithSource(
  notificationState: CodexObservedTurnState | null,
  parsedTurnState: CodexObservedTurnState,
): { state: CodexObservedTurnState; source: AppServerTurnStateSource } {
  if (notificationState === "failed" || parsedTurnState === "failed") {
    return { state: "failed", source: "failed_conflict" };
  }
  if (notificationState && notificationState !== "unavailable") {
    return { state: notificationState, source: "notification_cache" };
  }
  if (parsedTurnState !== "unavailable") {
    return { state: parsedTurnState, source: "thread_read" };
  }
  return { state: "unavailable", source: null };
}

function parseLastTurn(
  lastTurn: Record<string, unknown> | null,
  threadStatus: unknown,
  lastEventAt: number | null,
  sinceTimestamp: number | null,
  goalConfig?: GoalGuardConfig,
): ParsedTurnSnapshot {
  const state = resolveThreadReadState(
    mapTurnState(lastTurn?.status, null),
    mapTurnState(null, threadStatus),
  );
  const turnStartedAt =
    parseTimestamp(lastTurn?.startedAt)
    ?? parseTimestamp(lastTurn?.createdAt);
  const turnBoundaryAt =
    parseTimestamp(lastTurn?.completedAt)
    ?? parseTimestamp(lastTurn?.updatedAt)
    ?? turnStartedAt;
  const includeTurnPayload =
    sinceTimestamp === null
    || (state === "running" && turnStartedAt !== null && turnStartedAt >= sinceTimestamp)
    || (turnBoundaryAt !== null && turnBoundaryAt >= sinceTimestamp);
  if (!lastTurn || !includeTurnPayload) {
    return {
      state,
      assistantMessages: [],
      errors: [],
      commands: [],
      matchedSuccessKeyword: null,
      matchedStandaloneSuccess: false,
      matchedIncompleteSignals: [],
      successMessage: null,
      successMessageAt: null,
      fatalError: null,
      notificationUpdatedAt: null,
    };
  }

  const notificationSnapshot = lastTurn ? null : undefined;
  const assistantMessages: CodexAssistantMessageRecord[] = [];
  const errors: string[] = [];
  const commands: string[] = [];
  const turnTimestamp = lastEventAt ?? Date.now();
  const items = Array.isArray(lastTurn.items) ? lastTurn.items : [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const itemType = asString(record.type);
    if (itemType === "agentMessage") {
      const text = asString(record.text);
      if (text) {
        assistantMessages.push({
          timestamp: turnTimestamp,
          phase: asString(record.phase),
          text,
        });
      }
      continue;
    }
    if (itemType === "commandExecution") {
      const command = extractCommandText(record);
      if (command) {
        commands.push(command);
      }
      const error = asString(record.error);
      if (error) {
        errors.push(error);
      }
    }
  }

  const turnError = asRecord(lastTurn.error);
  const turnErrorMessage = asString(lastTurn.error) ?? asString(turnError?.message);
  if (turnErrorMessage) {
    errors.push(turnErrorMessage);
  }

  const assistantText = assistantMessages.map((message) => message.text).join("\n");
  const matchedSuccessKeyword = null;
  const matchedStandaloneSuccess = hasStandaloneSuccessMarker(assistantText, goalConfig);
  const matchedIncompleteSignals = findIncompleteProgressSignals(assistantText);
  const successMessageRecord =
    assistantMessages.find((message) => hasStandaloneSuccessMarker(message.text, goalConfig))
    ?? null;
  const fatalError = errors.find((message) => fatalErrorPatterns.some((pattern) => pattern.test(message))) ?? null;
  const threadStatusType = extractStatusType(threadStatus);

  return {
    state,
    assistantMessages,
    errors,
    commands,
    matchedSuccessKeyword,
    matchedStandaloneSuccess,
    matchedIncompleteSignals,
    successMessage: successMessageRecord?.text ?? null,
    successMessageAt: successMessageRecord?.timestamp ?? null,
    fatalError: fatalError ?? (threadStatusType === "systemError" ? "Codex app-server thread entered systemError state" : null),
    notificationUpdatedAt: null,
  };
}

export class CodexAppServerObserver {
  private readonly observationCache = new Map<string, CachedObservationEntry>();

  constructor(
    private readonly clientFactory: () => CodexAppServerProbeClientLike = () => new CodexAppServerProbeClient(),
  ) {}

  private buildObservationFromThreadRead(
    session: ManagedSessionRecord,
    threadRead: CodexAppServerThreadReadResult,
    options: CodexAppServerObserverInspectOptions = {},
  ): CodexObservation {
    const rawThread = threadRead.rawThread ?? {};
    const sessionStartedAt = parseTimestamp(rawThread.createdAt);
    const notificationSnapshot = parseNotificationSnapshot(threadRead.threadId, options.sinceTimestamp ?? null);
    const threadUpdatedAt = parseTimestamp(rawThread.updatedAt);
    const lastEventAt = Math.max(threadUpdatedAt ?? 0, notificationSnapshot.lastEventAt ?? 0) || null;
    const threadStatus = rawThread.status;
    const lastTurn = Array.isArray(threadRead.turns) && threadRead.turns.length > 0
      ? asRecord(threadRead.turns[threadRead.turns.length - 1])
      : null;
    const parsedTurn = parseLastTurn(lastTurn, threadStatus, lastEventAt, options.sinceTimestamp ?? null, options.goalConfig);
    const assistantMessages = [...parsedTurn.assistantMessages, ...notificationSnapshot.assistantMessages].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    const errors = [...parsedTurn.errors, ...notificationSnapshot.errors];
    const commands = [...parsedTurn.commands, ...notificationSnapshot.commands];
    const assistantText = assistantMessages.map((message) => message.text).join("\n");
    const matchedSuccessKeyword = null;
    const matchedStandaloneSuccess = hasStandaloneSuccessMarker(assistantText, options.goalConfig);
    const matchedIncompleteSignals = findIncompleteProgressSignals(assistantText);
    const successMessageRecord =
      assistantMessages.find((message) => hasStandaloneSuccessMarker(message.text, options.goalConfig))
      ?? null;
    const resolvedTurnState = resolveObservedStateWithSource(notificationSnapshot.state, parsedTurn.state);
    const turnState = resolvedTurnState.state;
    const fatalError = errors.find((message) => fatalErrorPatterns.some((pattern) => pattern.test(message))) ?? parsedTurn.fatalError;
    return {
      available: true,
      matchedSessionId: threadRead.threadId,
      matchedBy: resolveMatchMode(session, threadRead.threadId),
      sessionCwd: threadRead.cwd,
      sessionStartedAt,
      lastEventAt,
      turnState,
      appServerTurnStateSource: resolvedTurnState.source,
      currentTurnStartedAt: turnState === "running" ? (lastEventAt ?? sessionStartedAt) : null,
      lastTurnCompletedAt: turnState === "completed" || turnState === "failed" ? lastEventAt : null,
      recentAssistantMessages: tailNonEmptyMessages(assistantMessages, maxRecentAssistantMessages),
      recentErrors: errors.slice(-maxRecentErrors),
      recentCommands: commands.slice(-maxRecentCommands),
      matchedSuccessKeyword,
      matchedStandaloneSuccess,
      matchedIncompleteSignals,
      successMessage: successMessageRecord?.text ?? parsedTurn.successMessage,
      successMessageAt: successMessageRecord?.timestamp ?? parsedTurn.successMessageAt,
      fatalError,
    };
  }

  async inspectSession(
    session: ManagedSessionRecord,
    options: CodexAppServerObserverInspectOptions = {},
  ): Promise<CodexObservation> {
    const threadId = session.currentCodexSessionId ?? (session.executionChannel === "app_server_remote_tui" ? session.sourceCodexSessionId : null);
    if (!threadId) {
      return buildUnavailableObservation();
    }
    const now = Date.now();
    const cached = this.observationCache.get(threadId);
    if (cached && cached.expiresAt > now) {
      return cached.observation;
    }

    let observation = buildUnavailableObservation();
    const managerSummary = codexAppServerThreadCache.getThreadManagerSummary(threadId);
    const managerThreadRead = codexAppServerThreadCache.getThreadRead(threadId);
    const hasFreshManagerSnapshot =
      managerSummary.hasSnapshot
      && managerSummary.lastSyncOk
      && managerSummary.lastSyncedAt !== null
      && now - managerSummary.lastSyncedAt <= managerSnapshotMaxAgeMs
      && managerThreadRead !== null;
    if (hasFreshManagerSnapshot && managerThreadRead) {
      observation = this.buildObservationFromThreadRead(session, managerThreadRead, options);
      this.observationCache.set(threadId, {
        expiresAt: now + observationTtlMs,
        observation,
      });
      return observation;
    }

    const client = this.clientFactory();
    try {
      await client.initialize({
        clientInfo: {
          name: "touchmux-app-server-observer",
          version: "0.1.0",
          title: "TouchMux App Server Observer",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      const threadRead = await client.readThread(threadId, true);
      codexAppServerThreadCache.recordThreadRead(threadRead, Date.now());
      observation = this.buildObservationFromThreadRead(session, threadRead, options);
    } catch (error) {
      observation = managerThreadRead
        ? this.buildObservationFromThreadRead(session, managerThreadRead, options)
        : buildUnavailableObservation();
    } finally {
      await client.disconnect();
    }

    this.observationCache.set(threadId, {
      expiresAt: now + observationTtlMs,
      observation,
    });
    return observation;
  }
}
