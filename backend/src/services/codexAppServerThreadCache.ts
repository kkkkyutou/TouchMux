import type { AppServerThreadManagerSummary } from "../types/models.js";
import type { CodexAppServerThreadReadResult } from "./codexAppServerProbe.js";

interface CachedThreadState {
  tracked: boolean;
  threadRead: CodexAppServerThreadReadResult | null;
  lastSyncedAt: number | null;
  lastSyncOk: boolean;
  lastError: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export class CodexAppServerThreadCache {
  private readonly cache = new Map<string, CachedThreadState>();

  setTrackedThreadIds(threadIds: Iterable<string>): void {
    const nextTracked = new Set(Array.from(threadIds).filter((threadId) => threadId.length > 0));
    for (const [threadId, current] of this.cache.entries()) {
      this.cache.set(threadId, {
        ...current,
        tracked: nextTracked.has(threadId),
      });
    }
    for (const threadId of nextTracked) {
      if (!this.cache.has(threadId)) {
        this.cache.set(threadId, {
          tracked: true,
          threadRead: null,
          lastSyncedAt: null,
          lastSyncOk: false,
          lastError: null,
        });
      }
    }
  }

  recordThreadRead(threadRead: CodexAppServerThreadReadResult, syncedAt = Date.now()): void {
    const current = this.cache.get(threadRead.threadId);
    this.cache.set(threadRead.threadId, {
      tracked: current?.tracked ?? true,
      threadRead,
      lastSyncedAt: syncedAt,
      lastSyncOk: true,
      lastError: null,
    });
  }

  recordSyncFailure(threadId: string, error: string, syncedAt = Date.now()): void {
    const current = this.cache.get(threadId);
    this.cache.set(threadId, {
      tracked: current?.tracked ?? true,
      threadRead: current?.threadRead ?? null,
      lastSyncedAt: syncedAt,
      lastSyncOk: false,
      lastError: error,
    });
  }

  getThreadRead(threadId: string): CodexAppServerThreadReadResult | null {
    return this.cache.get(threadId)?.threadRead ?? null;
  }

  getThreadManagerSummary(threadId: string | null): AppServerThreadManagerSummary {
    if (!threadId) {
      return {
        threadId: null,
        tracked: false,
        hasSnapshot: false,
        cachedTurnCount: 0,
        lastSyncedAt: null,
        lastSyncOk: false,
        lastError: null,
        threadUpdatedAt: null,
      };
    }
    const current = this.cache.get(threadId);
    const rawThread = asRecord(current?.threadRead?.rawThread);
    const turns = Array.isArray(current?.threadRead?.turns) ? current?.threadRead?.turns : [];
    return {
      threadId,
      tracked: current?.tracked ?? false,
      hasSnapshot: current?.threadRead !== null && current?.threadRead !== undefined,
      cachedTurnCount: turns.length,
      lastSyncedAt: current?.lastSyncedAt ?? null,
      lastSyncOk: current?.lastSyncOk ?? false,
      lastError: current?.lastError ?? null,
      threadUpdatedAt: parseTimestamp(rawThread?.updatedAt),
    };
  }
}

export const codexAppServerThreadCache = new CodexAppServerThreadCache();
