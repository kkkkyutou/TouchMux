import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { LoginScreen } from "./components/LoginScreen";
import { SessionSidebar } from "./components/SessionSidebar";
import {
  ApiError,
  closeSession,
  createSession,
  fetchHistory,
  fetchInterfaceCatalog,
  fetchNodes,
  fetchSessions,
  isUnauthorizedError,
  login,
  overrideStop,
  renameSession,
} from "./lib/api";
import {
  executeNodeFirstRead,
  formatConnectionPathLabel,
  resolveAppTransportModel,
} from "./lib/nodeAccess";
import {
  describeHistoryTransport,
  describeInterfaceBoundarySummary,
  describeCurrentNodeStatus,
  describeGlobalStatusIssue,
  describeTerminalDiagnostics,
  selectCurrentNode,
  selectCurrentSession,
  selectSidebarNode,
} from "./lib/appStateSelectors";
import { useEventSocket, type EventSocketState, type EventSocketStatus } from "./hooks/useEventSocket";
import { useControlPlaneSync } from "./hooks/useControlPlaneSync";
import type { HistoryConversationSummary, InterfaceCatalogEntry, NodeSummary, SessionSummary } from "./types/api";

const TOKEN_STORAGE_KEY = "touchmux-token";
const DESKTOP_SIDEBAR_COLLAPSED_KEY = "touchmux-desktop-sidebar-collapsed";
const TERMINAL_ACCESS_MODE_STORAGE_KEY = "touchmux-terminal-access-mode";
const FILE_ACCESS_MODE_STORAGE_KEY = "touchmux-file-access-mode";
const THEME_STORAGE_KEY = "touchmux-theme";
const TerminalPane = lazy(async () => {
  const module = await import("./components/TerminalPane");
  return { default: module.TerminalPane };
});
const FileBrowser = lazy(async () => {
  const module = await import("./components/FileBrowser");
  return { default: module.FileBrowser };
});
const GoalGuardEditor = lazy(async () => {
  const module = await import("./components/GoalGuardEditor");
  return { default: module.GoalGuardEditor };
});

type TmuxCopyModeAction = "enter" | "page_up" | "page_down" | "line_up" | "line_down" | "exit";
type TerminalConnectionPhase = "connecting" | "open" | "reconnecting" | "blocked";
interface ControlPlaneState {
  sessions: SessionSummary[];
  nodes: NodeSummary[];
  currentNodeId: string | null;
  currentSessionId: string | null;
}

interface HistoryState {
  items: HistoryConversationSummary[];
  connectionPath: "direct" | "gateway";
  gatewayFallbackUsed: boolean;
  gatewayFallbackReason: string | null;
}

interface InterfaceCatalogSummary {
  runtimeMode: string | null;
  items: InterfaceCatalogEntry[];
}

function classifyDirectReadFallbackReason(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "直连读取鉴权失败";
    }
    if (error.status === 403) {
      return "直连读取权限不足";
    }
    if (error.status === 404) {
      return "直连读取目标不存在";
    }
    if (error.status >= 500) {
      return "直连读取服务异常";
    }
    return "直连读取请求失败";
  }
  if (error instanceof TypeError) {
    return "直连读取网络连接失败";
  }
  return "直连读取失败";
}

function createInitialEventSocketState(): EventSocketState {
  return {
    status: "connecting",
    retryCount: 0,
    lastError: null,
    wsBaseUrl: null,
  };
}

function createInitialControlPlaneState(): ControlPlaneState {
  return {
    sessions: [],
    nodes: [],
    currentNodeId: null,
    currentSessionId: null,
  };
}

function createInitialHistoryState(): HistoryState {
  return {
    items: [],
    connectionPath: "gateway",
    gatewayFallbackUsed: false,
    gatewayFallbackReason: null,
  };
}

function createInitialInterfaceCatalogSummary(): InterfaceCatalogSummary {
  return {
    runtimeMode: null,
    items: [],
  };
}

function formatLastCheckedAt(timestamp: number | null): string {
  if (!timestamp) {
    return "尚未检测";
  }
  return new Date(timestamp).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function describeRuntimeContextState(
  state: SessionSummary["runtimeContextState"],
): { title: string; tone: "open" | "connecting" | "error"; detail: string } {
  if (state === "live") {
    return {
      title: "实时",
      tone: "open",
      detail: "当前状态来自实时维护。",
    };
  }
  if (state === "tmux_resynced") {
    return {
      title: "重同步",
      tone: "connecting",
      detail: "启动后已重新和 tmux 对齐。",
    };
  }
  return {
    title: "旧快照",
    tone: "error",
    detail: "当前主要依赖旧快照。",
  };
}

function describeAppError(error: unknown, fallbackMessage: string, runtimeMode: string | null): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "认证已失效，请重新登录。";
    }
    if (error.status === 404) {
      return `请求目标不存在：${error.message || fallbackMessage}`;
    }
    if (error.status >= 500) {
      return `${runtimeMode === "hub" ? "统一入口" : "当前服务"}返回服务错误：${error.message || fallbackMessage}`;
    }
    return error.message || fallbackMessage;
  }
  if (error instanceof TypeError) {
    return runtimeMode === "hub"
      ? "无法连接统一入口，请检查 Hub 服务或当前网络。"
      : "无法连接当前服务，请检查服务进程或当前网络。";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallbackMessage;
}

function upsertSession(list: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const existing = list.findIndex((item) => item.id === next.id);
  if (existing === -1) {
    return [next, ...list];
  }
  const copy = [...list];
  copy[existing] = next;
  return copy;
}

