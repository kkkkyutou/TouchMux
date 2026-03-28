import { useEffect } from "react";
import type { SessionSummary } from "../types/api";

interface SessionEventMessage {
  type: "snapshot" | "session-updated";
  payload: SessionSummary[] | SessionSummary;
}

export function useEventSocket(
  token: string | null,
  onSnapshot: (sessions: SessionSummary[]) => void,
  onSessionUpdated: (session: SessionSummary) => void,
): void {
  useEffect(() => {
    if (!token) {
      return;
    }
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws/events?token=${encodeURIComponent(token)}`);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as SessionEventMessage;
      if (message.type === "snapshot") {
        onSnapshot(message.payload as SessionSummary[]);
      }
      if (message.type === "session-updated") {
        onSessionUpdated(message.payload as SessionSummary);
      }
    };
    return () => {
      socket.close();
    };
  }, [token, onSnapshot, onSessionUpdated]);
}
