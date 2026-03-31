import { SessionManager } from "./sessionManager.js";
import { SessionRepository } from "./sessionRepository.js";

export class GoalGuardService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly repository: SessionRepository,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
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
      this.sessionManager.syncSessionFromTmux(session.id, true);
      const current = this.repository.getSession(session.id);
      if (!current || !current.goalConfig.enabled || current.status === "closed") {
        continue;
      }
      const success = await this.sessionManager.evaluateGoal(current.id);
      if (success) {
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
}
