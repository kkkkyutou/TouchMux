import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { spawn, type IPty } from "node-pty";
import { config } from "../core/config.js";
import type {
  AppServerDebugSummary,
  AppServerNotificationSummary,
  AppServerNotificationManagerSummary,
  AppServerThreadManagerSummary,
  AppServerBridgeProbeResult,
  CodexObservation,
  ChoiceOverlay,
  CreateSessionInput,
  GuardEventRecord,
  GuardDecisionState,
  GoalSpec,
  GoalGuardConfig,
  GoalState,
  ManagedSessionRecord,
  SessionSummary,
  SessionStatus,
  SuccessEvidence,
  VerificationReceipt,
  VerificationSpec,
  GoalGuardProgressSignal,
  GoalGuardStructuredFactSource,
} from "../types/models.js";
import { codexAppServerNotificationCache } from "./codexAppServerNotificationCache.js";
import { getCodexAppServerNotificationManagerSummary } from "./codexAppServerNotificationManager.js";
import { codexAppServerThreadCache } from "./codexAppServerThreadCache.js";
import { detectChoiceOverlay } from "./choiceDetector.js";
import { CodexAppServerObserver } from "./codexAppServerObserver.js";
import { CodexAppServerProbeClient } from "./codexAppServerProbe.js";
import { CodexObserver } from "./codexObserver.js";
import {
  type GoalGuardStateSnapshot,
  type TerminalGoalCandidateDiagnostics,
  reduceGoalGuardEvents,
  reduceGoalGuardOutputActivity,
  reduceGoalGuardVerificationResult,
} from "./goalGuardReducer.js";
import { SessionRepository } from "./sessionRepository.js";
import { normalizeInsideRoot } from "../utils/paths.js";
import { quoteArgs } from "../utils/shell.js";

interface RuntimeState {
  buffer: string;
  choiceOverlay: ChoiceOverlay;
  goalActivatedAt: number | null;
  lastAutoResumeAt: number | null;
  autoResumeCount: number;
  lastInputAt: number | null;
  goalCheckOffset: number;
  goalCheckEventSeq: number;
  lastGuardPromptAt: number | null;
  lastGuardPromptText: string;
  lastCapturedPane: string;
  lastPaneSnapshot: string;
  goalCheckPaneSnapshot: string;
  lastViewerActivityAt: number | null;
}

interface GoalGuardDebugInfo {
  sessionId: string;
  goalState: GoalState;
  guardDecisionState: GuardDecisionState;
  guardDecisionReason: string | null;
  currentTaskRunId: string | null;
  guardEnabled: boolean;
  hasTmuxSession: boolean;
  goalActivatedAt: number | null;
  lastOutputAt: number | null;
  structuredLastEventAt: number | null;
  observedActivityAt: number | null;
  progressSignal: GoalGuardProgressSignal;
  structuredFactSource: GoalGuardStructuredFactSource;
  terminalSignalsAllowed: boolean;
  appServerNotificationSummary: AppServerNotificationSummary;
  appServerNotificationManagerSummary: AppServerNotificationManagerSummary;
  appServerThreadManagerSummary: AppServerThreadManagerSummary;
  appServerDebugSummary: AppServerDebugSummary;
  lastAutoResumeAt: number | null;
  lastViewerActivityAt: number | null;
  autoResumeCount: number;
  baselineSnapshot: string;
  currentSnapshot: string;
  snapshotChanged: boolean;
  baselineTailLines: string[];
  currentTailLines: string[];
  goalWindowTailLines: string[];
  sanitizedGoalWindowTailLines: string[];
  matchedSuccessKeyword: string | null;
  matchedStandaloneSuccess: boolean;
  matchedIncompleteSignals: string[];
  changedTailLines: Array<{
    line: number;
    baseline: string;
    current: string;
  }>;
  goalSpec: GoalSpec | null;
  verificationSpec: VerificationSpec | null;
  verificationReceipt: VerificationReceipt | null;
  recentEvents: GuardEventRecord[];
  successEvidence: SuccessEvidence | null;
  codexObservation: CodexObservation;
}

interface GoalMatchDiagnostics {
  matchedSuccessKeyword: string | null;
  matchedStandaloneSuccess: boolean;
  matchedIncompleteSignals: string[];
  evidenceEventSeq: number | null;
  sanitizedGoalWindow: string;
}

interface GoalVerificationCandidate {
  kind: SuccessEvidence["kind"];
  source: "codex_assistant_message" | "terminal_signal";
  eventSeq: number | null;
  detail: string;
}

interface ParsedStructuredVerifier {
  kind: VerificationSpec["kind"];
  path?: string;
  containsText?: string;
  jsonPath?: string;
  expectedValue?: unknown;
}

const submitDelayArray = new Int32Array(new SharedArrayBuffer(4));
const tmuxLiteralSubmitDelayMs = 300;
const guardEchoWindowMs = 4000;
const goalGuardFirstProbeDelayMs = 5000;
const goalGuardRunningCooldownMs = 4000;

const hiddenOverlay: ChoiceOverlay = {
  visible: false,
  source: "",
  options: [],
  excerpt: "",
  detectedAt: 0,
};

function defaultRuntimeState(): RuntimeState {
  return {
    buffer: "",
    choiceOverlay: hiddenOverlay,
    goalActivatedAt: null,
    lastAutoResumeAt: null,
    autoResumeCount: 0,
    lastInputAt: null,
    goalCheckOffset: 0,
    goalCheckEventSeq: 0,
    lastGuardPromptAt: null,
    lastGuardPromptText: "",
    lastCapturedPane: "",
    lastPaneSnapshot: "",
    goalCheckPaneSnapshot: "",
    lastViewerActivityAt: null,
  };
}

function summarizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-300);
}

function normalizeTerminalTextForGoalMatch(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\r/g, "\n");
}

function compactNormalizedTerminalText(value: string): string {
  return normalizeTerminalTextForGoalMatch(value).replace(/\s+/g, " ").trim();
}

function tailNonEmptyLines(value: string, limit: number): string[] {
  return normalizeTerminalTextForGoalMatch(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit);
}

function getPrimarySuccessMarker(goalConfig: GoalGuardConfig | null | undefined): string | null {
  const firstKeyword = goalConfig?.successKeywords.find((keyword) => keyword.trim().length > 0) ?? null;
  return firstKeyword ? normalizeTerminalTextForGoalMatch(firstKeyword).trim() || null : null;
}

function buildDefaultResumePromptTemplate(goalConfig: GoalGuardConfig | null | undefined): string {
  return `继续执行既定目标，未完成前不要停止。完成后必须输出 ${getPrimarySuccessMarker(goalConfig) ?? "SUCCESS"}。`;
}

function hasStandaloneSuccessMarker(value: string, goalConfig: GoalGuardConfig | null | undefined): boolean {
  const marker = getPrimarySuccessMarker(goalConfig);
  if (!marker) {
    return false;
  }
  const tailLines = tailNonEmptyLines(value, 8);
  return tailLines.some((line) => line === marker);
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
  const normalized = normalizeTerminalTextForGoalMatch(value);
  return incompleteSignalPatterns.filter((entry) => entry.pattern.test(normalized)).map((entry) => entry.label);
}

function hasIncompleteProgressSignal(value: string): boolean {
  return findIncompleteProgressSignals(value).length > 0;
}

function buildGuardPromptFragments(goalConfig: GoalGuardConfig): string[] {
  return [
    flattenPromptLine(goalConfig.goalText) ? `当前目标：${flattenPromptLine(goalConfig.goalText)}` : "",
    flattenPromptLine(goalConfig.resumePromptTemplate || buildDefaultResumePromptTemplate(goalConfig)),
  ].filter(Boolean);
}

function sanitizeGoalWindowForEvaluation(goalWindow: string, goalConfig: GoalGuardConfig): string {
  const normalized = normalizeTerminalTextForGoalMatch(goalWindow);
  const fragments = buildGuardPromptFragments(goalConfig).map((fragment) => normalizeTerminalTextForGoalMatch(fragment).trim());
  if (fragments.length === 0) {
    return normalized;
  }
  return normalized
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      return !fragments.some((fragment) => fragment && trimmed.includes(fragment));
    })
    .join("\n");
}

