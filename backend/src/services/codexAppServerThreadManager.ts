import { CodexAppServerProbeClient } from "./codexAppServerProbe.js";
import { codexAppServerThreadCache } from "./codexAppServerThreadCache.js";
import type { ManagedSessionRecord } from "../types/models.js";

interface SessionRepositoryLike {
  listSessions(): ManagedSessionRecord[];
}

type CodexAppServerProbeClientLike = Pick<CodexAppServerProbeClient, "initialize" | "readThread" | "disconnect">;

export class CodexAppServerThreadManager {
  private timer: NodeJS.Timeout | null = null;
  private inFlightSync: Promise<void> | null = null;

  constructor(
    private readonly repository: SessionRepositoryLike,
    private readonly syncIntervalMs: number,
    private readonly clientFactory: () => CodexAppServerProbeClientLike = () => new CodexAppServerProbeClient(),
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    void this.syncOnce().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.syncOnce().catch(() => undefined);
    }, this.syncIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  syncOnce(): Promise<void> {
    if (this.inFlightSync) {
      return this.inFlightSync;
    }
    this.inFlightSync = this.runSync().finally(() => {
      this.inFlightSync = null;
    });
    return this.inFlightSync;
  }

  private async runSync(): Promise<void> {
    const threadIds = this.collectTrackedThreadIds();
    codexAppServerThreadCache.setTrackedThreadIds(threadIds);
    if (threadIds.length === 0) {
      return;
    }

    const client = this.clientFactory();
    const syncedAt = Date.now();
    try {
      await client.initialize({
        clientInfo: {
          name: "touchmux-app-server-thread-manager",
          version: "0.1.0",
          title: "TouchMux App Server Thread Manager",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      for (const threadId of threadIds) {
        try {
          const threadRead = await client.readThread(threadId, true);
          codexAppServerThreadCache.recordThreadRead(threadRead, Date.now());
        } catch (error) {
          codexAppServerThreadCache.recordSyncFailure(
            threadId,
            error instanceof Error ? error.message : "thread/read failed",
            Date.now(),
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "app-server initialize failed";
      for (const threadId of threadIds) {
        codexAppServerThreadCache.recordSyncFailure(threadId, message, syncedAt);
      }
    } finally {
      await client.disconnect();
    }
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
}
