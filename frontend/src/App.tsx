import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen } from "./components/LoginScreen";
import { SessionSidebar } from "./components/SessionSidebar";
import {
  closeSession,
  createSession,
  fetchHistory,
  fetchNodes,
  fetchSessions,
  isUnauthorizedError,
  login,
  overrideStop,
} from "./lib/api";
import { useEventSocket, type EventSocketStatus } from "./hooks/useEventSocket";
import type { HistoryConversationSummary, NodeSummary, SessionSummary } from "./types/api";

const TOKEN_STORAGE_KEY = "touchmux-token";
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

function upsertSession(list: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const existing = list.findIndex((item) => item.id === next.id);
  if (existing === -1) {
    return [next, ...list].sort((left, right) => right.updatedAt - left.updatedAt);
  }
  const copy = [...list];
  copy[existing] = next;
  return copy.sort((left, right) => right.updatedAt - left.updatedAt);
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_STORAGE_KEY));
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryConversationSummary[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [eventSocketStatus, setEventSocketStatus] = useState<EventSocketStatus>("connecting");
  const senderRef = useRef<((text: string) => void) | null>(null);
  const deferredSessionId = useDeferredValue(currentSessionId);

  const reconcileSelectedSessionId = useCallback((list: SessionSummary[], currentId: string | null): string | null => {
    if (!currentId) {
      return null;
    }
    return list.some((session) => session.id === currentId && session.hasTmuxSession) ? currentId : null;
  }, []);

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  );
  const currentNode = useMemo(
    () => nodes.find((node) => node.id === (currentSession?.nodeId ?? currentNodeId)) ?? null,
    [nodes, currentNodeId, currentSession?.nodeId],
  );
  const sidebarNode = useMemo(
    () => nodes.find((node) => node.id === currentNodeId) ?? null,
    [nodes, currentNodeId],
  );
  const handleTerminalReady = useCallback((sender: ((text: string) => void) | null) => {
    senderRef.current = sender;
  }, []);
  const handleTerminalError = useCallback((message: string) => {
    setFlashError(message);
  }, []);

  const resetAuthenticatedState = useCallback((nextLoginError: string | null = null) => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setSessions([]);
    setNodes([]);
    setHistoryItems([]);
    setCurrentNodeId(null);
    setCurrentSessionId(null);
    setDrawerOpen(false);
    setMobileMenuOpen(false);
    setFlashError(null);
    setEventSocketStatus("connecting");
    setLoginError(nextLoginError);
  }, []);

  const handleAppError = useCallback(
    (error: unknown, fallbackMessage: string, unauthorizedMessage = "登录状态已失效，请重新登录。") => {
      if (isUnauthorizedError(error)) {
        resetAuthenticatedState(unauthorizedMessage);
        return;
      }
      setFlashError(error instanceof Error ? error.message : fallbackMessage);
    },
    [resetAuthenticatedState],
  );

  const refreshAll = useCallback(async () => {
    if (!token) {
      return;
    }
    const [sessionItems, nodeItems] = await Promise.all([fetchSessions(token), fetchNodes(token)]);
    setSessions(sessionItems);
    setNodes(nodeItems);
    setCurrentNodeId((current) => {
      if (current && nodeItems.some((node) => node.id === current)) {
        return current;
      }
      return nodeItems[0]?.id ?? null;
    });
    setCurrentSessionId((current) => reconcileSelectedSessionId(sessionItems, current));
  }, [token, reconcileSelectedSessionId]);

  useEffect(() => {
    if (!token) {
      return;
    }
    void refreshAll().catch((error) => {
      handleAppError(error, "初始化失败");
    });
  }, [token, refreshAll, handleAppError]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetchNodes(token)
        .then((items) => {
          setNodes(items);
          setCurrentNodeId((current) => {
            if (current && items.some((node) => node.id === current)) {
              return current;
            }
            return items[0]?.id ?? null;
          });
        })
        .catch((error) => {
          handleAppError(error, "节点列表刷新失败");
        });
    }, 10000);
    return () => window.clearInterval(timer);
  }, [token, handleAppError]);

  useEventSocket(
    token,
    useCallback((snapshot) => {
      setSessions(snapshot);
      setCurrentSessionId((current) => reconcileSelectedSessionId(snapshot, current));
    }, [reconcileSelectedSessionId]),
    useCallback((session) => {
      setSessions((current) => {
        const next = upsertSession(current, session);
        setCurrentSessionId((selected) => reconcileSelectedSessionId(next, selected));
        return next;
      });
    }, [reconcileSelectedSessionId]),
    setEventSocketStatus,
  );

  useEffect(() => {
    if (!token || !currentNodeId) {
      setHistoryItems([]);
      return;
    }
    void fetchHistory(token, currentNodeId)
      .then((items) => setHistoryItems(items))
      .catch((error) => {
        setHistoryItems([]);
        handleAppError(error, "读取历史会话失败");
      });
  }, [token, currentNodeId, handleAppError]);

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

  async function handleLogin(password: string): Promise<void> {
    try {
      setLoggingIn(true);
      const nextToken = await login(password);
      localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
      setToken(nextToken);
      setLoginError(null);
      setFlashError(null);
      setEventSocketStatus("connecting");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoggingIn(false);
    }
  }

  const eventSocketStatusLabel =
    eventSocketStatus === "open"
      ? "实时连接已建立"
      : eventSocketStatus === "reconnecting"
        ? "实时连接重连中"
        : eventSocketStatus === "error"
          ? "实时连接异常"
          : "实时连接中";

  if (!token) {
    return <LoginScreen onLogin={handleLogin} loading={loggingIn} error={loginError} />;
  }

  return (
    <main className="app-shell">
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
            <h1>移动远程控制台</h1>
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

      {flashError ? <div className="flash-banner">{flashError}</div> : null}

      <section className="console-layout">
        <div className="panel terminal-panel console-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">控制台</div>
              <h2>{currentSession?.title ?? "未选择会话"}</h2>
              {currentNode ? <div className="session-meta">节点：{currentNode.label}</div> : null}
            </div>
            {currentSession ? (
              <div className="terminal-metadata">
                <span>{currentSession.nodeLabel}</span>
                <span>{currentSession.status}</span>
                <span>{currentSession.cwd}</span>
              </div>
            ) : null}
          </div>

          {!currentSession ? (
            <div className="console-empty-state">
              <div className="eyebrow">控制台待连接</div>
              <h3>当前未显示任何终端</h3>
              <p>点击左上角“管理终端”，从已有终端里选择一个，或者先新建终端。</p>
            </div>
          ) : (
            <>
              <div className="terminal-stage">
                <Suspense fallback={<div className="terminal-loading-state">终端组件加载中...</div>}>
                  <TerminalPane
                    token={token}
                    nodeId={currentSession?.nodeId ?? null}
                    sessionId={deferredSessionId}
                    onReady={handleTerminalReady}
                    onError={handleTerminalError}
                  />
                </Suspense>
              </div>

              <div className="mobile-quickbar">
                <button type="button" onClick={() => senderRef.current?.("\u001b[A")}>
                  上
                </button>
                <button type="button" onClick={() => senderRef.current?.("\u001b[B")}>
                  下
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
          />
        </Suspense>
      </section>

      <div className={`drawer-backdrop ${drawerOpen ? "open" : ""}`} onClick={() => setDrawerOpen(false)} />
      <aside className={`session-drawer ${drawerOpen ? "open" : ""}`}>
        <div className="session-drawer-header">
          <div>
            <div className="eyebrow">终端</div>
            <h2>终端管理</h2>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setDrawerOpen(false);
            }}
          >
            关闭
          </button>
        </div>
        <div className="session-drawer-scroll">
          <Suspense fallback={<section className="panel goal-panel loading-panel">Goal Guard 组件加载中...</section>}>
            <GoalGuardEditor
              token={token}
              session={currentSession}
              onUpdated={(session) => {
                setSessions((current) => upsertSession(current, session));
              }}
            />
          </Suspense>
          <SessionSidebar
            token={token}
            nodes={nodes}
            sessions={sessions}
            historyItems={historyItems}
            currentNodeId={currentNodeId}
            currentSessionId={currentSessionId}
            onSelectNode={setCurrentNodeId}
            onSelectSession={(sessionId) => {
              const session = sessions.find((item) => item.id === sessionId);
              if (session) {
                setCurrentNodeId(session.nodeId);
              }
              setCurrentSessionId(sessionId);
            }}
            onCloseDrawer={() => setDrawerOpen(false)}
            onCreateSession={async (payload) => {
              try {
                const created = await createSession(token, payload);
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
                const updated = await closeSession(token, sessionId, nodeId, false);
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
                const updated = await overrideStop(token, sessionId, nodeId);
                setSessions((current) => {
                  const next = upsertSession(current, updated);
                  setCurrentSessionId((selected) => reconcileSelectedSessionId(next, selected));
                  return next;
                });
              } catch (error) {
                handleAppError(error, "强制停止会话失败");
                }
              }}
            />
        </div>
      </aside>
    </main>
  );
}
