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
      const success = await this.sessionManager.evaluateGoal(session.id);
      if (success) {
        continue;
      }
      const idleSince = session.lastOutputAt ?? session.createdAt;
      if (Date.now() - idleSince < session.goalConfig.idleTimeoutSec * 1000) {
        continue;
      }
      if (!this.sessionManager.hasTmuxSession(session.tmuxSessionName)) {
        continue;
      }
      this.sessionManager.autoResume(session.id);
    }
  }
}
