import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { spawn, type IPty } from "node-pty";
import { config } from "../core/config.js";
import type {
  ChoiceOverlay,
  CreateSessionInput,
  GoalGuardConfig,
  GoalState,
  ManagedSessionRecord,
  SessionSummary,
  SessionStatus,
} from "../types/models.js";
import { detectChoiceOverlay } from "./choiceDetector.js";
import { SessionRepository } from "./sessionRepository.js";
import { normalizeInsideRoot } from "../utils/paths.js";
import { quoteArgs } from "../utils/shell.js";

interface RuntimeState {
  buffer: string;
  choiceOverlay: ChoiceOverlay;
  lastAutoResumeAt: number | null;
  autoResumeCount: number;
  lastInputAt: number | null;
  goalCheckOffset: number;
  lastPaneSnapshot: string;
  goalCheckPaneSnapshot: string;
  lastViewerActivityAt: number | null;
}

interface GoalGuardDebugInfo {
  sessionId: string;
  goalState: GoalState;
  guardEnabled: boolean;
  hasTmuxSession: boolean;
  lastOutputAt: number | null;
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
}

interface GoalMatchDiagnostics {
  matchedSuccessKeyword: string | null;
  matchedStandaloneSuccess: boolean;
  matchedIncompleteSignals: string[];
  sanitizedGoalWindow: string;
}

const submitDelayArray = new Int32Array(new SharedArrayBuffer(4));
const tmuxLiteralSubmitDelayMs = 300;

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
    lastAutoResumeAt: null,
    autoResumeCount: 0,
    lastInputAt: null,
    goalCheckOffset: 0,
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

function hasStandaloneSuccessMarker(value: string): boolean {
  const tailLines = tailNonEmptyLines(value, 8);
  return tailLines.some((line) => /^(SUCCESS)$/.test(line));
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
    flattenPromptLine(goalConfig.resumePromptTemplate || "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。"),
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
    matchedStandaloneSuccess: hasStandaloneSuccessMarker(sanitizedGoalWindow),
    matchedIncompleteSignals: findIncompleteProgressSignals(sanitizedGoalWindow),
    sanitizedGoalWindow,
  };
}

function mergeRuntimeBuffer(existing: string, captured: string): string {
  const trimmedCaptured = captured.trim();
  if (!trimmedCaptured) {
    return existing.slice(-30000);
  }
  if (!existing) {
    return captured.slice(-30000);
  }
  if (existing.includes(captured)) {
    return existing.slice(-30000);
  }
  if (captured.includes(existing)) {
    return captured.slice(-30000);
  }
  return `${existing}\n${captured}`.slice(-30000);
}

function buildPaneSnapshot(value: string): string {
  return compactNormalizedTerminalText(value).slice(-4000);
}