function getGoalMatchDiagnostics(goalWindow: string, goalConfig: GoalGuardConfig): GoalMatchDiagnostics {
  const sanitizedGoalWindow = sanitizeGoalWindowForEvaluation(goalWindow, goalConfig);
  const normalizedGoalWindow = normalizeTerminalTextForGoalMatch(sanitizedGoalWindow);
  return {
    matchedSuccessKeyword:
      goalConfig.successKeywords.find((keyword) =>
        normalizedGoalWindow.toLowerCase().includes(normalizeTerminalTextForGoalMatch(keyword).toLowerCase()),
      ) ?? null,
    matchedStandaloneSuccess: hasStandaloneSuccessMarker(sanitizedGoalWindow, goalConfig),
    matchedIncompleteSignals: findIncompleteProgressSignals(sanitizedGoalWindow),
    evidenceEventSeq: null,
    sanitizedGoalWindow,
  };
}

function stripGuardPromptEchoFromText(value: string, goalConfig: GoalGuardConfig, recentPromptText: string): string {
  const fragments = [
    ...buildGuardPromptFragments(goalConfig),
    recentPromptText.trim(),
  ].filter(Boolean);
  if (fragments.length === 0) {
    return value;
  }
  let stripped = value;
  for (const fragment of fragments) {
    if (!fragment) {
      continue;
    }
    stripped = stripped.split(fragment).join("");
  }
  return stripped;
}

function getGoalMatchDiagnosticsFromEvents(
  events: GuardEventRecord[],
  goalConfig: GoalGuardConfig,
  recentPromptText: string,
): GoalMatchDiagnostics {
  const terminalEvents = events.filter((event) => event.source === "terminal_output");
  const sanitizedEvents = terminalEvents.map((event) => ({
    ...event,
    text: stripGuardPromptEchoFromText(event.text, goalConfig, recentPromptText),
  }));
  const joinedOutput = sanitizedEvents.map((event) => event.text).join("\n");
  const baseDiagnostics = getGoalMatchDiagnostics(joinedOutput, goalConfig);
  const matchedEvent = sanitizedEvents.find((event) => {
    const diagnostics = getGoalMatchDiagnostics(event.text, goalConfig);
    return diagnostics.matchedStandaloneSuccess || diagnostics.matchedSuccessKeyword !== null;
  });
  return {
    ...baseDiagnostics,
    evidenceEventSeq: matchedEvent?.seq ?? null,
  };
}

function toTerminalGoalCandidateDiagnostics(value: GoalMatchDiagnostics): TerminalGoalCandidateDiagnostics {
  return {
    matchedSuccessKeyword: value.matchedSuccessKeyword,
    matchedStandaloneSuccess: value.matchedStandaloneSuccess,
    matchedIncompleteSignals: value.matchedIncompleteSignals,
    evidenceEventSeq: value.evidenceEventSeq,
  };
}

function resolveProgressSignal(
  codexObservation: CodexObservation,
  allowTerminalSignals: boolean,
  terminalDiagnostics: TerminalGoalCandidateDiagnostics,
): GoalGuardProgressSignal {
  if (codexObservation.available && codexObservation.lastEventAt !== null) {
    return "structured_codex";
  }
  if (
    allowTerminalSignals
    && (
      terminalDiagnostics.matchedStandaloneSuccess
      || terminalDiagnostics.matchedSuccessKeyword !== null
      || terminalDiagnostics.matchedIncompleteSignals.length > 0
    )
  ) {
    return "terminal_fallback";
  }
  return "none";
}

function resolveStructuredFactSource(
  session: ManagedSessionRecord,
  codexObservation: CodexObservation,
  notificationSummary: AppServerNotificationSummary,
): GoalGuardStructuredFactSource {
  if (!codexObservation.available) {
    return "none";
  }
  if (session.executionChannel === "app_server_remote_tui") {
    return notificationSummary.cachedCount > 0
      ? "app_server_notification_cache"
      : "app_server_thread_read";
  }
  return "rollout_observer";
}

function buildAppServerDebugSummary(
  codexObservation: CodexObservation,
  notificationManager: AppServerNotificationManagerSummary,
  notificationCache: AppServerNotificationSummary,
  threadManager: AppServerThreadManagerSummary,
): AppServerDebugSummary {
  const enabled =
    notificationManager.active
    || threadManager.tracked
    || notificationCache.threadId !== null
    || codexObservation.matchedSessionId !== null;
  const healthStatus: AppServerDebugSummary["healthStatus"] =
    !enabled
      ? "disabled"
      : codexObservation.fatalError
        ? "fatal_error"
        : notificationManager.active && !notificationManager.connected
          ? "notification_disconnected"
          : threadManager.tracked && !threadManager.hasSnapshot
            ? "waiting_snapshot"
            : "healthy";
  const healthLabel =
    healthStatus === "disabled"
      ? "未启用"
      : healthStatus === "fatal_error"
        ? "存在结构化错误"
        : healthStatus === "notification_disconnected"
          ? "后台通知未连接"
          : healthStatus === "waiting_snapshot"
            ? "等待 thread snapshot"
            : "结构化链路正常";
  return {
    enabled,
    matchedThreadId: codexObservation.matchedSessionId,
    finalTurnState: codexObservation.turnState,
    finalTurnStateSource: codexObservation.appServerTurnStateSource,
    fatalError: codexObservation.fatalError,
    healthStatus,
    healthLabel,
    notificationManager,
    notificationCache,
    threadManager,
  };
}

function splitPaneLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n");
}

function extractIncrementalPaneDelta(previousPane: string, currentPane: string): string {
  if (!currentPane.trim()) {
    return "";
  }
  if (!previousPane.trim()) {
    return currentPane;
  }
  if (currentPane === previousPane) {
    return "";
  }

  const previousLines = splitPaneLines(previousPane);
  const currentLines = splitPaneLines(currentPane);
  const maxOverlap = Math.min(previousLines.length, currentLines.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matched = true;
    for (let index = 0; index < overlap; index += 1) {
      if (previousLines[previousLines.length - overlap + index] !== currentLines[index]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const delta = currentLines.slice(overlap).join("\n");
      return delta.trim() ? `${delta}${currentPane.endsWith("\n") ? "\n" : ""}` : "";
    }
  }

  if (currentPane.includes(previousPane)) {
    return currentPane.slice(currentPane.indexOf(previousPane) + previousPane.length);
  }

  return currentPane;
}

function appendIncrementalOutput(existing: string, delta: string): string {
  if (!delta) {
    return existing.slice(-30000);
  }
  if (!existing) {
    return delta.slice(-30000);
  }
  if (existing.endsWith(delta)) {
    return existing.slice(-30000);
  }

  const maxOverlap = Math.min(existing.length, delta.length, 4000);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === delta.slice(0, overlap)) {
      return `${existing}${delta.slice(overlap)}`.slice(-30000);
    }
  }

  return `${existing}${delta}`.slice(-30000);
}

function normalizeGuardEventText(value: string): string {
  return normalizeTerminalTextForGoalMatch(value).replace(/\s+/g, " ").trim().slice(-600);
}

function hasMeaningfulTerminalDelta(value: string): boolean {
  return normalizeGuardEventText(value).length > 0;
}

function isLikelyGuardEcho(promptText: string, outputText: string): boolean {
  const normalizedPrompt = normalizeGuardEventText(promptText);
  const normalizedOutput = normalizeGuardEventText(outputText);
  if (!normalizedPrompt || !normalizedOutput) {
    return false;
  }
  if (normalizedOutput.includes(normalizedPrompt) || normalizedPrompt.includes(normalizedOutput)) {
    return true;
  }
  const promptTokens = normalizedPrompt.split(" ").filter(Boolean);
  const hitCount = promptTokens.filter((token) => normalizedOutput.includes(token)).length;
  return promptTokens.length > 0 && hitCount / promptTokens.length >= 0.7;
}

function buildPaneSnapshot(value: string): string {
  return compactNormalizedTerminalText(value).slice(-4000);
}

