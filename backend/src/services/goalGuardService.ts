import { SessionManager } from "./sessionManager.js";
import {
  reduceGoalGuardEvents,
  reduceGoalGuardResumeDecision,
} from "./goalGuardReducer.js";
import { SessionRepository } from "./sessionRepository.js";

export class GoalGuardService {
  private timer: NodeJS.Timeout | null = null;
  private bootstrapTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private static readonly firstProbeDelayMs = 5000;
  private static readonly runningCooldownMs = 4000;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly repository: SessionRepository,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.bootstrapTimer = setTimeout(() => {
      void this.runTick();
    }, Math.min(this.intervalMs, GoalGuardService.firstProbeDelayMs));
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const sessions = this.repository.listSessions();
    for (const session of sessions) {
      if (!session.goalConfig.enabled || session.status === "closed") {
        continue;
      }
      if (session.guardDecisionState === "satisfied") {
        this.sessionManager.reconcileGoalSatisfiedState(session.id);
      }
      this.sessionManager.syncSessionFromTmux(session.id, true);
      const current = this.repository.getSession(session.id);
      if (
        !current ||
        !current.goalConfig.enabled ||
        current.status === "closed" ||
        current.guardDecisionState === "satisfied" ||
        current.guardDecisionState === "blocked_by_fatal_error"
      ) {
        continue;
      }
      const codexFatalReason = await this.sessionManager.detectCodexFatalGuardStop(current.id);
      if (codexFatalReason) {
        this.sessionManager.markGuardFailed(current.id, `检测到 Codex 结构化错误：${codexFatalReason}`);
        continue;
      }
      const snapshot = await this.sessionManager.buildGoalGuardStateSnapshot(current.id);
      const reduction = reduceGoalGuardEvents({
        codexObservation: snapshot.codexObservation,
        terminalDiagnostics: snapshot.terminalDiagnostics,
        hasKeywordRule: snapshot.hasKeywordRule,
        verificationKind: snapshot.verificationKind,
        allowTerminalSignals: snapshot.allowTerminalSignals,
      });
      if (reduction.nextState === "observing_codex_turn") {
        this.sessionManager.markGuardObservingCodexTurn(
          current.id,
          "守卫当前主要依据结构化 Codex 事件确认 turn 仍在执行，因此继续等待，不触发自动续跑。",
        );
        continue;
      }
      const resumeReduction = reduceGoalGuardResumeDecision({
        currentState: snapshot.session.guardDecisionState,
        hasRecentOutput: snapshot.hasRecentOutput,
        hasBootstrapped: snapshot.hasBootstrapped,
        withinActivationSettleWindow: snapshot.withinActivationSettleWindow,
        reachedFirstProbeDelay: snapshot.reachedFirstProbeDelay,
        idleTimedOut: snapshot.idleTimedOut,
        hasTmuxSession: snapshot.hasTmuxSession,
      });
      if (resumeReduction.action === "mark_waiting") {
        this.sessionManager.markGuardWaiting(current.id, resumeReduction.reason);
        continue;
      }
      const fatalReason = this.sessionManager.detectFatalGuardStop(current.id);
      if (fatalReason) {
        this.sessionManager.markGuardFailed(current.id, `检测到终止模式：${fatalReason}`);
        continue;
      }
      const success = await this.sessionManager.evaluateGoal(current.id);
      if (success) {
        continue;
      }
      if (resumeReduction.action === "auto_resume") {
        this.sessionManager.autoResume(current.id, resumeReduction.reason);
      }
    }
  }

  private async runTick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.tick();
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`[GoalGuard] tick failed: ${detail}`);
    } finally {
      this.ticking = false;
    }
  }
}
