import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FileBrowser } from "./components/FileBrowser";
import { GoalGuardEditor } from "./components/GoalGuardEditor";
import { LoginScreen } from "./components/LoginScreen";
import { SessionSidebar } from "./components/SessionSidebar";
import { TerminalPane } from "./components/TerminalPane";
import {
  closeSession,
  createSession,
  fetchHistory,
  fetchRoots,
  fetchSessions,
  login,
  overrideStop,
} from "./lib/api";
import { useEventSocket } from "./hooks/useEventSocket";
import type { HistoryConversationSummary, SessionSummary, WorkspaceEntry } from "./types/api";

const TOKEN_STORAGE_KEY = "touchmux-token";

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
  const [historyItems, setHistoryItems] = useState<HistoryConversationSummary[]>([]);
  const [roots, setRoots] = useState<WorkspaceEntry[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const senderRef = useRef<((text: string) => void) | null>(null);
  const deferredSessionId = useDeferredValue(currentSessionId);

  const pickPreferredSessionId = useCallback(
    (list: SessionSummary[], currentId: string | null): string | null => {
      const active = list.filter((session) => session.hasTmuxSession);
      if (currentId && active.some((session) => session.id === currentId)) {
        return currentId;
      }
      return active[0]?.id ?? list[0]?.id ?? null;
    },
    [],
  );

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  );
  const handleTerminalReady = useCallback((sender: ((text: string) => void) | null) => {
    senderRef.current = sender;
  }, []);
  const handleTerminalError = useCallback((message: string) => {
    setFlashError(message);
  }, []);

  const refreshAll = useCallback(async () => {
    if (!token) {
      return;
    }
    const [sessionItems, history, workspaceRoots] = await Promise.all([
      fetchSessions(token),
      fetchHistory(token),
      fetchRoots(token),
    ]);
    setSessions(sessionItems);
    setHistoryItems(history);
    setRoots(workspaceRoots);
    setCurrentSessionId((current) => pickPreferredSessionId(sessionItems, current));
  }, [token, pickPreferredSessionId]);

  useEffect(() => {
    if (!token) {
      return;
    }
    void refreshAll().catch((error) => {
      setFlashError(error instanceof Error ? error.message : "初始化失败");
    });
  }, [token, refreshAll]);

  useEventSocket(
    token,
    useCallback((snapshot) => {
      setSessions(snapshot);
      setCurrentSessionId((current) => pickPreferredSessionId(snapshot, current));
    }, [pickPreferredSessionId]),
    useCallback((session) => {
      setSessions((current) => {
        const next = upsertSession(current, session);
        setCurrentSessionId((selected) => pickPreferredSessionId(next, selected));
        return next;
      });
    }, [pickPreferredSessionId]),
  );

  async function handleLogin(password: string): Promise<void> {
    try {
      setLoggingIn(true);
      const nextToken = await login(password);
      localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
      setToken(nextToken);
      setLoginError(null);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoggingIn(false);
    }
  }

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
            管理 Codex
          </button>
          <div>
            <div className="eyebrow">TouchMux</div>
            <h1>移动远程控制台</h1>
          </div>
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
              localStorage.removeItem(TOKEN_STORAGE_KEY);
              setToken(null);
              setSessions([]);
              setCurrentSessionId(null);
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
            </div>
            {currentSession ? (
              <div className="terminal-metadata">
                <span>{currentSession.status}</span>
                <span>{currentSession.cwd}</span>
              </div>
            ) : null}
          </div>

          <div className="terminal-stage">
            <TerminalPane
              token={token}
              sessionId={deferredSessionId}
              onReady={handleTerminalReady}
              onError={handleTerminalError}
            />
            {currentSession?.choiceOverlay.visible ? (
              <div className="choice-overlay">
                <div className="overlay-title">检测到可点击选择项</div>
                <div className="overlay-actions">
                  {currentSession.choiceOverlay.options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => senderRef.current?.(option.send)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
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
        </div>

        <FileBrowser
          token={token}
          roots={roots}
          activeSessionCwd={currentSession?.cwd ?? null}
          activeSessionRoot={currentSession?.workspaceRoot ?? null}
        />
      </section>

      <div className={`drawer-backdrop ${drawerOpen ? "open" : ""}`} onClick={() => setDrawerOpen(false)} />
      <aside className={`session-drawer ${drawerOpen ? "open" : ""}`}>
        <div className="session-drawer-header">
          <div>
            <div className="eyebrow">Codex</div>
            <h2>会话与配置</h2>
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
          <SessionSidebar
            token={token}
            sessions={sessions}
            historyItems={historyItems}
            roots={roots}
            currentSessionId={currentSessionId}
            onSelectSession={setCurrentSessionId}
            onCloseDrawer={() => setDrawerOpen(false)}
            onCreateSession={async (payload) => {
              const created = await createSession(token, payload);
              setSessions((current) => {
                const next = upsertSession(current, created);
                return next;
              });
              setCurrentSessionId(created.id);
            }}
            onCloseSession={async (sessionId) => {
              const updated = await closeSession(token, sessionId, false);
              setSessions((current) => {
                const next = upsertSession(current, updated);
                setCurrentSessionId((selected) => pickPreferredSessionId(next, selected));
                return next;
              });
            }}
            onForceCloseSession={async (sessionId) => {
              const updated = await overrideStop(token, sessionId);
              setSessions((current) => {
                const next = upsertSession(current, updated);
                setCurrentSessionId((selected) => pickPreferredSessionId(next, selected));
                return next;
              });
            }}
          />
          <GoalGuardEditor
            token={token}
            session={currentSession}
            onUpdated={(session) => {
              setSessions((current) => upsertSession(current, session));
            }}
          />
        </div>
      </aside>
    </main>
  );
}