function resolveSessionForNode(list: SessionSummary[], nodeId: string | null): SessionSummary | null {
  if (!nodeId) {
    return null;
  }
  const candidates = list
    .filter((session) => session.nodeId === nodeId && session.hasTmuxSession)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return candidates[0] ?? null;
}

function resolvePreferredNodeId(
  sessions: SessionSummary[],
  nodes: NodeSummary[],
  currentNodeId: string | null,
): string | null {
  if (currentNodeId && nodes.some((node) => node.id === currentNodeId)) {
    return currentNodeId;
  }
  const liveSessionNodeId = sessions.find((session) => session.hasTmuxSession && session.status !== "closed")?.nodeId ?? null;
  if (liveSessionNodeId && nodes.some((node) => node.id === liveSessionNodeId)) {
    return liveSessionNodeId;
  }
  return nodes[0]?.id ?? null;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_STORAGE_KEY));
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [controlPlaneState, setControlPlaneState] = useState<ControlPlaneState>(() => createInitialControlPlaneState());
  const [historyState, setHistoryState] = useState<HistoryState>(() => createInitialHistoryState());
  const [interfaceCatalogSummary, setInterfaceCatalogSummary] = useState<InterfaceCatalogSummary>(() =>
    createInitialInterfaceCatalogSummary(),
  );
  const [flashError, setFlashError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const raw = localStorage.getItem(THEME_STORAGE_KEY);
      return raw === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [eventSocketState, setEventSocketState] = useState<EventSocketState>(() => createInitialEventSocketState());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [terminalAccessMode, setTerminalAccessMode] = useState<"gateway" | "direct_preferred">(() => {
    try {
      const raw = localStorage.getItem(TERMINAL_ACCESS_MODE_STORAGE_KEY);
      return raw === "direct_preferred" ? "direct_preferred" : "gateway";
    } catch {
      return "gateway";
    }
  });
  const [fileAccessMode, setFileAccessMode] = useState<"gateway" | "direct_preferred">(() => {
    try {
      const raw = localStorage.getItem(FILE_ACCESS_MODE_STORAGE_KEY);
      return raw === "direct_preferred" ? "direct_preferred" : "gateway";
    } catch {
      return "gateway";
    }
  });
  const senderRef = useRef<((text: string) => void) | null>(null);
  const tmuxCopyModeRef = useRef<((action: TmuxCopyModeAction) => void) | null>(null);
  const [copyModeIntent, setCopyModeIntent] = useState<"inherit" | "enabled" | "disabled">("inherit");
  const { sessions, nodes, currentNodeId, currentSessionId } = controlPlaneState;
  const {
    items: historyItems,
    connectionPath: historyConnectionPath,
    gatewayFallbackUsed: historyGatewayFallbackUsed,
    gatewayFallbackReason: historyGatewayFallbackReason,
  } = historyState;
  const interfaceCatalogItems = interfaceCatalogSummary.items;
  const deferredSessionId = useDeferredValue(currentSessionId);
  const [editingSessionTitle, setEditingSessionTitle] = useState(false);
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [terminalConnectionPath, setTerminalConnectionPath] = useState<"direct" | "gateway">("gateway");
  const [terminalConnectionPhase, setTerminalConnectionPhase] = useState<TerminalConnectionPhase>("connecting");
  const [terminalReconnectAttemptCount, setTerminalReconnectAttemptCount] = useState(0);
  const [terminalGatewayFallbackUsed, setTerminalGatewayFallbackUsed] = useState(false);
  const [terminalGatewayFallbackReasonCode, setTerminalGatewayFallbackReasonCode] = useState<
    "direct_socket_error_before_open" | "direct_closed_before_open" | null
  >(null);
  const [terminalGatewayFallbackReason, setTerminalGatewayFallbackReason] = useState<string | null>(null);
  const [terminalReconnectReasonCode, setTerminalReconnectReasonCode] = useState<
    "socket_error_after_open" | "closed_after_open" | null
  >(null);
  const [terminalReconnectReason, setTerminalReconnectReason] = useState<string | null>(null);
  const [terminalBlockedReason, setTerminalBlockedReason] = useState<string | null>(null);

  const setSessions = useCallback((value: SetStateAction<SessionSummary[]>) => {
    setControlPlaneState((current) => ({
      ...current,
      sessions: typeof value === "function" ? (value as (previous: SessionSummary[]) => SessionSummary[])(current.sessions) : value,
    }));
  }, []);

  const setNodes = useCallback((value: SetStateAction<NodeSummary[]>) => {
    setControlPlaneState((current) => ({
      ...current,
      nodes: typeof value === "function" ? (value as (previous: NodeSummary[]) => NodeSummary[])(current.nodes) : value,
    }));
  }, []);

  const setCurrentNodeId = useCallback((value: SetStateAction<string | null>) => {
    setControlPlaneState((current) => ({
      ...current,
      currentNodeId:
        typeof value === "function" ? (value as (previous: string | null) => string | null)(current.currentNodeId) : value,
    }));
  }, []);

  const setCurrentSessionId = useCallback((value: SetStateAction<string | null>) => {
    setControlPlaneState((current) => ({
      ...current,
      currentSessionId:
        typeof value === "function"
          ? (value as (previous: string | null) => string | null)(current.currentSessionId)
          : value,
    }));
  }, []);

  const setHistoryItems = useCallback((value: SetStateAction<HistoryConversationSummary[]>) => {
    setHistoryState((current) => ({
      ...current,
      items:
        typeof value === "function"
          ? (value as (previous: HistoryConversationSummary[]) => HistoryConversationSummary[])(current.items)
          : value,
    }));
  }, []);

  const setHistoryConnectionPath = useCallback((value: SetStateAction<"direct" | "gateway">) => {
    setHistoryState((current) => ({
      ...current,
      connectionPath:
        typeof value === "function"
          ? (value as (previous: "direct" | "gateway") => "direct" | "gateway")(current.connectionPath)
          : value,
    }));
  }, []);

  const setHistoryGatewayFallbackUsed = useCallback((value: SetStateAction<boolean>) => {
    setHistoryState((current) => ({
      ...current,
      gatewayFallbackUsed:
        typeof value === "function" ? (value as (previous: boolean) => boolean)(current.gatewayFallbackUsed) : value,
    }));
  }, []);

  const setHistoryGatewayFallbackReason = useCallback((value: SetStateAction<string | null>) => {
    setHistoryState((current) => ({
      ...current,
      gatewayFallbackReason:
        typeof value === "function"
          ? (value as (previous: string | null) => string | null)(current.gatewayFallbackReason)
          : value,
    }));
  }, []);

  const reconcileSelectedSessionId = useCallback((list: SessionSummary[], currentId: string | null): string | null => {
    if (!currentId) {
      return null;
    }
    return list.some((session) => session.id === currentId && session.hasTmuxSession) ? currentId : null;
  }, []);

  const currentSession = useMemo(() => selectCurrentSession(sessions, currentSessionId), [sessions, currentSessionId]);
  const copyModeEnabled =
    copyModeIntent === "enabled"
      ? true
      : copyModeIntent === "disabled"
        ? false
        : (currentSession?.tmuxCopyModeActive ?? false);
  const terminalInputLocked = Boolean(currentSession?.goalConfig.enabled);
  const currentNode = useMemo(
    () => selectCurrentNode({ nodes, currentNodeId, currentSession }),
    [nodes, currentNodeId, currentSession],
  );
  const currentNodeLiveSession = useMemo(
    () => resolveSessionForNode(sessions, currentNodeId),
    [sessions, currentNodeId],
  );
  const sidebarNode = useMemo(() => selectSidebarNode(nodes, currentNodeId), [nodes, currentNodeId]);
  const gatewayWsBaseUrl = useMemo(
    () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
    [],
  );
  const transportModel = useMemo(
    () => resolveAppTransportModel({
      currentNode,
      sidebarNode,
      fileAccessMode,
      terminalAccessMode,
      gatewayWsBaseUrl,
    }),
    [currentNode, sidebarNode, fileAccessMode, terminalAccessMode, gatewayWsBaseUrl],
  );
  const currentNodeGatewayTarget = transportModel.targets.currentNodeGateway;
  const goalGuardGatewayTarget = transportModel.targets.goalGuardGateway;
  const sessionManagementGatewayTarget = transportModel.targets.sessionManagementGateway;
  const eventStreamGatewayTarget = transportModel.targets.eventStreamGateway;
  const fileNodeRequestTarget = transportModel.targets.fileRead;
  const goalGuardReadTarget = transportModel.targets.goalGuardRead;
  const terminalAccessDecision = transportModel.terminal.accessDecision;
  const handleTerminalReady = useCallback((sender: ((text: string) => void) | null) => {
    senderRef.current = sender;
  }, []);
  const handleTmuxCopyModeReady = useCallback(
    (handler: ((action: TmuxCopyModeAction) => void) | null) => {
      tmuxCopyModeRef.current = handler;
    },
    [],
  );

  useEffect(() => {
    setEditingSessionTitle(false);
    setSessionTitleDraft(currentSession?.title ?? "");
  }, [currentSession?.id, currentSession?.title]);

  useEffect(() => {
    if (!currentSession) {
      return;
    }
    if (!currentNodeId || currentSession.nodeId === currentNodeId) {
      return;
    }
    setCurrentSessionId(null);
    setFlashError(null);
  }, [currentNodeId, currentSession]);

  useEffect(() => {
    setTerminalConnectionPath("gateway");
    setTerminalConnectionPhase("connecting");
    setTerminalReconnectAttemptCount(0);
    setTerminalGatewayFallbackUsed(false);
    setTerminalGatewayFallbackReasonCode(null);
    setTerminalGatewayFallbackReason(null);
    setTerminalReconnectReasonCode(null);
    setTerminalReconnectReason(null);
    setTerminalBlockedReason(null);
  }, [currentSession?.id]);

  useEffect(() => {
    setCopyModeIntent("inherit");
  }, [currentSession?.id]);

  useEffect(() => {
    if (!currentSession) {
      setCopyModeIntent("inherit");
      return;
    }
    if (copyModeIntent === "enabled" && currentSession.tmuxCopyModeActive) {
      setCopyModeIntent("inherit");
      return;
    }
    if (copyModeIntent === "disabled" && !currentSession.tmuxCopyModeActive) {
      setCopyModeIntent("inherit");
    }
  }, [copyModeIntent, currentSession]);

  const sendCopyModeAction = useCallback((action: TmuxCopyModeAction) => {
    tmuxCopyModeRef.current?.(action);
    if (action === "enter") {
      setCopyModeIntent("enabled");
      return;
    }
    if (action === "exit") {
      setCopyModeIntent("disabled");
    }
  }, []);
  const handleTerminalError = useCallback((message: string) => {
    setFlashError(message);
  }, []);
  const handleSelectNode = useCallback((nodeId: string) => {
    setCurrentNodeId(nodeId);
    setCurrentSessionId((current) => {
      if (!current) {
        return null;
      }
      const selected = sessions.find((session) => session.id === current) ?? null;
      return selected?.nodeId === nodeId ? current : null;
    });
    setFlashError(null);
  }, [sessions]);
  const handleSelectSession = useCallback((sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId) ?? null;
    if (session) {
      setCurrentNodeId(session.nodeId);
    }
    setCurrentSessionId(sessionId);
    setFlashError(null);
  }, [sessions]);
  const handleTerminalConnectionStateChange = useCallback(({
    phase,
    activePath,
    retryCount,
    fellBackToGateway,
    fallbackReasonCode,
    fallbackReason,
    reconnectReasonCode,
    reconnectReason,
    blockedReason,
  }: {
    phase: TerminalConnectionPhase;
    activePath: "direct" | "gateway";
    retryCount: number;
    fellBackToGateway: boolean;
    fallbackReasonCode: "direct_socket_error_before_open" | "direct_closed_before_open" | null;
    fallbackReason: string | null;
    reconnectReasonCode: "socket_error_after_open" | "closed_after_open" | null;
    reconnectReason: string | null;
    blockedReason: string | null;
  }) => {
    setTerminalConnectionPhase(phase);
    setTerminalConnectionPath(activePath);
    setTerminalReconnectAttemptCount(retryCount);
    setTerminalGatewayFallbackUsed(fellBackToGateway);
    setTerminalGatewayFallbackReasonCode(fallbackReasonCode);
    setTerminalGatewayFallbackReason(fallbackReason);
    setTerminalReconnectReasonCode(reconnectReasonCode);
    setTerminalReconnectReason(reconnectReason);
    setTerminalBlockedReason(blockedReason);
  }, []);

  const resetAuthenticatedState = useCallback((nextLoginError: string | null = null) => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setControlPlaneState(createInitialControlPlaneState());
    setHistoryState(createInitialHistoryState());
    setInterfaceCatalogSummary(createInitialInterfaceCatalogSummary());
    setDrawerOpen(false);
    setMobileMenuOpen(false);
    setFlashError(null);
    setEventSocketState(createInitialEventSocketState());
    setLoginError(nextLoginError);
  }, []);

  const handleAppError = useCallback(
    (error: unknown, fallbackMessage: string, unauthorizedMessage = "登录状态已失效，请重新登录。") => {
      if (isUnauthorizedError(error)) {
        resetAuthenticatedState(unauthorizedMessage);
        return;
      }
      setFlashError(describeAppError(error, fallbackMessage, interfaceCatalogSummary.runtimeMode));
    },
    [interfaceCatalogSummary.runtimeMode, resetAuthenticatedState],
  );

  const refreshAll = useCallback(async () => {
    if (!token) {
      return;
    }
    const [sessionItems, nodeItems] = await Promise.all([fetchSessions(token), fetchNodes(token)]);
    setSessions(sessionItems);
    setNodes(nodeItems);
    setCurrentNodeId((current) => resolvePreferredNodeId(sessionItems, nodeItems, current));
    setCurrentSessionId((current) => reconcileSelectedSessionId(sessionItems, current));
  }, [token, reconcileSelectedSessionId]);
  const refreshNodesOnly = useCallback(async () => {
    if (!token) {
      return;
    }
    const items = await fetchNodes(token);
    setNodes(items);
    setCurrentNodeId((current) => {
      if (current && items.some((node) => node.id === current)) {
        return current;
      }
      return items[0]?.id ?? null;
    });
  }, [token, setNodes, setCurrentNodeId]);

  useControlPlaneSync({
    token,
    eventSocketStatus: eventSocketState.status,
    refreshAll,
    refreshNodes: refreshNodesOnly,
    onError: handleAppError,
  });

  useEventSocket(
    token,
    useCallback((snapshot) => {
      setSessions(snapshot);
      setCurrentNodeId((current) => resolvePreferredNodeId(snapshot, nodes, current));
      setCurrentSessionId((current) => reconcileSelectedSessionId(snapshot, current));
    }, [nodes, reconcileSelectedSessionId]),
    useCallback((session) => {
      setSessions((current) => {
        const next = upsertSession(current, session);
        setCurrentNodeId((selectedNodeId) => resolvePreferredNodeId(next, nodes, selectedNodeId));
        setCurrentSessionId((selected) => reconcileSelectedSessionId(next, selected));
        return next;
      });
    }, [nodes, reconcileSelectedSessionId]),
    setEventSocketState,
    eventStreamGatewayTarget.wsBaseUrl,
  );

  useEffect(() => {
    if (!token || !currentNodeId) {
      setHistoryItems([]);
      setHistoryConnectionPath("gateway");
      setHistoryGatewayFallbackUsed(false);
      setHistoryGatewayFallbackReason(null);
      return;
    }
    const loadHistory = async (): Promise<HistoryConversationSummary[]> => {
      return executeNodeFirstRead({
        mode: fileAccessMode,
        directTarget: fileNodeRequestTarget,
        gatewayTarget: sessionManagementGatewayTarget,
        readDirect: () => fetchHistory(token, currentNodeId, fileNodeRequestTarget),
        readGateway: () => fetchHistory(token, currentNodeId, sessionManagementGatewayTarget),
        classifyFallbackReason: classifyDirectReadFallbackReason,
        state: {
          setPath: setHistoryConnectionPath,
          setFallbackUsed: setHistoryGatewayFallbackUsed,
          setFallbackReason: setHistoryGatewayFallbackReason,
        },
      });
    };
    void loadHistory()
      .then((items) => setHistoryItems(items))
      .catch((error) => {
        setHistoryItems([]);
        handleAppError(error, "读取历史会话失败");
      });
  }, [token, currentNodeId, handleAppError, sessionManagementGatewayTarget, fileNodeRequestTarget, fileAccessMode]);

  useEffect(() => {
    if (!token) {
      setInterfaceCatalogSummary(createInitialInterfaceCatalogSummary());
      return;
    }
    let cancelled = false;
    void fetchInterfaceCatalog(token, sessionManagementGatewayTarget)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setInterfaceCatalogSummary({
          runtimeMode: result.runtimeMode,
          items: result.items,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setInterfaceCatalogSummary(createInitialInterfaceCatalogSummary());
        handleAppError(error, "读取接口边界目录失败");
      });
    return () => {
      cancelled = true;
    };
  }, [token, sessionManagementGatewayTarget, handleAppError]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const handleUnauthorizedEvent = () => {
      resetAuthenticatedState("登录状态已失效，请重新登录。");
    };
    window.addEventListener("touchmux:unauthorized", handleUnauthorizedEvent);
    return () => {
      window.removeEventListener("touchmux:unauthorized", handleUnauthorizedEvent);
    };
  }, [token, resetAuthenticatedState]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage write failures
    }
    return () => {
      delete root.dataset.theme;
    };
  }, [theme]);

  useEffect(() => {
    if (!flashError) {
      return;
    }
    const timer = window.setTimeout(() => {
      setFlashError((current) => (current === flashError ? null : current));
    }, 4800);
    return () => window.clearTimeout(timer);
  }, [flashError]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    let stableHeight = window.visualViewport?.height ?? window.innerHeight;
    let lastWidth = window.innerWidth;

    const syncStableViewportHeight = () => {
      const nextWidth = window.innerWidth;
      const nextHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);
      const widthChanged = Math.abs(nextWidth - lastWidth) > 40;
      if (widthChanged || nextHeight >= stableHeight) {
        stableHeight = nextHeight;
      }
      lastWidth = nextWidth;
      root.style.setProperty("--touchmux-stable-app-height", `${stableHeight}px`);
    };

    syncStableViewportHeight();
    window.addEventListener("resize", syncStableViewportHeight);
    window.addEventListener("orientationchange", syncStableViewportHeight);
    window.visualViewport?.addEventListener("resize", syncStableViewportHeight);
    window.visualViewport?.addEventListener("scroll", syncStableViewportHeight);
    return () => {
      window.removeEventListener("resize", syncStableViewportHeight);
      window.removeEventListener("orientationchange", syncStableViewportHeight);
      window.visualViewport?.removeEventListener("resize", syncStableViewportHeight);
      window.visualViewport?.removeEventListener("scroll", syncStableViewportHeight);
      root.style.removeProperty("--touchmux-stable-app-height");
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await document.documentElement.requestFullscreen();
    } catch (error) {
      setFlashError(error instanceof Error ? error.message : "切换全屏失败");
    }
  }, []);

  const toggleDesktopSidebar = useCallback(() => {
    setDesktopSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem(DESKTOP_SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  const toggleNodeAccessMode = useCallback(() => {
    setTerminalAccessMode((current) => {
      const next = current === "gateway" ? "direct_preferred" : "gateway";
      localStorage.setItem(TERMINAL_ACCESS_MODE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const toggleFileAccessMode = useCallback(() => {
    setFileAccessMode((current) => {
      const next = current === "gateway" ? "direct_preferred" : "gateway";
      localStorage.setItem(FILE_ACCESS_MODE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  async function handleLogin(password: string): Promise<void> {
    try {
      setLoggingIn(true);
      const nextToken = await login(password);
      localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
      setToken(nextToken);
      setLoginError(null);
      setFlashError(null);
      setEventSocketState(createInitialEventSocketState());
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoggingIn(false);
    }
  }

  const eventSocketStatus: EventSocketStatus = eventSocketState.status;
  const eventSocketStatusLabel =
    eventSocketStatus === "open"
      ? "实时连接"
      : eventSocketStatus === "reconnecting"
        ? "重连中"
        : eventSocketStatus === "error"
          ? "连接异常"
          : "连接中";
  const eventSocketDetail =
    eventSocketState.lastError
      ?? (eventSocketStatus === "open"
        ? `${interfaceCatalogSummary.runtimeMode === "hub" ? "统一入口" : "控制面"}事件流正在同步会话快照。`
        : `正在建立${interfaceCatalogSummary.runtimeMode === "hub" ? "统一入口" : "控制面"}事件流。`);
  const interfaceBoundarySummary = useMemo(() => {
    const presentation = describeInterfaceBoundarySummary({
      runtimeMode: interfaceCatalogSummary.runtimeMode,
      items: interfaceCatalogItems,
    });
    return presentation
      ? {
          runtimeMode: interfaceCatalogSummary.runtimeMode,
          totalCount: interfaceCatalogItems.length,
          controlPlaneCount: presentation.controlPlaneCount,
          nodeFirstReadCount: presentation.nodeFirstReadCount,
          gatewayFirstWriteCount: presentation.gatewayFirstWriteCount,
          title: presentation.title,
          detail: presentation.detail,
        }
      : null;
  }, [interfaceCatalogItems, interfaceCatalogSummary.runtimeMode]);
  const interfaceCatalogMap = useMemo(
    () => new Map(interfaceCatalogItems.map((item) => [item.id, item])),
    [interfaceCatalogItems],
  );
  const terminalAccessStatusLabel = terminalAccessDecision.directAllowed ? "终端准入：允许尝试节点直连" : "终端准入：固定统一入口";
  const terminalAttachBlockedReason = useMemo(() => {
    if (!currentSession) {
      return null;
    }
    if (!currentNode) {
      return `当前会话所属节点 ${currentSession.nodeId} 未出现在节点列表中，无法附着。`;
    }
    if (currentNode.status !== "online") {
      return currentNode.error
        ? `目标节点 ${currentNode.label} 当前离线，终端附着已阻止：${currentNode.error}`
        : `目标节点 ${currentNode.label} 当前离线，终端附着已阻止。`;
    }
    if (!currentSession.hasTmuxSession || currentSession.status === "closed") {
      return `会话 ${currentSession.title} 的 tmux 运行态已结束，当前不能继续附着。`;
    }
    return null;
  }, [currentNode, currentSession]);
  const currentNodeStatusSummary = useMemo(
    () => describeCurrentNodeStatus(currentNode, currentSession),
    [currentNode, currentSession],
  );
  const terminalDiagnostics = useMemo(
    () => describeTerminalDiagnostics({
      terminalConnectionPhase,
      terminalConnectionPath,
      terminalReconnectAttemptCount,
      terminalGatewayFallbackUsed,
      terminalGatewayFallbackReason,
      terminalReconnectReason,
      terminalBlockedReason,
      terminalAttachBlockedReason,
    }),
    [
      terminalAttachBlockedReason,
      terminalBlockedReason,
      terminalConnectionPath,
      terminalConnectionPhase,
      terminalGatewayFallbackReason,
      terminalGatewayFallbackUsed,
      terminalReconnectAttemptCount,
      terminalReconnectReason,
    ],
  );
  const runtimeContextSummary = useMemo(() => {
    if (!currentSession) {
      return null;
    }
    return describeRuntimeContextState(currentSession.runtimeContextState);
  }, [currentSession]);
  const globalStatusIssue = useMemo(
    () =>
      describeGlobalStatusIssue({
        runtimeMode: interfaceCatalogSummary.runtimeMode,
        eventSocketStatus,
        eventSocketState,
        currentSession,
        currentNode,
      }),
    [currentNode, currentSession, eventSocketState, eventSocketStatus, interfaceCatalogSummary.runtimeMode],
  );

  if (!token) {
    return <LoginScreen onLogin={handleLogin} loading={loggingIn} error={loginError} />;
  }

  return (
    <main className="app-shell">
      <div className={`workspace-shell ${desktopSidebarCollapsed ? "desktop-sidebar-collapsed" : ""}`}>
        <div className={`drawer-backdrop ${drawerOpen ? "open" : ""}`} onClick={() => setDrawerOpen(false)} />
        <aside className={`session-drawer ${drawerOpen ? "open" : ""} ${desktopSidebarCollapsed ? "collapsed" : ""}`}>
          <div className="session-drawer-header">
            <div>
              <div className="eyebrow">终端</div>
              <h2>终端管理</h2>
            </div>
            <button
              type="button"
              className="ghost-button desktop-sidebar-toggle"
              onClick={() => {
                toggleDesktopSidebar();
              }}
            >
              {desktopSidebarCollapsed ? "展开" : "收起"}
            </button>
            <button
              type="button"
              className="ghost-button session-drawer-close"
              aria-label="关闭侧边栏"
              onClick={() => {
                setDrawerOpen(false);
              }}
            >
              ×
            </button>
          </div>
          <div className="session-drawer-scroll">
            <SessionSidebar
              token={token}
              nodes={nodes}
              sessions={sessions}
              historyItems={historyItems}
              currentNodeId={currentNodeId}
              currentSessionId={currentSessionId}
              onSelectNode={handleSelectNode}
              onSelectSession={handleSelectSession}
              onCloseDrawer={() => setDrawerOpen(false)}
              onCreateSession={async (payload) => {
                try {
                  const created = await createSession(token, payload, sessionManagementGatewayTarget);
                  setSessions((current) => {
                    const next = upsertSession(current, created);
                    return next;
                  });
                  setCurrentNodeId(created.nodeId);
                  await refreshAll();
                } catch (error) {
                  handleAppError(error, "创建会话失败");
                  throw error;
                }
              }}
              onCloseSession={async (sessionId, nodeId) => {
                try {
                  const updated = await closeSession(token, sessionId, nodeId, false, sessionManagementGatewayTarget);
                  setSessions((current) => {
                    const next = upsertSession(current, updated);
                    setCurrentSessionId((selected) => reconcileSelectedSessionId(next, selected));
                    return next;
                  });
                } catch (error) {
                  handleAppError(error, "关闭会话失败");
                }
              }}
              onForceCloseSession={async (sessionId, nodeId) => {
                try {
                  const updated = await overrideStop(token, sessionId, nodeId, sessionManagementGatewayTarget);
                  setSessions((current) => {
                    const next = upsertSession(current, updated);
                    setCurrentSessionId((selected) => reconcileSelectedSessionId(next, selected));
                    return next;
                  });
                } catch (error) {
                  handleAppError(error, "强制停止会话失败");
                  }
              }}
              requestOptions={sessionManagementGatewayTarget}
              historyTransportLabel={describeHistoryTransport({
                connectionPath: historyConnectionPath,
                gatewayFallbackUsed: historyGatewayFallbackUsed,
                gatewayFallbackReason: historyGatewayFallbackReason,
              })}
              interfaceBoundarySummary={interfaceBoundarySummary ?? undefined}
              />
            <Suspense fallback={<section className="panel goal-panel loading-panel">Goal Guard 组件加载中...</section>}>
              <GoalGuardEditor
                token={token}
                session={currentSession}
                readRequestOptions={goalGuardReadTarget}
                writeRequestOptions={goalGuardGatewayTarget}
                readAccessMode={fileAccessMode}
                onUpdated={(session) => {
                  setSessions((current) => upsertSession(current, session));
                }}
              />
            </Suspense>
          </div>
        </aside>

        <section className="main-console-shell">
          <header className="topbar console-topbar">
            <div className="console-topbar-main">
              <button
                type="button"
                className="drawer-toggle-button"
                onClick={() => {
                  setDrawerOpen(true);
                }}
              >
                管理终端
              </button>
              <div className="console-brand">
                <div className="eyebrow">TouchMux</div>
                <h1>远程控制台</h1>
                <div className={`connection-status-chip status-${eventSocketStatus}`}>{eventSocketStatusLabel}</div>
              </div>
              <button
                type="button"
                className="ghost-button mobile-menu-toggle"
                onClick={() => {
                  setMobileMenuOpen((current) => !current);
                }}
                aria-label="打开更多操作"
              >
                ⋯
              </button>
            </div>
            <div className="console-topbar-actions">
              {currentSession ? (
                <div className="console-session-chip">
                  <strong>{currentSession.title}</strong>
                  <span>{currentSession.cwd || "."}</span>
                </div>
              ) : null}
              <button type="button" className="ghost-button" onClick={toggleTheme}>
                {theme === "dark" ? "浅色" : "夜间"}
              </button>
              <button type="button" className="ghost-button" onClick={toggleNodeAccessMode}>
                终端链路：{terminalAccessMode === "direct_preferred" ? "直连优先" : "统一入口"}
              </button>
              <button type="button" className="ghost-button" onClick={() => void toggleFullscreen()}>
                {isFullscreen ? "退出全屏" : "全屏"}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  resetAuthenticatedState();
                }}
              >
                退出
              </button>
            </div>
            <div className={`mobile-topbar-menu ${mobileMenuOpen ? "open" : ""}`}>
              {currentSession ? (
                <div className="console-session-chip mobile-chip">
                  <strong>{currentSession.title}</strong>
                  <span>{currentSession.cwd || "."}</span>
                </div>
              ) : null}
              <div className={`connection-status-chip status-${eventSocketStatus}`}>{eventSocketStatusLabel}</div>
              <button type="button" className="ghost-button" onClick={toggleTheme}>
                {theme === "dark" ? "浅色" : "夜间"}
              </button>
              <button type="button" className="ghost-button" onClick={toggleNodeAccessMode}>
                终端链路：{terminalAccessMode === "direct_preferred" ? "直连优先" : "统一入口"}
              </button>
              <button type="button" className="ghost-button" onClick={() => void toggleFullscreen()}>
                {isFullscreen ? "退出全屏" : "全屏"}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  resetAuthenticatedState();
                }}
              >
                退出
              </button>
            </div>
          </header>

          {globalStatusIssue || flashError ? (
            <div className="status-overlay-stack" aria-live="polite">
              {globalStatusIssue ? (
                <div className={`status-banner status-banner-${globalStatusIssue.kind} status-banner-overlay`}>
                  <strong>{globalStatusIssue.title}</strong>
                  <span>{globalStatusIssue.detail}</span>
                </div>
              ) : null}
              {flashError ? <div className="flash-banner status-banner-overlay">{flashError}</div> : null}
            </div>
          ) : null}

          <div className="console-layout">
          <div className="panel terminal-panel console-panel">
            <div className="panel-header">
              <div>
                <div className="eyebrow">控制台</div>
                {currentSession ? (
                  editingSessionTitle ? (
                    <input
                      className="session-title-inline-input"
                      value={sessionTitleDraft}
                      onChange={(event) => setSessionTitleDraft(event.target.value)}
                      onBlur={() => {
                        if (!currentSession) {
                          setEditingSessionTitle(false);
                          return;
                        }
                        const nextTitle = sessionTitleDraft.trim();
                        if (!nextTitle || nextTitle === currentSession.title) {
                          setSessionTitleDraft(currentSession.title);
                          setEditingSessionTitle(false);
                          return;
                        }
                        void renameSession(token, currentSession.id, currentSession.nodeId, nextTitle, sessionManagementGatewayTarget)
                          .then((updated) => {
                            setSessions((current) => upsertSession(current, updated));
                            setEditingSessionTitle(false);
                          })
                          .catch((error) => {
                            handleAppError(error, "重命名会话失败");
                            setSessionTitleDraft(currentSession.title);
                            setEditingSessionTitle(false);
                          });
                      }}
                      onKeyDown={(event) => {
                        if (!currentSession) {
                          return;
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          setSessionTitleDraft(currentSession.title);
                          setEditingSessionTitle(false);
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      type="button"
                      className="session-title-button"
                      onClick={() => {
                        setSessionTitleDraft(currentSession.title);
                        setEditingSessionTitle(true);
                      }}
                    >
                      <h2>{currentSession.title}</h2>
                    </button>
                  )
                ) : (
                  <h2>未选择会话</h2>
                )}
                {currentNode ? <div className="session-meta">节点：{currentNode.label}</div> : null}
              </div>
                {currentSession ? (
                <div className="terminal-metadata">
                  <span>{currentSession.nodeLabel}</span>
                  <span>{currentSession.status}</span>
                  <span>{currentSession.cwd}</span>
                  <span>{currentSession.activeViewerCount} 人查看</span>
                  <span>{terminalAccessStatusLabel}</span>
                </div>
              ) : null}
            </div>

            {currentSession ? (
              <div className="terminal-diagnostics-grid">
                <section className={`terminal-diagnostic-card status-${terminalConnectionPhase === "blocked" ? "error" : terminalConnectionPhase}`}>
                  <div className="eyebrow">链路</div>
                  <strong>{terminalDiagnostics.phaseLabel}</strong>
                  <div className="session-meta">
                    {terminalDiagnostics.pathLabel}{terminalGatewayFallbackUsed ? "（已回退）" : ""} · {terminalDiagnostics.summary}
                  </div>
                </section>
                <section className={`terminal-diagnostic-card status-${currentNode?.status === "online" ? "open" : "error"}`}>
                  <div className="eyebrow">节点</div>
                  <strong>{currentNodeStatusSummary.title}</strong>
                  <div className="session-meta">{currentNodeStatusSummary.detail}</div>
                  <div className="session-meta subtle-meta">{formatLastCheckedAt(currentNode?.lastCheckedAt ?? null)}</div>
                </section>
                <section className={`terminal-diagnostic-card status-${eventSocketStatus}`}>
                  <div className="eyebrow">同步</div>
                  <strong>{eventSocketStatusLabel}</strong>
                  <div className="session-meta">{eventSocketDetail}</div>
                  {eventSocketState.retryCount > 0 ? <div className="session-meta subtle-meta">重试 {eventSocketState.retryCount} 次</div> : null}
                </section>
                {currentSession && runtimeContextSummary ? (
                  <section className={`terminal-diagnostic-card status-${runtimeContextSummary.tone}`}>
                    <div className="eyebrow">上下文</div>
                    <strong>{runtimeContextSummary.title}</strong>
                    <div className="session-meta">{currentSession.runtimeContextDetail ?? runtimeContextSummary.detail}</div>
                    <div className="session-meta subtle-meta">{formatLastCheckedAt(currentSession.runtimeContextUpdatedAt)}</div>
                  </section>
                ) : null}
              </div>
            ) : null}

            {!currentSession ? (
              <div className="console-empty-state">
                <div className="eyebrow">控制台待连接</div>
                <h3>当前未显示任何终端</h3>
                <p>
                  {currentNodeId
                    ? currentNodeLiveSession
                      ? `已切到 ${sidebarNode?.label ?? currentNodeId}，请重新选择该节点上的终端。`
                      : `${sidebarNode?.label ?? currentNodeId} 当前没有可附着终端。`
                    : "打开左侧终端栏，选择或新建一个会话。"}
                </p>
              </div>
            ) : (
              <>
                {terminalAttachBlockedReason ? <div className="error-banner inline-banner">{terminalAttachBlockedReason}</div> : null}
                <div className={`terminal-stage ${copyModeEnabled ? "copy-mode-active" : ""}`}>
                  <Suspense fallback={<div className="terminal-loading-state">终端组件加载中...</div>}>
                <TerminalPane
                  token={token}
                  nodeId={currentSession?.nodeId ?? null}
                  sessionId={deferredSessionId}
                  wsBaseUrl={terminalAccessDecision.directWsBaseUrl}
                  fallbackWsBaseUrl={gatewayWsBaseUrl}
                  preferDirectConnection={terminalAccessDecision.directAllowed}
                  blockedReason={terminalAttachBlockedReason}
                  copyModeEnabled={copyModeEnabled}
                  inputLocked={terminalInputLocked}
                  onReady={handleTerminalReady}
                  onTmuxCopyModeReady={handleTmuxCopyModeReady}
                  onError={handleTerminalError}
                  onConnectionPathChange={handleTerminalConnectionStateChange}
                />
                  </Suspense>
                </div>

                <div className="mobile-quickbar">
                  {!copyModeEnabled ? (
                    <button type="button" onClick={() => sendCopyModeAction("enter")}>
                      进入翻页模式
                    </button>
                  ) : (
                    <>
                      <button type="button" onClick={() => sendCopyModeAction("page_up")}>
                        上翻
                      </button>
                      <button type="button" onClick={() => sendCopyModeAction("page_down")}>
                        下翻
                      </button>
                      <button type="button" onClick={() => sendCopyModeAction("exit")}>
                        退出翻页模式
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => senderRef.current?.("\u001b[A")}>
                    上
                  </button>
                  <button type="button" onClick={() => senderRef.current?.("\u001b[B")}>
                    下
                  </button>
                  <button type="button" onClick={() => senderRef.current?.("\u001b")}>
                    ESC
                  </button>
                  <button type="button" onClick={() => senderRef.current?.("\r")}>
                    回车
                  </button>
                  <button type="button" onClick={() => senderRef.current?.("\u0003")}>
                    Ctrl+C
                  </button>
                  <button type="button" onClick={() => senderRef.current?.(" ")}>
                    空格
                  </button>
                </div>
              </>
            )}
          </div>

          <Suspense fallback={<section className="panel browser-dock loading-panel">文件管理组件加载中...</section>}>
            <FileBrowser
              token={token}
              nodeId={currentSession?.nodeId ?? currentNodeId}
              roots={currentNode?.roots ?? []}
              activeSessionCwd={currentSession?.cwd ?? null}
              activeSessionRoot={currentSession?.workspaceRoot ?? null}
              readRequestOptions={fileNodeRequestTarget}
              writeRequestOptions={currentNodeGatewayTarget}
              readAccessMode={fileAccessMode}
              onToggleReadAccessMode={toggleFileAccessMode}
            />
          </Suspense>
          </div>
        </section>
      </div>
    </main>
  );
}
