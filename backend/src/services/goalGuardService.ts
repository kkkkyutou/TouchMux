import { SessionManager } from "./sessionManager.js";
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
      if (session.goalState === "goal_satisfied") {
        this.sessionManager.reconcileGoalSatisfiedState(session.id);
      }
      this.sessionManager.syncSessionFromTmux(session.id, true);
      const current = this.repository.getSession(session.id);
      if (
        !current ||
        !current.goalConfig.enabled ||
        current.status === "closed" ||
        current.goalState === "goal_satisfied" ||
        current.goalState === "failed_check"
      ) {
        continue;
      }
      if (
        current.goalState === "running" &&
        current.lastOutputAt &&
        Date.now() - current.lastOutputAt >= GoalGuardService.runningCooldownMs
      ) {
        this.sessionManager.markGuardWaiting(current.id);
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
      const runtime = this.repository.getRuntimeState(current.id);
      const hasBootstrapped = (runtime?.autoResumeCount ?? 0) > 0;
      if (!hasBootstrapped && Date.now() - current.createdAt >= GoalGuardService.firstProbeDelayMs) {
        if (this.sessionManager.hasTmuxSession(current.tmuxSessionName)) {
          this.sessionManager.autoResume(current.id);
        }
        continue;
      }
      const idleSince = this.sessionManager.getLastActivityAt(current.id) ?? current.createdAt;
      if (Date.now() - idleSince < current.goalConfig.idleTimeoutSec * 1000) {
        continue;
      }
      if (!this.sessionManager.hasTmuxSession(current.tmuxSessionName)) {
        continue;
      }
      this.sessionManager.autoResume(current.id);
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
