import type { CodexAppServerNotificationRecord } from "./codexAppServerProbe.js";
import type { AppServerNotificationSummary } from "../types/models.js";

interface CachedThreadNotifications {
  notifications: CodexAppServerNotificationRecord[];
  updatedAt: number;
}

const perThreadLimit = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractThreadId(notification: CodexAppServerNotificationRecord): string | null {
  const params = asRecord(notification.params);
  if (!params) {
    return null;
  }
  if (typeof params.threadId === "string" && params.threadId.length > 0) {
    return params.threadId;
  }
  const thread = asRecord(params.thread);
  if (typeof thread?.id === "string" && thread.id.length > 0) {
    return thread.id;
  }
  return null;
}

export class CodexAppServerNotificationCache {
  private readonly cache = new Map<string, CachedThreadNotifications>();

  ingest(notification: CodexAppServerNotificationRecord): void {
    const threadId = extractThreadId(notification);
    if (!threadId) {
      return;
    }
    const current = this.cache.get(threadId);
    const notifications = [...(current?.notifications ?? []), notification].slice(-perThreadLimit);
    this.cache.set(threadId, {
      notifications,
      updatedAt: notification.receivedAt,
    });
  }

  listThreadNotifications(threadId: string): CodexAppServerNotificationRecord[] {
    return [...(this.cache.get(threadId)?.notifications ?? [])];
  }

  getThreadUpdatedAt(threadId: string): number | null {
    return this.cache.get(threadId)?.updatedAt ?? null;
  }

  getThreadSummary(threadId: string | null): AppServerNotificationSummary {
    if (!threadId) {
      return {
        threadId: null,
        cachedCount: 0,
        latestMethod: null,
        latestReceivedAt: null,
      };
    }
    const notifications = this.cache.get(threadId)?.notifications ?? [];
    const latest = notifications[notifications.length - 1] ?? null;
    return {
      threadId,
      cachedCount: notifications.length,
      latestMethod: latest?.method ?? null,
      latestReceivedAt: latest?.receivedAt ?? null,
    };
  }
}

export const codexAppServerNotificationCache = new CodexAppServerNotificationCache();
