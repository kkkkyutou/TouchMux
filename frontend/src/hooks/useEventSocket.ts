import { useEffect } from "react";
import type { SessionSummary } from "../types/api";

interface SessionEventMessage {
  type: "snapshot" | "session-updated";
  payload: SessionSummary[] | SessionSummary;
}

export type EventSocketStatus = "connecting" | "open" | "reconnecting" | "error";

export function useEventSocket(
  token: string | null,
  onSnapshot: (sessions: SessionSummary[]) => void,
  onSessionUpdated: (session: SessionSummary) => void,
  onStatusChange?: (status: EventSocketStatus) => void,
): void {
  useEffect(() => {
    if (!token) {
      return;
    }
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socketUrl = `${protocol}://${location.host}/ws/events?token=${encodeURIComponent(token)}`;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let closedManually = false;
    let retryCount = 0;

    const setStatus = (status: EventSocketStatus) => {
      onStatusChange?.(status);
    };

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const connect = () => {
      clearRetryTimer();
      setStatus(retryCount === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(socketUrl);

      socket.onopen = () => {
        retryCount = 0;
        setStatus("open");
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as SessionEventMessage;
        if (message.type === "snapshot") {
          onSnapshot(message.payload as SessionSummary[]);
        }
        if (message.type === "session-updated") {
          onSessionUpdated(message.payload as SessionSummary);
        }
      };

      socket.onerror = () => {
        setStatus("error");
      };

      socket.onclose = () => {
        if (closedManually) {
          return;
        }
        retryCount += 1;
        setStatus("reconnecting");
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
  }, [token, onSnapshot, onSessionUpdated, onStatusChange]);
}
