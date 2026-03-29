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
}

const hiddenOverlay: ChoiceOverlay = {
  visible: false,
  source: "",
  options: [],
  excerpt: "",
  detectedAt: 0,
};

function summarizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-300);
}

export class SessionManager extends EventEmitter {
  private readonly runtime = new Map<string, RuntimeState>();

  constructor(private readonly repository: SessionRepository) {
    super();
    this.syncPersistedStatuses();
  }

  private syncPersistedStatuses(): void {
    for (const session of this.repository.listSessions()) {
      const hasTmuxSession = this.hasTmuxSession(session.tmuxSessionName);
      const nextStatus: SessionStatus = hasTmuxSession ? "running" : "closed";
      const nextGoalState =
        session.goalState === "goal_satisfied" || session.goalState === "manual_override_stopped"
          ? session.goalState
          : hasTmuxSession
            ? session.goalConfig.enabled
              ? "running"
              : "disabled"
            : "manual_override_stopped";
      this.repository.updateSession(session.id, {
        status: nextStatus,
        goalState: nextGoalState,
      });
    }
  }

  private getRuntime(sessionId: string): RuntimeState {
    if (!this.runtime.has(sessionId)) {
      this.runtime.set(sessionId, {
        buffer: "",
        choiceOverlay: hiddenOverlay,
        lastAutoResumeAt: null,
      });
    }
    return this.runtime.get(sessionId)!;
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
    if (input.mode === "new") {
      const args = [config.codexExecutable, ...baseArgs];
      if (input.prompt?.trim()) {
        args.push(input.prompt.trim());
      }
      return quoteArgs(args);
    }

    if (!input.sourceCodexSessionId) {
      throw new Error("恢复或 fork 会话必须提供源 Codex session id");
    }

    const subcommand = input.mode === "resume" ? "resume" : "fork";
    const args = [config.codexExecutable, subcommand, input.sourceCodexSessionId, ...baseArgs];
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
      this.runTmux(["send-keys", "-t", sessionName, "Enter"]);
    }
  }

  createSession(input: CreateSessionInput): SessionSummary {
    const absoluteCwd = this.ensureCwd(input);
    const relativeCwd = path.relative(input.workspaceRoot, absoluteCwd) || ".";
    const command = this.buildCodexCommand({ ...input, cwd: absoluteCwd });
    const sessionId = crypto.randomUUID();
    const tmuxSessionName = `touchmux_${sessionId.slice(0, 8)}`;

    this.runTmux(["new-session", "-d", "-s", tmuxSessionName, "-c", absoluteCwd]);
    this.sendLiteral(tmuxSessionName, command, true);

    const created = this.repository.createSession({
      id: sessionId,
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
    const pty = spawn("tmux", ["attach-session", "-t", session.tmuxSessionName], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.resolveSessionCwd(session),
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });
    pty.onData((chunk) => {
      this.recordOutput(sessionId, chunk);
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
    runtime.choiceOverlay = detectChoiceOverlay(runtime.buffer);
    const updated = this.repository.updateSession(sessionId, {
      status: session.goalState === "goal_satisfied" ? "goal_satisfied" : "running",
      lastOutputAt: Date.now(),
      lastOutputPreview: summarizeTerminalText(runtime.buffer),
      goalState:
        session.goalState === "goal_satisfied" ? "goal_satisfied" : session.goalConfig.enabled ? "running" : "disabled",
    });
    this.emit("session-updated", this.toSummary(updated));
  }

  getRecentOutput(sessionId: string): string {
    return this.getRuntime(sessionId).buffer;
  }

  resizeTerminal(ptyProcess: IPty, cols: number, rows: number): void {
    ptyProcess.resize(cols, rows);
  }

  writeTerminal(ptyProcess: IPty, data: string): void {
    ptyProcess.write(data);
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
    const updated = this.repository.updateSession(sessionId, {
      goalConfig,
      goalState: goalConfig.enabled ? "running" : "disabled",
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
    const buffer = this.getRecentOutput(sessionId);
    const hasKeyword =
      session.goalConfig.successKeywords.length === 0 ||
      session.goalConfig.successKeywords.some((keyword) => buffer.includes(keyword));
    if (!hasKeyword) {
      return false;
    }
    if (!session.goalConfig.successCommand) {
      this.repository.updateSession(sessionId, {
        status: "goal_satisfied",
        goalState: "goal_satisfied",
      });
      this.emitSession(sessionId);
      return true;
    }
    const result = spawnSync(config.shell, ["-lc", session.goalConfig.successCommand], {
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
    const prompt =
      session.goalConfig.resumePromptTemplate ||
      "继续执行既定目标，未完成前不要停止；完成后输出成功标记。";
    this.sendLiteral(session.tmuxSessionName, prompt, true);
    const updated = this.repository.updateSession(sessionId, {
      status: "auto_resuming",
      goalState: "auto_resuming",
    });
    this.repository.logAudit("goal.auto_resume", { prompt }, sessionId);
    this.emitSession(sessionId);
    return this.toSummary(updated);
  }
}