function hasNewOutputSinceGoalCheckpoint(runtime: RuntimeState): boolean {
  if (
    runtime.goalActivatedAt !== null &&
    Date.now() - runtime.goalActivatedAt < SessionManager.goalActivationSettleMs
  ) {
    return false;
  }
  if (!runtime.goalCheckPaneSnapshot) {
    return runtime.buffer.length > Math.max(0, runtime.goalCheckOffset);
  }
  return runtime.lastPaneSnapshot !== runtime.goalCheckPaneSnapshot;
}

function flattenPromptLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(submitDelayArray, 0, 0, ms);
}

function shouldFreezeGuardDecisionState(decisionState: GuardDecisionState): boolean {
  return decisionState === "satisfied"
    || decisionState === "manually_overridden"
    || decisionState === "blocked_by_fatal_error"
    || decisionState === "blocked_by_missing_verifier";
}

function nextEnabledGuardDecisionState(current: GuardDecisionState): GuardDecisionState {
  if (shouldFreezeGuardDecisionState(current)) {
    return current;
  }
  return "waiting_for_idle";
}

function buildGoalSpec(goalConfig: GoalGuardConfig): GoalSpec {
  return {
    kind: "terminal_signal",
    goalText: goalConfig.goalText,
    successKeywords: [...goalConfig.successKeywords],
  };
}

function buildVerificationSpec(goalConfig: GoalGuardConfig): VerificationSpec {
  const raw = goalConfig.successCommand?.trim() || null;
  const structured = raw ? parseStructuredVerifier(raw) : null;
  return {
    kind: structured?.kind ?? (raw ? "command_check" : "candidate_signal"),
    raw,
    command: structured ? null : raw,
    required: true,
    strict: Boolean(raw),
  };
}

function parseStructuredVerifier(value: string): ParsedStructuredVerifier | null {
  if (value.startsWith("file_exists:")) {
    const targetPath = value.slice("file_exists:".length).trim();
    if (!targetPath) {
      return null;
    }
    return {
      kind: "file_exists",
      path: targetPath,
    };
  }

  if (value.startsWith("file_contains:")) {
    const payload = value.slice("file_contains:".length);
    const separator = payload.indexOf("::");
    if (separator <= 0) {
      return null;
    }
    const targetPath = payload.slice(0, separator).trim();
    const containsText = payload.slice(separator + 2);
    if (!targetPath || !containsText) {
      return null;
    }
    return {
      kind: "file_contains",
      path: targetPath,
      containsText,
    };
  }

  if (value.startsWith("json_equals:")) {
    const payload = value.slice("json_equals:".length);
    const parts = payload.split("::");
    if (parts.length !== 3) {
      return null;
    }
    const [targetPath, jsonPath, expectedRaw] = parts.map((item) => item.trim());
    if (!targetPath || !jsonPath || !expectedRaw) {
      return null;
    }
    try {
      return {
        kind: "json_field_equals",
        path: targetPath,
        jsonPath,
        expectedValue: JSON.parse(expectedRaw),
      };
    } catch {
      return null;
    }
  }

  return null;
}

