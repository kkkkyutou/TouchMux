import { useEffect } from "react";
import type { EventSocketStatus } from "./useEventSocket";

interface UseControlPlaneSyncOptions {
  token: string | null;
  eventSocketStatus: EventSocketStatus;
  refreshAll: () => Promise<void>;
  refreshNodes: () => Promise<void>;
  onError: (error: unknown, fallbackMessage: string) => void;
}

export function useControlPlaneSync({
  token,
  eventSocketStatus,
  refreshAll,
  refreshNodes,
  onError,
}: UseControlPlaneSyncOptions): void {
  useEffect(() => {
    if (!token) {
      return;
    }
    void refreshAll().catch((error) => {
      onError(error, "初始化失败");
    });
  }, [token, refreshAll, onError]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshNodes().catch((error) => {
        onError(error, "节点列表刷新失败");
      });
    }, 10000);
    return () => window.clearInterval(timer);
  }, [token, refreshNodes, onError]);

  useEffect(() => {
    if (!token || eventSocketStatus === "open") {
      return;
    }
    void refreshAll().catch(() => undefined);
    const timer = window.setInterval(() => {
      void refreshAll().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [token, eventSocketStatus, refreshAll]);
}
