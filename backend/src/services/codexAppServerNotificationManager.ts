import { CodexAppServerProbeClient } from "./codexAppServerProbe.js";
import type { ManagedSessionRecord, AppServerNotificationManagerSummary } from "../types/models.js";

interface SessionRepositoryLike {
  listSessions(): ManagedSessionRecord[];
}

type CodexAppServerProbeClientLike = Pick<CodexAppServerProbeClient, "initialize" | "disconnect">;

const emptySummary: AppServerNotificationManagerSummary = {
  active: false,
  connected: false,
  trackedThreadCount: 0,
  lastConnectedAt: null,
  lastError: null,
};

let latestSummary: AppServerNotificationManagerSummary = emptySummary;

export class CodexAppServerNotificationManager {
  private timer: NodeJS.Timeout | null = null;
  private connecting: Promise<void> | null = null;
  private client: CodexAppServerProbeClientLike | null = null;
  private connected = false;
  private lastConnectedAt: number | null = null;
  private lastError: string | null = null;
  private trackedThreadCount = 0;

  constructor(
    private readonly repository: SessionRepositoryLike,
    private readonly intervalMs: number,
    private readonly clientFactory: () => CodexAppServerProbeClientLike = () => new CodexAppServerProbeClient(),
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    void this.reconcile().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.disconnectClient().catch(() => undefined);
  }

  getSummary(): AppServerNotificationManagerSummary {
    return {
      active: this.trackedThreadCount > 0,
      connected: this.connected,
      trackedThreadCount: this.trackedThreadCount,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
    };
  }

  async reconcile(): Promise<void> {
    const trackedThreadIds = this.collectTrackedThreadIds();
    this.trackedThreadCount = trackedThreadIds.length;
    this.publishSummary();
    if (trackedThreadIds.length === 0) {
      await this.disconnectClient();
      return;
    }
    if (this.connected && this.client) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.connectClient().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectClient(): Promise<void> {
    const client = this.clientFactory();
    try {
      await client.initialize({
        clientInfo: {
          name: "touchmux-app-server-notification-manager",
          version: "0.1.0",
          title: "TouchMux App Server Notification Manager",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.client = client;
      this.connected = true;
      this.lastConnectedAt = Date.now();
      this.lastError = null;
      this.publishSummary();
    } catch (error) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : "notification manager initialize failed";
      this.publishSummary();
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
    }
  }

  private async disconnectClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.publishSummary();
    if (!client) {
      return;
    }
    await client.disconnect();
  }

  private collectTrackedThreadIds(): string[] {
    const threadIds = new Set<string>();
    for (const session of this.repository.listSessions()) {
      if (session.executionChannel !== "app_server_remote_tui") {
        continue;
      }
      if (session.status === "closed") {
        continue;
      }
      const threadId = session.currentCodexSessionId ?? session.sourceCodexSessionId;
      if (threadId) {
        threadIds.add(threadId);
      }
    }
    return [...threadIds];
  }

  private publishSummary(): void {
    latestSummary = this.getSummary();
  }
}

export function getCodexAppServerNotificationManagerSummary(): AppServerNotificationManagerSummary {
  return latestSummary;
}
