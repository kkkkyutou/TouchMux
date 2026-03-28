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
  const senderRef = useRef<((text: string) => void) | null>(null);
  const deferredSessionId = useDeferredValue(currentSessionId);

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  );

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
    if (!currentSessionId && sessionItems.length > 0) {
      setCurrentSessionId(sessionItems[0].id);
    }
  }, [token, currentSessionId]);

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
      if (snapshot.length > 0) {
        setCurrentSessionId((current) => current ?? snapshot[0].id);
      }
    }, []),
    useCallback((session) => {
      setSessions((current) => upsertSession(current, session));
    }, []),
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
      <header className="topbar">
        <div>
          <div className="eyebrow">TouchMux</div>
          <h1>移动远程工作台</h1>
        </div>
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
      </header>

      {flashError ? <div className="flash-banner">{flashError}</div> : null}

      <section className="main-grid">
        <SessionSidebar
          token={token}
          sessions={sessions}
          historyItems={historyItems}
          roots={roots}
          currentSessionId={currentSessionId}
          onSelectSession={setCurrentSessionId}
          onCreateSession={async (payload) => {
            const created = await createSession(token, payload);
            setSessions((current) => upsertSession(current, created));
            setCurrentSessionId(created.id);
          }}
          onCloseSession={async (sessionId) => {
            const updated = await closeSession(token, sessionId, false);
            setSessions((current) => upsertSession(current, updated));
          }}
          onForceCloseSession={async (sessionId) => {
            const updated = await overrideStop(token, sessionId);
            setSessions((current) => upsertSession(current, updated));
          }}
        />

        <section className="workbench">
          <div className="panel terminal-panel">
            <div className="panel-header">
              <div>
                <div className="eyebrow">终端</div>
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
                onReady={(sender) => {
                  senderRef.current = sender;
                }}
                onError={(message) => setFlashError(message)}
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

          <div className="secondary-grid">
            <FileBrowser
              token={token}
              roots={roots}
              activeSessionCwd={currentSession?.cwd ?? null}
              activeSessionRoot={currentSession?.workspaceRoot ?? null}
            />
            <GoalGuardEditor
              token={token}
              session={currentSession}
              onUpdated={(session) => {
                setSessions((current) => upsertSession(current, session));
              }}
            />
          </div>
        </section>
      </section>
    </main>
  );
}