function readJsonPathValue(input: unknown, dotPath: string): unknown {
  const segments = dotPath.split(".").map((item) => item.trim()).filter(Boolean);
  let current: unknown = input;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const terminalFatalStopPatterns = [
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

export function detectTerminalFatalStopSignal(text: string): string | null {
  for (const pattern of terminalFatalStopPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

export class SessionManager extends EventEmitter {
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly codexObserver = new CodexObserver();
  private readonly codexAppServerObserver = new CodexAppServerObserver();
  private static readonly viewportNoiseSuppressionMs = 2500;
  static readonly goalActivationSettleMs = 7000;

  constructor(private readonly repository: SessionRepository) {
    super();
    this.restorePersistedRuntime();
    this.syncPersistedStatuses();
  }

  private restorePersistedRuntime(): void {
    for (const runtime of this.repository.listRuntimeStates()) {
      this.runtime.set(runtime.sessionId, {
        buffer: runtime.buffer,
        choiceOverlay: runtime.choiceOverlay,
        goalActivatedAt: runtime.goalActivatedAt,
        lastAutoResumeAt: runtime.lastAutoResumeAt,
        autoResumeCount: runtime.autoResumeCount,
        lastInputAt: null,
        goalCheckOffset: runtime.goalCheckOffset,
        goalCheckEventSeq: runtime.goalCheckEventSeq,
        lastGuardPromptAt: runtime.lastGuardPromptAt,
        lastGuardPromptText: runtime.lastGuardPromptText,
        lastCapturedPane: runtime.lastCapturedPane,
        lastPaneSnapshot: runtime.lastPaneSnapshot,
        goalCheckPaneSnapshot: runtime.goalCheckPaneSnapshot,
        lastViewerActivityAt: null,
      });
    }
  }

  private syncPersistedStatuses(): void {
    for (const session of this.repository.listSessions()) {
      const hasTmuxSession = this.hasTmuxSession(session.tmuxSessionName);
      const nextStatus: SessionStatus = hasTmuxSession ? "running" : "closed";
      const nextGuardDecisionState = shouldFreezeGuardDecisionState(session.guardDecisionState)
        ? session.guardDecisionState
        : hasTmuxSession
          ? session.goalConfig.enabled
            ? "waiting_for_idle"
            : "disabled"
          : "manually_overridden";
      this.repository.updateSession(session.id, {
        status: nextStatus,
        guardDecisionState: nextGuardDecisionState,
        guardDecisionReason: hasTmuxSession ? null : "tmux 会话不存在，已标记为手动终止态。",
      });
      if (hasTmuxSession) {
        this.refreshRuntimeFromTmux(session);
      }
    }
  }

  private getRuntime(sessionId: string): RuntimeState {
    if (!this.runtime.has(sessionId)) {
      const persisted = this.repository.getRuntimeState(sessionId);
      const fallback = defaultRuntimeState();
      this.runtime.set(sessionId, {
        buffer: persisted?.buffer ?? fallback.buffer,
        choiceOverlay: persisted?.choiceOverlay ?? fallback.choiceOverlay,
        goalActivatedAt: persisted?.goalActivatedAt ?? fallback.goalActivatedAt,
        lastAutoResumeAt: persisted?.lastAutoResumeAt ?? fallback.lastAutoResumeAt,
        autoResumeCount: persisted?.autoResumeCount ?? fallback.autoResumeCount,
        lastInputAt: null,
        goalCheckOffset: persisted?.goalCheckOffset ?? fallback.goalCheckOffset,
        goalCheckEventSeq: persisted?.goalCheckEventSeq ?? fallback.goalCheckEventSeq,
        lastGuardPromptAt: persisted?.lastGuardPromptAt ?? fallback.lastGuardPromptAt,
        lastGuardPromptText: persisted?.lastGuardPromptText ?? fallback.lastGuardPromptText,
        lastCapturedPane: persisted?.lastCapturedPane ?? fallback.lastCapturedPane,
        lastPaneSnapshot: persisted?.lastPaneSnapshot ?? fallback.lastPaneSnapshot,
        goalCheckPaneSnapshot: persisted?.goalCheckPaneSnapshot ?? fallback.goalCheckPaneSnapshot,
        lastViewerActivityAt: null,
      });
    }
    return this.runtime.get(sessionId)!;
  }

  private persistRuntime(sessionId: string): void {
    const runtime = this.getRuntime(sessionId);
    this.repository.updateRuntimeState(sessionId, {
      buffer: runtime.buffer,
      choiceOverlay: runtime.choiceOverlay,
      goalActivatedAt: runtime.goalActivatedAt,
      lastAutoResumeAt: runtime.lastAutoResumeAt,
      autoResumeCount: runtime.autoResumeCount,
      goalCheckOffset: runtime.goalCheckOffset,
      goalCheckEventSeq: runtime.goalCheckEventSeq,
      lastGuardPromptAt: runtime.lastGuardPromptAt,
      lastGuardPromptText: runtime.lastGuardPromptText,
      lastCapturedPane: runtime.lastCapturedPane,
      lastPaneSnapshot: runtime.lastPaneSnapshot,
      goalCheckPaneSnapshot: runtime.goalCheckPaneSnapshot,
    });
  }

  private emitSession(sessionId: string): void {
    const summary = this.getSessionSummary(sessionId);
    if (summary) {
      this.emit("session-updated", summary);
    }
  }

  private appendGuardEvent(
    sessionId: string,
    source: "terminal_output" | "user_input" | "guard_prompt" | "guard_echo",
    text: string,
  ): void {
    const normalizedText = normalizeGuardEventText(text);
    if (!normalizedText) {
      return;
    }
    this.repository.appendGuardEvent(sessionId, source, text.slice(-4000), normalizedText);
  }

  private isLikelyGuardEchoEvent(runtime: RuntimeState, text: string): boolean {
    if (
      runtime.lastGuardPromptAt !== null &&
      Date.now() - runtime.lastGuardPromptAt <= guardEchoWindowMs &&
      runtime.lastGuardPromptText &&
      isLikelyGuardEcho(runtime.lastGuardPromptText, text)
    ) {
      return true;
    }
    return false;
  }

  private resolveSessionCwd(session: ManagedSessionRecord): string {
    return path.isAbsolute(session.cwd) ? session.cwd : normalizeInsideRoot(session.workspaceRoot, session.cwd);
  }

  private createTaskRunId(): string {
    return `guardrun_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  }

  private buildVerificationReceipt(
    session: ManagedSessionRecord,
    verificationSpec: VerificationSpec,
    candidate: GoalVerificationCandidate,
    passed: boolean,
    detail: string,
    exitCode: number | null,
  ): VerificationReceipt {
    return {
      schema: "touchmux.goal_guard.result.v1",
      taskRunId: session.currentTaskRunId ?? this.createTaskRunId(),
      sessionId: session.id,
      status: passed ? "success" : "failed",
      verificationKind: verificationSpec.kind,
      passed,
      detail,
      exitCode,
      evidenceEventSeq: candidate.eventSeq,
      createdAt: Date.now(),
    };
  }

  private verifyGoalCandidate(session: ManagedSessionRecord, candidate: GoalVerificationCandidate): {
    passed: boolean;
    receipt: VerificationReceipt;
    successEvidence: SuccessEvidence | null;
    previewText: string;
  } {
    const verificationSpec = session.verificationSpec ?? buildVerificationSpec(session.goalConfig);
    const structured = verificationSpec.raw ? parseStructuredVerifier(verificationSpec.raw) : null;

    if (structured?.kind === "file_exists" && structured.path) {
      const targetPath = path.isAbsolute(structured.path)
        ? structured.path
        : path.join(this.resolveSessionCwd(session), structured.path);
      const passed = fs.existsSync(targetPath);
      const detail = passed
        ? `文件存在校验通过：${structured.path}，taskRunId=${session.currentTaskRunId ?? "unknown"}。`
        : `文件存在校验未通过：${structured.path}，taskRunId=${session.currentTaskRunId ?? "unknown"}。`;
      const receipt = this.buildVerificationReceipt(session, verificationSpec, candidate, passed, detail, passed ? 0 : 1);
      return {
        passed,
        receipt,
        successEvidence: passed
          ? {
              kind: "command_check",
              eventSeq: candidate.eventSeq,
              confirmedAt: receipt.createdAt,
              detail,
            }
          : null,
        previewText: summarizeTerminalText([session.lastOutputPreview, detail].filter(Boolean).join(" ")),
      };
    }

    if (structured?.kind === "file_contains" && structured.path && structured.containsText) {
      const targetPath = path.isAbsolute(structured.path)
        ? structured.path
        : path.join(this.resolveSessionCwd(session), structured.path);
      const content = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
      const passed = content.includes(structured.containsText);
      const detail = passed
        ? `文件包含校验通过：${structured.path}，taskRunId=${session.currentTaskRunId ?? "unknown"}。`
        : `文件包含校验未通过：${structured.path}，taskRunId=${session.currentTaskRunId ?? "unknown"}。`;
      const receipt = this.buildVerificationReceipt(session, verificationSpec, candidate, passed, detail, passed ? 0 : 1);
      return {
        passed,
        receipt,
        successEvidence: passed
          ? {
              kind: "command_check",
              eventSeq: candidate.eventSeq,
              confirmedAt: receipt.createdAt,
              detail,
            }
          : null,
        previewText: summarizeTerminalText([session.lastOutputPreview, detail].filter(Boolean).join(" ")),
      };
    }

    if (structured?.kind === "json_field_equals" && structured.path && structured.jsonPath) {
      const targetPath = path.isAbsolute(structured.path)
        ? structured.path
        : path.join(this.resolveSessionCwd(session), structured.path);
      let parsedJson: unknown = null;
      try {
        parsedJson = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      } catch {
        parsedJson = null;
      }
      const actualValue = parsedJson === null ? undefined : readJsonPathValue(parsedJson, structured.jsonPath);
      const passed = JSON.stringify(actualValue) === JSON.stringify(structured.expectedValue);
      const detail = passed
        ? `JSON 字段校验通过：${structured.path}#${structured.jsonPath}，taskRunId=${session.currentTaskRunId ?? "unknown"}。`
        : `JSON 字段校验未通过：${structured.path}#${structured.jsonPath}，taskRunId=${session.currentTaskRunId ?? "unknown"}。`;
      const receipt = this.buildVerificationReceipt(session, verificationSpec, candidate, passed, detail, passed ? 0 : 1);
      return {
        passed,
        receipt,
        successEvidence: passed
          ? {
              kind: "command_check",
              eventSeq: candidate.eventSeq,
              confirmedAt: receipt.createdAt,
              detail,
            }
          : null,
        previewText: summarizeTerminalText([session.lastOutputPreview, detail].filter(Boolean).join(" ")),
      };
    }

    if (verificationSpec.kind === "command_check" && verificationSpec.command) {
      const result = spawnSync(config.shell, ["-lc", verificationSpec.command], {
        cwd: this.resolveSessionCwd(session),
        stdio: "pipe",
        encoding: "utf8",
      });
      const passed = result.status === 0;
      const detail = passed
        ? `命令校验通过，taskRunId=${session.currentTaskRunId ?? "unknown"}。`
        : `命令校验未通过，taskRunId=${session.currentTaskRunId ?? "unknown"}，exit=${result.status ?? "null"}。`;
      const receipt = this.buildVerificationReceipt(
        session,
        verificationSpec,
        candidate,
        passed,
        detail,
        result.status ?? null,
      );
      return {
        passed,
        receipt,
        successEvidence: passed
          ? {
              kind: "command_check",
              eventSeq: candidate.eventSeq,
              confirmedAt: receipt.createdAt,
              detail,
            }
          : null,
        previewText: summarizeTerminalText([session.lastOutputPreview, result.stdout, result.stderr].filter(Boolean).join(" ")),
      };
    }

    if (!verificationSpec.strict) {
      const detail = `检测到候选完成信号，但当前 taskRunId=${session.currentTaskRunId ?? "unknown"} 未配置严格 verifier，拒绝自动确认成功。`;
      const receipt = this.buildVerificationReceipt(session, verificationSpec, candidate, false, detail, null);
      return {
        passed: false,
        receipt,
        successEvidence: null,
        previewText: session.lastOutputPreview,
      };
    }

    const detail = `${candidate.detail} 当前 taskRunId=${session.currentTaskRunId ?? "unknown"}。`;
    const receipt = this.buildVerificationReceipt(session, verificationSpec, candidate, true, detail, null);
    return {
      passed: true,
      receipt,
      successEvidence: {
        kind: candidate.kind,
        eventSeq: candidate.eventSeq,
        confirmedAt: receipt.createdAt,
        detail,
      },
      previewText: session.lastOutputPreview,
    };
  }

  private relativeSessionCwd(session: ManagedSessionRecord): string {
    if (!path.isAbsolute(session.cwd)) {
      return session.cwd || ".";
    }
    return path.relative(session.workspaceRoot, session.cwd) || ".";
  }

  private buildCodexCommand(input: CreateSessionInput): string {
    const baseArgs = [...config.codexArgs];
    const envPrefix = [
      "env",
      `HOME=${config.runtimeHome}`,
      `TOUCHMUX_SESSION_HOME=${config.sessionHome}`,
      `CODEX_HOME=${config.codexHomeDir}`,
      ...(process.env.PATH ? [`PATH=${process.env.PATH}`] : []),
    ];
    if (input.mode === "new") {
      const args = [...envPrefix, config.codexExecutable, ...baseArgs];
      if (input.prompt?.trim()) {
        args.push(input.prompt.trim());
      }
      return quoteArgs(args);
    }

    if (!input.sourceCodexSessionId) {
      throw new Error("恢复或 fork 会话必须提供源 Codex session id");
    }

    const subcommand = input.mode === "resume" ? "resume" : "fork";
    const args = [...envPrefix, config.codexExecutable, subcommand, input.sourceCodexSessionId, ...baseArgs];
    if (input.prompt?.trim()) {
      args.push(input.prompt.trim());
    }
    return quoteArgs(args);
  }

  private ensureCwd(input: CreateSessionInput): string {
    const normalized = normalizeInsideRoot(input.workspaceRoot, input.cwd);
    if (!normalized.startsWith(path.resolve(input.workspaceRoot))) {
      throw new Error("工作目录超出允许范围");
    }
    return normalized;
  }

  private runTmux(args: string[]): void {
    const result = spawnSync("tmux", args, { stdio: "pipe", encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || "tmux 执行失败");
    }
  }

  private sendLiteral(sessionName: string, text: string, appendEnter = false): void {
    this.runTmux(["send-keys", "-t", sessionName, "-l", text]);
    if (appendEnter) {
      // Codex TUI may keep freshly pasted text inside the composer if Enter lands
      // in the same instant. A short delay makes the submit reliable.
      sleepSync(tmuxLiteralSubmitDelayMs);
      this.runTmux(["send-keys", "-t", sessionName, "Enter"]);
    }
  }

  private captureTmuxPane(sessionName: string): string | null {
    const result = spawnSync("tmux", ["capture-pane", "-p", "-t", sessionName, "-S", "-200"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0) {
      return null;
    }
    return result.stdout;
  }

  private refreshRuntimeFromTmux(
    session: ManagedSessionRecord,
  ): { session: ManagedSessionRecord; changed: boolean } {
    const captured = this.captureTmuxPane(session.tmuxSessionName);
    if (!captured) {
      return { session, changed: false };
    }
    const runtime = this.getRuntime(session.id);
    const previousBuffer = runtime.buffer;
    const previousCapturedPane = runtime.lastCapturedPane;
    const nextPaneSnapshot = buildPaneSnapshot(captured);
    const paneChanged = nextPaneSnapshot !== runtime.lastPaneSnapshot;
    const suppressViewportNoise =
      paneChanged &&
      runtime.lastViewerActivityAt !== null &&
      Date.now() - runtime.lastViewerActivityAt < SessionManager.viewportNoiseSuppressionMs;
    const paneDelta = extractIncrementalPaneDelta(previousCapturedPane, captured);
    const likelyGuardEcho = paneDelta ? this.isLikelyGuardEchoEvent(runtime, paneDelta) : false;
    const meaningfulTerminalDelta = paneDelta && !likelyGuardEcho && hasMeaningfulTerminalDelta(paneDelta);
    if (paneDelta) {
      runtime.buffer = appendIncrementalOutput(runtime.buffer, paneDelta);
      this.appendGuardEvent(session.id, "terminal_output", paneDelta);
      if (likelyGuardEcho) {
        this.appendGuardEvent(session.id, "guard_echo", paneDelta);
      }
    }
    runtime.lastCapturedPane = captured;
    runtime.lastPaneSnapshot = nextPaneSnapshot;
    runtime.choiceOverlay = detectChoiceOverlay(runtime.buffer);
    this.persistRuntime(session.id);
    const nextPreview = summarizeTerminalText(runtime.buffer);
    const changes: Partial<
      Pick<
        ManagedSessionRecord,
        "status" | "lastOutputAt" | "lastOutputPreview" | "guardDecisionState" | "guardDecisionReason"
      >
    > & { updatedAt?: number } = {};
    const bufferChanged = runtime.buffer !== previousBuffer;
    if (meaningfulTerminalDelta && !suppressViewportNoise) {
      changes.lastOutputAt = Date.now();
      changes.status = "running";
      if (session.goalConfig.enabled && !shouldFreezeGuardDecisionState(session.guardDecisionState)) {
        const outputReduction = reduceGoalGuardOutputActivity(
          hasNewOutputSinceGoalCheckpoint(runtime),
          "terminal_fallback",
        );
        changes.guardDecisionState = outputReduction.nextState;
        changes.guardDecisionReason = outputReduction.reason;
      }
    }
    if (nextPreview && nextPreview !== session.lastOutputPreview) {
      changes.lastOutputPreview = nextPreview;
      if (!bufferChanged) {
        changes.updatedAt = session.updatedAt;
      }
    }
    if (Object.keys(changes).length === 0) {
      return { session, changed: false };
    }
    return {
      session: this.repository.updateSession(session.id, changes),
      changed: true,
    };
  }

  createSession(input: CreateSessionInput): SessionSummary {
    const absoluteCwd = this.ensureCwd(input);
    const relativeCwd = path.relative(input.workspaceRoot, absoluteCwd) || ".";
    const command = this.buildCodexCommand({ ...input, cwd: absoluteCwd });
    const sessionId = crypto.randomUUID();
    const tmuxSessionName = `touchmux_${sessionId.slice(0, 8)}`;

    this.runTmux([
      "new-session",
      "-d",
      "-s",
      tmuxSessionName,
      "-c",
      absoluteCwd,
      "-e",
      `HOME=${config.runtimeHome}`,
      "-e",
      `TOUCHMUX_SESSION_HOME=${config.sessionHome}`,
      "-e",
      `CODEX_HOME=${config.codexHomeDir}`,
      ...(process.env.PATH ? ["-e", `PATH=${process.env.PATH}`] : []),
    ]);
    this.sendLiteral(tmuxSessionName, command, true);

    const created = this.repository.createSession({
      id: sessionId,
      nodeId: config.localNode.id,
      title: input.title.trim() || `会话 ${sessionId.slice(0, 6)}`,
      mode: input.mode,
      executionChannel: "tmux_local_tui",
      status: "running",
      cwd: relativeCwd,
      workspaceRoot: input.workspaceRoot,
      tmuxSessionName,
      sourceCodexSessionId: input.sourceCodexSessionId ?? null,
      prompt: input.prompt?.trim() || null,
      command,
      goalConfig: {
        enabled: false,
        idleTimeoutSec: config.defaultIdleTimeoutSec,
      },
    });
    this.getRuntime(created.id);
    this.persistRuntime(created.id);
    this.repository.logAudit("session.created", created, created.id);
    this.emitSession(created.id);
    return this.toSummary(created);
  }

  listSessionSummaries(): SessionSummary[] {
    return this.repository.listSessions().map((session) => this.toSummary(session));
  }

  getSessionSummary(sessionId: string): SessionSummary | null {
    const record = this.repository.getSession(sessionId);
    return record ? this.toSummary(record) : null;
  }

  private toSummary(record: ManagedSessionRecord): SessionSummary {
    const runtime = this.getRuntime(record.id);
    return {
      ...record,
      nodeLabel: config.localNode.label,
      cwd: this.relativeSessionCwd(record),
      hasTmuxSession: this.hasTmuxSession(record.tmuxSessionName),
      choiceOverlay: runtime.choiceOverlay,
    };
  }

  hasTmuxSession(sessionName: string): boolean {
    const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return result.status === 0;
  }

  syncSessionFromTmux(sessionId: string, emitUpdate = false): SessionSummary | null {
    const session = this.repository.getSession(sessionId);
    if (!session || !this.hasTmuxSession(session.tmuxSessionName)) {
      return session ? this.toSummary(session) : null;
    }
    const refreshed = this.refreshRuntimeFromTmux(session);
    if (emitUpdate && refreshed.changed) {
      this.emitSession(sessionId);
    }
    return this.toSummary(refreshed.session);
  }

  attachToSession(
    sessionId: string,
    cols: number,
    rows: number,
    onData: (chunk: string) => void,
    onExit: () => void,
  ): IPty {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    if (!this.hasTmuxSession(session.tmuxSessionName)) {
      throw new Error("tmux 会话不存在，无法附着");
    }
    this.refreshRuntimeFromTmux(session);
    this.getRuntime(sessionId).lastViewerActivityAt = Date.now();
    const pty = spawn("tmux", ["attach-session", "-t", session.tmuxSessionName], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.resolveSessionCwd(session),
      env: {
        ...process.env,
        HOME: config.runtimeHome,
        TOUCHMUX_SESSION_HOME: config.sessionHome,
        CODEX_HOME: config.codexHomeDir,
        TERM: "xterm-256color",
      },
    });
    const attachStartedAt = Date.now();
    pty.onData((chunk) => {
      const normalizedChunk = compactNormalizedTerminalText(chunk);
      const normalizedBuffer = compactNormalizedTerminalText(this.getRecentOutput(sessionId));
      const isInitialReplay =
        Date.now() - attachStartedAt < 1200 &&
        normalizedChunk.length > 0 &&
        normalizedBuffer.length > 0 &&
        normalizedBuffer.includes(normalizedChunk);
      if (!isInitialReplay) {
        this.recordOutput(sessionId, chunk);
      }
      onData(chunk);
    });
    pty.onExit(() => {
      onExit();
    });
    return pty;
  }

  recordOutput(sessionId: string, chunk: string): void {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      return;
    }
    if (this.hasTmuxSession(session.tmuxSessionName)) {
      const refreshed = this.refreshRuntimeFromTmux(session);
      if (refreshed.changed) {
        this.emit("session-updated", this.toSummary(refreshed.session));
      }
      return;
    }
    const runtime = this.getRuntime(sessionId);
    runtime.buffer = `${runtime.buffer}${chunk}`.slice(-30000);
    this.appendGuardEvent(sessionId, "terminal_output", chunk);
    if (this.isLikelyGuardEchoEvent(runtime, chunk)) {
      this.appendGuardEvent(sessionId, "guard_echo", chunk);
    }
    runtime.lastPaneSnapshot = buildPaneSnapshot(runtime.buffer);
    runtime.choiceOverlay = detectChoiceOverlay(runtime.buffer);
    this.persistRuntime(sessionId);
    const updated = this.repository.updateSession(sessionId, {
      status: "running",
      lastOutputAt: Date.now(),
      lastOutputPreview: summarizeTerminalText(runtime.buffer),
      guardDecisionState: shouldFreezeGuardDecisionState(session.guardDecisionState)
        ? session.guardDecisionState
        : session.goalConfig.enabled
          ? hasNewOutputSinceGoalCheckpoint(runtime)
            ? "observing_output"
            : "waiting_for_idle"
          : "disabled",
      guardDecisionReason: shouldFreezeGuardDecisionState(session.guardDecisionState)
        ? session.guardDecisionReason
        : session.goalConfig.enabled
          ? hasNewOutputSinceGoalCheckpoint(runtime)
            ? "守卫在 checkpoint 之后观测到新的终端输出。"
            : "守卫正在等待新的终端输出或空闲窗口。"
          : null,
    });
    this.emit("session-updated", this.toSummary(updated));
  }

  noteInputActivity(sessionId: string, inputText?: string): void {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      return;
    }
    const runtime = this.getRuntime(sessionId);
    runtime.lastInputAt = Date.now();
    if (typeof inputText === "string" && inputText.length > 0) {
      this.appendGuardEvent(sessionId, "user_input", inputText);
    }
  }

  getLastActivityAt(sessionId: string): number | null {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      return null;
    }
    const runtime = this.getRuntime(sessionId);
    return Math.max(
      session.lastOutputAt ?? 0,
      runtime.lastInputAt ?? 0,
      runtime.lastAutoResumeAt ?? 0,
      session.createdAt,
    );
  }

  getRecentOutput(sessionId: string): string {
    return this.getRuntime(sessionId).buffer;
  }

  async buildGoalGuardStateSnapshot(sessionId: string): Promise<GoalGuardStateSnapshot> {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const runtime = this.getRuntime(sessionId);
    const codexObservation = await this.inspectCodexSession(sessionId);
    const candidateEvents = this.repository.listGuardEventsSince(sessionId, runtime.goalCheckEventSeq, "terminal_output");
    const terminalDiagnostics = toTerminalGoalCandidateDiagnostics(
      getGoalMatchDiagnosticsFromEvents(candidateEvents, session.goalConfig, runtime.lastGuardPromptText),
    );
    const guardActivatedAt = runtime.goalActivatedAt ?? session.createdAt;
    const hasBootstrapped = runtime.autoResumeCount > 0;
    const terminalActivityAt = this.getLastActivityAt(sessionId) ?? session.createdAt;
    const structuredActivityAt = codexObservation.lastEventAt;
    const observedActivityAt = Math.max(terminalActivityAt, structuredActivityAt ?? 0, session.createdAt);
    const allowTerminalSignals = session.executionChannel === "tmux_local_tui";
    const appServerNotificationSummary = codexAppServerNotificationCache.getThreadSummary(codexObservation.matchedSessionId);
    const appServerNotificationManagerSummary = getCodexAppServerNotificationManagerSummary();
    const appServerThreadManagerSummary = codexAppServerThreadCache.getThreadManagerSummary(codexObservation.matchedSessionId);
    const appServerDebugSummary = buildAppServerDebugSummary(
      codexObservation,
      appServerNotificationManagerSummary,
      appServerNotificationSummary,
      appServerThreadManagerSummary,
    );
    return {
      session,
      codexObservation,
      terminalDiagnostics,
      hasKeywordRule: session.goalConfig.successKeywords.length > 0,
      verificationKind: session.verificationSpec?.kind ?? "candidate_signal",
      allowTerminalSignals,
      progressSignal: resolveProgressSignal(codexObservation, allowTerminalSignals, terminalDiagnostics),
      structuredFactSource: resolveStructuredFactSource(session, codexObservation, appServerNotificationSummary),
      appServerNotificationSummary,
      appServerNotificationManagerSummary,
      appServerDebugSummary,
      terminalActivityAt,
      structuredActivityAt,
      withinActivationSettleWindow: Date.now() - guardActivatedAt < SessionManager.goalActivationSettleMs,
      reachedFirstProbeDelay: Date.now() - guardActivatedAt >= goalGuardFirstProbeDelayMs,
      hasBootstrapped,
      hasRecentOutput: Date.now() - observedActivityAt < goalGuardRunningCooldownMs,
      idleTimedOut: Date.now() - observedActivityAt >= session.goalConfig.idleTimeoutSec * 1000,
      hasTmuxSession: this.hasTmuxSession(session.tmuxSessionName),
      observedActivityAt,
      appServerThreadManagerSummary,
    };
  }

  async inspectCodexSession(sessionId: string): Promise<CodexObservation> {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const runtime = this.getRuntime(sessionId);
    const inspectOptions = {
      sinceTimestamp: runtime.goalActivatedAt ?? session.createdAt,
      goalConfig: session.goalConfig,
    };
    const observation = await (session.executionChannel === "app_server_remote_tui"
      ? this.codexAppServerObserver.inspectSession(session, inspectOptions)
      : (() => {
          const rolloutObservation = this.codexObserver.inspectSession(session, inspectOptions);
          return rolloutObservation.available
            ? Promise.resolve(rolloutObservation)
            : this.codexAppServerObserver.inspectSession(session, inspectOptions);
        })());
    if (
      observation.available &&
      observation.matchedSessionId &&
      observation.matchedSessionId !== session.currentCodexSessionId
    ) {
      this.repository.updateSession(sessionId, {
        currentCodexSessionId: observation.matchedSessionId,
      });
    }
    return observation;
  }

  async probeAppServerBridge(sessionId: string): Promise<AppServerBridgeProbeResult> {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    if (session.executionChannel !== "tmux_local_tui") {
      throw new Error("当前只有 tmux_local_tui 会话支持 app-server bridge probe");
    }
    const cwd = this.resolveSessionCwd(session);
    const currentCodexSessionIdBefore = session.currentCodexSessionId;
    const client = new CodexAppServerProbeClient();
    try {
      await client.initialize({
        clientInfo: {
          name: "touchmux-bridge-probe",
          version: "0.1.0",
          title: "TouchMux Bridge Probe",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      const threadStart = await client.startThread({
        cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: true,
      });
      const threadRead = await client.readThread(threadStart.threadId);
      const currentCodexSessionIdAfter = this.repository.getSession(sessionId)?.currentCodexSessionId ?? null;
      return {
        sessionId,
        executionChannel: session.executionChannel,
        cwd,
        startedThreadId: threadStart.threadId,
        threadReadId: threadRead.threadId,
        threadReadCwd: threadRead.cwd,
        model: threadStart.model,
        currentCodexSessionIdBefore,
        currentCodexSessionIdAfter,
        currentCodexSessionIdUnchanged: currentCodexSessionIdBefore === currentCodexSessionIdAfter,
      };
    } finally {
      await client.disconnect();
    }
  }

  async getGoalDebugInfo(sessionId: string): Promise<GoalGuardDebugInfo | null> {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      return null;
    }
    if (this.hasTmuxSession(session.tmuxSessionName)) {
      this.refreshRuntimeFromTmux(session);
    }
    const refreshedSession = this.repository.getSession(sessionId);
    if (!refreshedSession) {
      return null;
    }
    const runtime = this.getRuntime(sessionId);
    const goalWindow = this.getGoalWindowOutput(sessionId);
    const diagnostics = getGoalMatchDiagnostics(goalWindow, refreshedSession.goalConfig);
    const snapshot = await this.buildGoalGuardStateSnapshot(sessionId);
    const codexObservation = snapshot.codexObservation;
    const baselineTailLines = tailNonEmptyLines(runtime.goalCheckPaneSnapshot, 16);
    const currentTailLines = tailNonEmptyLines(runtime.lastPaneSnapshot, 16);
    const goalWindowTailLines = tailNonEmptyLines(goalWindow, 24);
    const sanitizedGoalWindowTailLines = tailNonEmptyLines(diagnostics.sanitizedGoalWindow, 24);
    const maxLineCount = Math.max(baselineTailLines.length, currentTailLines.length);
    const changedTailLines = [];
    for (let index = 0; index < maxLineCount; index += 1) {
      const baseline = baselineTailLines[index] ?? "";
      const current = currentTailLines[index] ?? "";
      if (baseline !== current) {
        changedTailLines.push({
          line: index + 1,
          baseline,
          current,
        });
      }
    }
    return {
      sessionId,
      goalState: refreshedSession.goalState,
      guardDecisionState: refreshedSession.guardDecisionState,
      guardDecisionReason: refreshedSession.guardDecisionReason,
      currentTaskRunId: refreshedSession.currentTaskRunId,
      guardEnabled: refreshedSession.goalConfig.enabled,
      hasTmuxSession: this.hasTmuxSession(refreshedSession.tmuxSessionName),
      goalActivatedAt: runtime.goalActivatedAt,
      lastOutputAt: refreshedSession.lastOutputAt,
      structuredLastEventAt: snapshot.structuredActivityAt,
      observedActivityAt: snapshot.observedActivityAt,
      progressSignal: snapshot.progressSignal,
      structuredFactSource: snapshot.structuredFactSource,
      terminalSignalsAllowed: snapshot.allowTerminalSignals,
      appServerNotificationSummary: snapshot.appServerNotificationSummary,
      appServerNotificationManagerSummary: snapshot.appServerNotificationManagerSummary,
      appServerThreadManagerSummary: snapshot.appServerThreadManagerSummary,
      appServerDebugSummary: snapshot.appServerDebugSummary,
      lastAutoResumeAt: runtime.lastAutoResumeAt,
      lastViewerActivityAt: runtime.lastViewerActivityAt,
      autoResumeCount: runtime.autoResumeCount,
      baselineSnapshot: runtime.goalCheckPaneSnapshot,
      currentSnapshot: runtime.lastPaneSnapshot,
      snapshotChanged: runtime.lastPaneSnapshot !== runtime.goalCheckPaneSnapshot,
      baselineTailLines,
      currentTailLines,
      goalWindowTailLines,
      sanitizedGoalWindowTailLines,
      matchedSuccessKeyword: diagnostics.matchedSuccessKeyword,
      matchedStandaloneSuccess: diagnostics.matchedStandaloneSuccess,
      matchedIncompleteSignals: diagnostics.matchedIncompleteSignals,
      changedTailLines,
      goalSpec: refreshedSession.goalSpec,
      verificationSpec: refreshedSession.verificationSpec,
      verificationReceipt: refreshedSession.verificationReceipt,
      recentEvents: this.repository.listRecentGuardEvents(sessionId, 20),
      successEvidence: refreshedSession.successEvidence,
      codexObservation,
    };
  }

  reconcileGoalSatisfiedState(sessionId: string): SessionSummary | null {
    const session = this.repository.getSession(sessionId);
    if (!session || !session.goalConfig.enabled || session.guardDecisionState !== "satisfied") {
      return session ? this.toSummary(session) : null;
    }
    return this.toSummary(session);
  }

  detectFatalGuardStop(sessionId: string): string | null {
    const runtime = this.getRuntime(sessionId);
    const recentTerminalEvents = this.repository
      .listGuardEventsSince(sessionId, runtime.goalCheckEventSeq, "terminal_output")
      .map((event) => event.text)
      .join("\n")
      .slice(-6000);
    return detectTerminalFatalStopSignal(recentTerminalEvents);
  }

  async detectCodexFatalGuardStop(sessionId: string): Promise<string | null> {
    const observation = await this.inspectCodexSession(sessionId);
    return observation.fatalError;
  }

  markGuardObservingCodexTurn(sessionId: string, detail: string): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const updated = this.repository.updateSession(sessionId, {
      guardDecisionState: "observing_codex_turn",
      guardDecisionReason: detail,
    });
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  markGuardFailed(sessionId: string, reason: string): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const updated = this.repository.updateSession(sessionId, {
      status: session.status === "closed" ? "closed" : "running",
      guardDecisionState: "blocked_by_fatal_error",
      guardDecisionReason: reason,
      lastOutputPreview: summarizeTerminalText([session.lastOutputPreview, reason].filter(Boolean).join(" ")),
    });
    this.repository.logAudit("goal.failed_check", { reason }, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  markGuardWaiting(sessionId: string, reason?: string | null): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const updated = this.repository.updateSession(sessionId, {
      guardDecisionState: "waiting_for_idle",
      guardDecisionReason: reason ?? "守卫正在等待新的有效进展信号或下一个空闲窗口。",
    });
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  private getGoalWindowOutput(sessionId: string): string {
    const runtime = this.getRuntime(sessionId);
    return runtime.buffer.slice(Math.max(0, runtime.goalCheckOffset));
  }

  resizeTerminal(sessionId: string, ptyProcess: IPty, cols: number, rows: number): void {
    this.getRuntime(sessionId).lastViewerActivityAt = Date.now();
    ptyProcess.resize(cols, rows);
  }

  writeTerminal(ptyProcess: IPty, data: string): void {
    ptyProcess.write(data);
  }

  tmuxCopyModeAction(
    sessionId: string,
    action: "enter" | "page_up" | "page_down" | "line_up" | "line_down" | "exit",
    repeatCount = 1,
  ): void {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    if (!this.hasTmuxSession(session.tmuxSessionName)) {
      throw new Error("tmux 会话不存在，无法操作翻页模式");
    }
    const repeat = Number.isFinite(repeatCount) ? Math.max(1, Math.min(30, Math.floor(repeatCount))) : 1;
    const targetPane = `${session.tmuxSessionName}:0.0`;
    if (action === "enter") {
      this.runTmux(["copy-mode", "-t", targetPane]);
      return;
    }
    if (action === "page_up") {
      this.runTmux(["send-keys", "-t", targetPane, "-N", String(repeat), "-X", "page-up"]);
      return;
    }
    if (action === "page_down") {
      this.runTmux(["send-keys", "-t", targetPane, "-N", String(repeat), "-X", "page-down"]);
      return;
    }
    if (action === "line_up") {
      this.runTmux(["send-keys", "-t", targetPane, "-N", String(repeat), "-X", "scroll-up"]);
      return;
    }
    if (action === "line_down") {
      this.runTmux(["send-keys", "-t", targetPane, "-N", String(repeat), "-X", "scroll-down"]);
      return;
    }
    this.runTmux(["send-keys", "-t", targetPane, "-X", "cancel"]);
  }

  closeSession(sessionId: string, force = false): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    if (session.goalConfig.enabled && session.guardDecisionState !== "satisfied" && !force) {
      throw new Error("目标尚未达成，普通停止已被 goal guard 阻止");
    }
    if (
      session.goalConfig.enabled &&
      session.guardDecisionState === "satisfied" &&
      !session.goalConfig.allowManualStopAfterSuccess &&
      !force
    ) {
      throw new Error("当前会话已达标，但配置禁止普通停止，请使用强制停止");
    }
    if (this.hasTmuxSession(session.tmuxSessionName)) {
      this.runTmux(["kill-session", "-t", session.tmuxSessionName]);
    }
    const nextGuardDecisionState = force
      ? "manually_overridden"
      : session.guardDecisionState === "satisfied"
        ? "satisfied"
        : session.goalConfig.enabled
          ? "manually_overridden"
          : "disabled";
    const updated = this.repository.updateSession(sessionId, {
      status: "closed",
      guardDecisionState: nextGuardDecisionState,
      guardDecisionReason: force ? "会话被强制停止。" : "会话已关闭，守卫停止继续接管。",
    });
    this.repository.logAudit("session.closed", { force }, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  renameSession(sessionId: string, title: string): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("会话名称不能为空");
    }
    const updated = this.repository.updateSession(sessionId, {
      title: nextTitle,
    });
    this.repository.logAudit("session.renamed", { title: nextTitle }, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  updateGoalConfig(sessionId: string, goalConfig: GoalGuardConfig): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    let currentSession = session;
    if (this.hasTmuxSession(session.tmuxSessionName)) {
      const refreshed = this.refreshRuntimeFromTmux(session);
      currentSession = refreshed.session;
    }
    const runtime = this.getRuntime(sessionId);
    const preserveSatisfiedState =
      goalConfig.enabled && currentSession.goalConfig.enabled && currentSession.guardDecisionState === "satisfied";
    const nextTaskRunId = goalConfig.enabled
      ? preserveSatisfiedState
        ? currentSession.currentTaskRunId
        : this.createTaskRunId()
      : null;
    const nextGoalSpec = goalConfig.enabled ? buildGoalSpec(goalConfig) : null;
    const nextVerificationSpec = goalConfig.enabled ? buildVerificationSpec(goalConfig) : null;
    runtime.goalActivatedAt = goalConfig.enabled ? Date.now() : null;
    runtime.goalCheckOffset = goalConfig.enabled ? runtime.buffer.length : 0;
    runtime.goalCheckEventSeq = goalConfig.enabled ? this.repository.getLastGuardEventSeq(sessionId) : 0;
    runtime.goalCheckPaneSnapshot = goalConfig.enabled ? runtime.lastPaneSnapshot : "";
    this.persistRuntime(sessionId);
    const shouldResetTerminalGoalState =
      goalConfig.enabled &&
      (!currentSession.goalConfig.enabled ||
        currentSession.guardDecisionState === "satisfied" ||
        currentSession.guardDecisionState === "blocked_by_missing_verifier" ||
        currentSession.guardDecisionState === "blocked_by_fatal_error" ||
        currentSession.guardDecisionState === "manually_overridden");
    const updated = this.repository.updateSession(sessionId, {
      goalConfig,
      status: currentSession.status,
      guardDecisionState: goalConfig.enabled
        ? preserveSatisfiedState
          ? "satisfied"
          : shouldResetTerminalGoalState
            ? "waiting_for_idle"
            : nextEnabledGuardDecisionState(currentSession.guardDecisionState)
        : "disabled",
      guardDecisionReason: goalConfig.enabled
        ? preserveSatisfiedState
          ? "守卫配置更新后保留已确认的成功状态。"
          : "守卫配置已更新，当前进入等待观察状态。"
        : "守卫已停止，仅保留配置。",
      currentTaskRunId: nextTaskRunId,
      goalSpec: nextGoalSpec,
      verificationSpec: nextVerificationSpec,
      verificationReceipt: goalConfig.enabled ? (preserveSatisfiedState ? currentSession.verificationReceipt : null) : null,
      successEvidence: goalConfig.enabled ? (preserveSatisfiedState ? currentSession.successEvidence : null) : currentSession.successEvidence,
    });
    this.repository.logAudit("goal.updated", goalConfig, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  async evaluateGoal(sessionId: string): Promise<boolean> {
    let session = this.repository.getSession(sessionId);
    if (!session || !session.goalConfig.enabled) {
      return false;
    }
    if (!session.currentTaskRunId || !session.goalSpec || !session.verificationSpec) {
      session = this.repository.updateSession(sessionId, {
        currentTaskRunId: session.currentTaskRunId ?? this.createTaskRunId(),
        goalSpec: session.goalSpec ?? buildGoalSpec(session.goalConfig),
        verificationSpec: session.verificationSpec ?? buildVerificationSpec(session.goalConfig),
      });
    }
    if (session.guardDecisionState === "satisfied") {
      return true;
    }
    const snapshot = await this.buildGoalGuardStateSnapshot(sessionId);
    const verificationSpec = session.verificationSpec ?? buildVerificationSpec(session.goalConfig);
    let candidate: GoalVerificationCandidate | null = null;
    const reduction = reduceGoalGuardEvents({
      codexObservation: snapshot.codexObservation,
      terminalDiagnostics: snapshot.terminalDiagnostics,
      hasKeywordRule: snapshot.hasKeywordRule,
      verificationKind: snapshot.verificationKind,
      allowTerminalSignals: snapshot.allowTerminalSignals,
    });
    if (reduction.nextState === "observing_codex_turn") {
      return false;
    }
    if (reduction.candidate) {
      candidate = {
        kind: reduction.candidate.kind,
        source: reduction.candidate.source,
        eventSeq: reduction.candidate.eventSeq,
        detail: reduction.candidate.detail,
      };
    }

    if (!candidate) {
      return false;
    }

    this.repository.updateSession(sessionId, {
      status: session.status === "closed" ? "closed" : "running",
      guardDecisionState: "verifying",
      guardDecisionReason: `${candidate.detail} taskRunId=${session.currentTaskRunId ?? "unknown"}`,
    });
    this.emitSession(sessionId);

    const verification = this.verifyGoalCandidate(session, candidate);
    const verificationReduction = reduceGoalGuardVerificationResult(verification.receipt);
    this.repository.updateSession(sessionId, {
      status: session.status === "closed" ? "closed" : "running",
      guardDecisionState: verificationReduction.nextState,
      guardDecisionReason: verificationReduction.reason,
      verificationReceipt: verification.receipt,
      successEvidence: verificationReduction.keepPreviousSuccessEvidence
        ? session.successEvidence
        : verification.successEvidence,
      lastOutputPreview: verification.previewText,
    });
    this.emitSession(sessionId);
    return verification.passed;
  }

  autoResume(sessionId: string, reason?: string | null): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const runtime = this.getRuntime(sessionId);
    runtime.lastAutoResumeAt = Date.now();
    runtime.autoResumeCount += 1;
    runtime.lastInputAt = runtime.lastAutoResumeAt;
    this.persistRuntime(sessionId);
    const prompt = [
      flattenPromptLine(session.goalConfig.goalText)
        ? `当前目标：${flattenPromptLine(session.goalConfig.goalText)}`
        : null,
      flattenPromptLine(session.goalConfig.resumePromptTemplate || "继续执行既定目标，未完成前不要停止；完成后输出成功标记。"),
    ]
      .filter((item): item is string => Boolean(item))
      .join("；");
    this.sendLiteral(session.tmuxSessionName, prompt, true);
    runtime.lastGuardPromptAt = runtime.lastAutoResumeAt;
    runtime.lastGuardPromptText = prompt;
    this.persistRuntime(sessionId);
    this.appendGuardEvent(sessionId, "guard_prompt", prompt);
    const updated = this.repository.updateSession(sessionId, {
      status: session.status === "closed" ? "closed" : "running",
      guardDecisionState: "resuming",
      guardDecisionReason: reason ?? "守卫已向终端注入续跑提示，等待新的有效进展信号。",
      lastOutputAt: runtime.lastAutoResumeAt,
    });
    this.repository.logAudit("goal.auto_resume", { prompt }, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }
}