function hasNewOutputSinceGoalCheckpoint(runtime: RuntimeState): boolean {
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

function nextEnabledGoalState(current: GoalState): GoalState {
  switch (current) {
    case "goal_satisfied":
    case "manual_override_stopped":
    case "failed_check":
      return current;
    default:
      return "idle_waiting";
  }
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

export class SessionManager extends EventEmitter {
  private readonly runtime = new Map<string, RuntimeState>();
  private static readonly viewportNoiseSuppressionMs = 2500;

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
        lastAutoResumeAt: runtime.lastAutoResumeAt,
        autoResumeCount: runtime.autoResumeCount,
        lastInputAt: null,
        goalCheckOffset: runtime.goalCheckOffset,
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
      const nextGoalState =
        session.goalState === "goal_satisfied" ||
        session.goalState === "manual_override_stopped" ||
        session.goalState === "failed_check"
          ? session.goalState
          : hasTmuxSession
            ? session.goalConfig.enabled
              ? "idle_waiting"
              : "disabled"
            : "manual_override_stopped";
      this.repository.updateSession(session.id, {
        status: nextStatus,
        goalState: nextGoalState,
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
        lastAutoResumeAt: persisted?.lastAutoResumeAt ?? fallback.lastAutoResumeAt,
        autoResumeCount: persisted?.autoResumeCount ?? fallback.autoResumeCount,
        lastInputAt: null,
        goalCheckOffset: persisted?.goalCheckOffset ?? fallback.goalCheckOffset,
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
      lastAutoResumeAt: runtime.lastAutoResumeAt,
      autoResumeCount: runtime.autoResumeCount,
      goalCheckOffset: runtime.goalCheckOffset,
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

  private resolveSessionCwd(session: ManagedSessionRecord): string {
    return path.isAbsolute(session.cwd) ? session.cwd : normalizeInsideRoot(session.workspaceRoot, session.cwd);
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
      `HOME=${config.sessionHome}`,
      `TOUCHMUX_SESSION_HOME=${config.sessionHome}`,
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
    const nextPaneSnapshot = buildPaneSnapshot(captured);
    const paneChanged = nextPaneSnapshot !== runtime.lastPaneSnapshot;
    const suppressViewportNoise =
      paneChanged &&
      runtime.lastViewerActivityAt !== null &&
      Date.now() - runtime.lastViewerActivityAt < SessionManager.viewportNoiseSuppressionMs;
    runtime.buffer = mergeRuntimeBuffer(runtime.buffer, captured);
    runtime.lastPaneSnapshot = nextPaneSnapshot;
    runtime.choiceOverlay = detectChoiceOverlay(runtime.buffer);
    this.persistRuntime(session.id);
    const nextPreview = summarizeTerminalText(runtime.buffer);
    const changes: Partial<Pick<ManagedSessionRecord, "status" | "lastOutputAt" | "lastOutputPreview" | "goalState">> & {
      updatedAt?: number;
    } = {};
    const bufferChanged = runtime.buffer !== previousBuffer;
    if (paneChanged && !suppressViewportNoise) {
      changes.lastOutputAt = Date.now();
      changes.status = session.goalState === "goal_satisfied" ? "goal_satisfied" : "running";
      if (session.goalConfig.enabled && session.goalState !== "goal_satisfied") {
        changes.goalState = hasNewOutputSinceGoalCheckpoint(runtime) ? "running" : "idle_waiting";
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
      `HOME=${config.sessionHome}`,
      "-e",
      `TOUCHMUX_SESSION_HOME=${config.sessionHome}`,
      ...(process.env.PATH ? ["-e", `PATH=${process.env.PATH}`] : []),
    ]);
    this.sendLiteral(tmuxSessionName, command, true);

    const created = this.repository.createSession({
      id: sessionId,
      nodeId: config.localNode.id,
      title: input.title.trim() || `会话 ${sessionId.slice(0, 6)}`,
      mode: input.mode,
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
        HOME: config.sessionHome,
        TOUCHMUX_SESSION_HOME: config.sessionHome,
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
    const runtime = this.getRuntime(sessionId);
    runtime.buffer = `${runtime.buffer}${chunk}`.slice(-30000);
    runtime.lastPaneSnapshot = buildPaneSnapshot(runtime.buffer);
    runtime.choiceOverlay = detectChoiceOverlay(runtime.buffer);
    this.persistRuntime(sessionId);
    const updated = this.repository.updateSession(sessionId, {
      status: session.goalState === "goal_satisfied" ? "goal_satisfied" : "running",
      lastOutputAt: Date.now(),
      lastOutputPreview: summarizeTerminalText(runtime.buffer),
      goalState:
        session.goalState === "goal_satisfied"
          ? "goal_satisfied"
          : session.goalConfig.enabled
            ? hasNewOutputSinceGoalCheckpoint(runtime)
              ? "running"
              : "idle_waiting"
            : "disabled",
    });
    this.emit("session-updated", this.toSummary(updated));
  }

  noteInputActivity(sessionId: string): void {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      return;
    }
    const runtime = this.getRuntime(sessionId);
    runtime.lastInputAt = Date.now();
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

  getGoalDebugInfo(sessionId: string): GoalGuardDebugInfo | null {
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
      guardEnabled: refreshedSession.goalConfig.enabled,
      hasTmuxSession: this.hasTmuxSession(refreshedSession.tmuxSessionName),
      lastOutputAt: refreshedSession.lastOutputAt,
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
    };
  }

  reconcileGoalSatisfiedState(sessionId: string): SessionSummary | null {
    const session = this.repository.getSession(sessionId);
    if (!session || !session.goalConfig.enabled || session.goalState !== "goal_satisfied") {
      return session ? this.toSummary(session) : null;
    }
    const diagnostics = getGoalMatchDiagnostics(this.getGoalWindowOutput(sessionId), session.goalConfig);
    const stillMatchesSuccess =
      (diagnostics.matchedStandaloneSuccess || diagnostics.matchedSuccessKeyword !== null) &&
      diagnostics.matchedIncompleteSignals.length === 0;
    if (stillMatchesSuccess) {
      return this.toSummary(session);
    }
    const updated = this.repository.updateSession(sessionId, {
      status: "running",
      goalState: "idle_waiting",
    });
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  detectFatalGuardStop(sessionId: string): string | null {
    const buffer = this.getRecentOutput(sessionId).slice(-6000);
    for (const pattern of terminalFatalStopPatterns) {
      const match = buffer.match(pattern);
      if (match) {
        return match[0];
      }
    }
    return null;
  }

  markGuardFailed(sessionId: string, reason: string): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const updated = this.repository.updateSession(sessionId, {
      status: "failed_check",
      goalState: "failed_check",
      lastOutputPreview: summarizeTerminalText([session.lastOutputPreview, reason].filter(Boolean).join(" ")),
    });
    this.repository.logAudit("goal.failed_check", { reason }, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  markGuardWaiting(sessionId: string): SessionSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    const updated = this.repository.updateSession(sessionId, {
      goalState: "idle_waiting",
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
    if (session.goalConfig.enabled && session.goalState !== "goal_satisfied" && !force) {
      throw new Error("目标尚未达成，普通停止已被 goal guard 阻止");
    }
    if (
      session.goalConfig.enabled &&
      session.goalState === "goal_satisfied" &&
      !session.goalConfig.allowManualStopAfterSuccess &&
      !force
    ) {
      throw new Error("当前会话已达标，但配置禁止普通停止，请使用强制停止");
    }
    if (this.hasTmuxSession(session.tmuxSessionName)) {
      this.runTmux(["kill-session", "-t", session.tmuxSessionName]);
    }
    const goalState = force
      ? "manual_override_stopped"
      : session.goalState === "goal_satisfied"
        ? "goal_satisfied"
        : session.goalConfig.enabled
          ? "manual_override_stopped"
          : "disabled";
    const updated = this.repository.updateSession(sessionId, {
      status: "closed",
      goalState,
    });
    this.repository.logAudit("session.closed", { force }, sessionId);
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
    const preEnableDiagnostics = goalConfig.enabled ? getGoalMatchDiagnostics(runtime.buffer, goalConfig) : null;
    const hasPreExistingSuccess =
      goalConfig.enabled &&
      preEnableDiagnostics !== null &&
      (preEnableDiagnostics.matchedStandaloneSuccess || preEnableDiagnostics.matchedSuccessKeyword !== null) &&
      preEnableDiagnostics.matchedIncompleteSignals.length === 0;
    runtime.goalCheckOffset = goalConfig.enabled ? runtime.buffer.length : 0;
    runtime.goalCheckPaneSnapshot = goalConfig.enabled ? runtime.lastPaneSnapshot : "";
    this.persistRuntime(sessionId);
    const shouldResetTerminalGoalState =
      goalConfig.enabled &&
      (!currentSession.goalConfig.enabled ||
        currentSession.goalState === "goal_satisfied" ||
        currentSession.goalState === "failed_check" ||
        currentSession.goalState === "manual_override_stopped");
    const updated = this.repository.updateSession(sessionId, {
      goalConfig,
      status: goalConfig.enabled
        ? hasPreExistingSuccess
          ? "goal_satisfied"
          : this.hasTmuxSession(currentSession.tmuxSessionName)
            ? "running"
            : currentSession.status
        : currentSession.status,
      goalState: goalConfig.enabled
        ? hasPreExistingSuccess
          ? "goal_satisfied"
          : shouldResetTerminalGoalState
            ? "idle_waiting"
            : nextEnabledGoalState(currentSession.goalState)
        : "disabled",
    });
    this.repository.logAudit("goal.updated", goalConfig, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }

  async evaluateGoal(sessionId: string): Promise<boolean> {
    const session = this.repository.getSession(sessionId);
    if (!session || !session.goalConfig.enabled) {
      return false;
    }
    if (session.goalState === "goal_satisfied") {
      return true;
    }
    const buffer = this.getGoalWindowOutput(sessionId);
    const hasKeywordRule = session.goalConfig.successKeywords.length > 0;
    const hasCommandRule = Boolean(session.goalConfig.successCommand?.trim());
    const diagnostics = getGoalMatchDiagnostics(buffer, session.goalConfig);
    if (!diagnostics.matchedStandaloneSuccess && diagnostics.matchedIncompleteSignals.length > 0) {
      return false;
    }
    if (!hasKeywordRule && !hasCommandRule && !diagnostics.matchedStandaloneSuccess) {
      return false;
    }
    const keywordMatched =
      diagnostics.matchedStandaloneSuccess ||
      !hasKeywordRule ||
      diagnostics.matchedSuccessKeyword !== null;
    if (!keywordMatched) {
      return false;
    }
    if (!hasCommandRule) {
      this.repository.updateSession(sessionId, {
        status: "goal_satisfied",
        goalState: "goal_satisfied",
      });
      this.emitSession(sessionId);
      return true;
    }
    const result = spawnSync(config.shell, ["-lc", session.goalConfig.successCommand!], {
      cwd: this.resolveSessionCwd(session),
      stdio: "pipe",
      encoding: "utf8",
    });
    const nextState = result.status === 0 ? "goal_satisfied" : "failed_check";
    this.repository.updateSession(sessionId, {
      status: result.status === 0 ? "goal_satisfied" : session.status,
      goalState: nextState,
      lastOutputPreview: summarizeTerminalText([session.lastOutputPreview, result.stdout, result.stderr].filter(Boolean).join(" ")),
    });
    this.emitSession(sessionId);
    return result.status === 0;
  }

  autoResume(sessionId: string): SessionSummary {
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
    const updated = this.repository.updateSession(sessionId, {
      status: "auto_resuming",
      goalState: "auto_resuming",
      lastOutputAt: runtime.lastAutoResumeAt,
    });
    this.repository.logAudit("goal.auto_resume", { prompt }, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }
}
