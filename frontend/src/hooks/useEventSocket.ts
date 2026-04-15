import { useEffect, useRef } from "react";
import type { SessionSummary } from "../types/api";

interface SessionEventMessage {
  type: "snapshot" | "session-updated";
  payload: SessionSummary[] | SessionSummary;
}

export type EventSocketStatus = "connecting" | "open" | "reconnecting" | "error";

export interface EventSocketState {
  status: EventSocketStatus;
  retryCount: number;
  lastError: string | null;
  wsBaseUrl: string | null;
}

export function useEventSocket(
  token: string | null,
  onSnapshot: (sessions: SessionSummary[]) => void,
  onSessionUpdated: (session: SessionSummary) => void,
  onStatusChange?: (state: EventSocketState) => void,
  wsBaseUrl?: string | null,
): void {
  const onSnapshotRef = useRef(onSnapshot);
  const onSessionUpdatedRef = useRef(onSessionUpdated);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);

  useEffect(() => {
    onSessionUpdatedRef.current = onSessionUpdated;
  }, [onSessionUpdated]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const wsOrigin = wsBaseUrl?.replace(/\/$/, "") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    const socketUrl = `${wsOrigin}/ws/events?token=${encodeURIComponent(token)}`;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let closedManually = false;
    let retryCount = 0;
    let lastError: string | null = null;

    const setStatus = (status: EventSocketStatus, overrides?: Partial<Omit<EventSocketState, "status">>) => {
      if (overrides?.retryCount !== undefined) {
        retryCount = overrides.retryCount;
      }
      if (overrides?.lastError !== undefined) {
        lastError = overrides.lastError;
      }
      onStatusChangeRef.current?.({
        status,
        retryCount,
        lastError,
        wsBaseUrl: wsOrigin,
      });
    };

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const connect = () => {
      clearRetryTimer();
      setStatus(retryCount === 0 ? "connecting" : "reconnecting", {
        lastError,
      });
      socket = new WebSocket(socketUrl);

      socket.onopen = () => {
        setStatus("open", {
          retryCount: 0,
          lastError: null,
        });
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as SessionEventMessage;
        if (message.type === "snapshot") {
          onSnapshotRef.current(message.payload as SessionSummary[]);
        }
        if (message.type === "session-updated") {
          onSessionUpdatedRef.current(message.payload as SessionSummary);
        }
      };

      socket.onerror = () => {
        setStatus("error", {
          lastError: "控制面事件流连接出现错误。",
        });
      };

      socket.onclose = (event) => {
        if (closedManually) {
          return;
        }
        const nextRetryCount = retryCount + 1;
        const closeReason = event.reason?.trim()
          ? `控制面事件流已关闭：${event.reason}`
          : event.wasClean
            ? "控制面事件流已关闭，正在重连。"
            : "控制面事件流异常中断，正在重连。";
        setStatus("reconnecting", {
          retryCount: nextRetryCount,
          lastError: closeReason,
        });
        const retryDelayMs = Math.min(1000 * 2 ** Math.min(retryCount - 1, 3), 8000);
        retryTimer = window.setTimeout(connect, retryDelayMs);
      };
    };

    connect();

    return () => {
      closedManually = true;
      clearRetryTimer();
      socket?.close();
    };
  }, [token, wsBaseUrl]);
}
