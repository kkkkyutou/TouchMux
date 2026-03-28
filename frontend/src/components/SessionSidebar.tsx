import { useMemo, useState } from "react";
import type { HistoryConversationSummary, SessionMode, SessionSummary, WorkspaceEntry } from "../types/api";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  historyItems: HistoryConversationSummary[];
  roots: WorkspaceEntry[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (payload: {
    title: string;
    workspaceRoot: string;
    cwd: string;
    mode: SessionMode;
    prompt?: string;
    sourceCodexSessionId?: string;
  }) => Promise<void>;
  onCloseSession: (sessionId: string) => Promise<void>;
  onForceCloseSession: (sessionId: string) => Promise<void>;
}

export function SessionSidebar({
  sessions,
  historyItems,
  roots,
  currentSessionId,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  onForceCloseSession,
}: SessionSidebarProps) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SessionMode>("new");
  const [workspaceRoot, setWorkspaceRoot] = useState(roots[0]?.rootPath ?? "");
  const [cwd, setCwd] = useState(".");
  const [prompt, setPrompt] = useState("");
  const [sourceId, setSourceId] = useState("");

  const historyOptions = useMemo(() => historyItems.slice(0, 20), [historyItems]);

  return (
    <aside className="panel session-sidebar">
      <div className="panel-header">
        <div>
          <div className="eyebrow">会话</div>
          <h2>Codex / tmux</h2>
        </div>
      </div>

      <form
        className="session-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreateSession({
            title: title || `${mode === "new" ? "新建" : mode === "resume" ? "恢复" : "Fork"} 会话`,
            workspaceRoot,
            cwd,
            mode,
            prompt: prompt || undefined,
            sourceCodexSessionId: sourceId || undefined,
          }).then(() => {
            setTitle("");
            setPrompt("");
          });
        }}
      >
        <label>
          标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="比如：调试 TouchMux" />
        </label>
        <div className="inline-grid">
          <label>
            模式
            <select value={mode} onChange={(event) => setMode(event.target.value as SessionMode)}>
              <option value="new">新建</option>
              <option value="resume">恢复已有 Codex 会话</option>
              <option value="fork">Fork 已有 Codex 会话</option>
            </select>
          </label>
          <label>
            工作区
            <select value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)}>
              {roots.map((root) => (
                <option key={root.rootPath} value={root.rootPath}>
                  {root.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          相对目录
          <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="." />
        </label>
        {mode !== "new" ? (
          <label>
            源 Codex Session
            <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              <option value="">请选择</option>
              {historyOptions.map((item) => (
                <option key={item.sessionId} value={item.sessionId}>
                  {item.sessionId.slice(0, 8)} · {new Date(item.lastUpdatedAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          初始提示
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="可选。新建时作为初始 prompt，恢复/fork 时作为跟进 prompt。"
            rows={3}
          />
        </label>
        <button type="submit" disabled={!workspaceRoot || (mode !== "new" && !sourceId)}>
          {mode === "new" ? "创建并启动" : mode === "resume" ? "恢复到新 tmux" : "Fork 到新 tmux"}
        </button>
      </form>

      <div className="session-list">
        {sessions.map((session) => (
          <article
            key={session.id}
            className={`session-card ${currentSessionId === session.id ? "active" : ""}`}
            onClick={() => onSelectSession(session.id)}
          >
            <div className="session-card-top">
              <strong>{session.title}</strong>
              <span className={`status-pill status-${session.status}`}>{session.status}</span>
            </div>
            <div className="session-meta">{session.cwd}</div>
            <div className="session-preview">{session.lastOutputPreview || "尚无输出"}</div>
            <div className="session-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={(event) => {
                  event.stopPropagation();
                  void onCloseSession(session.id);
                }}
              >
                关闭
              </button>
              <button
                type="button"
                className="ghost-button danger"
                onClick={(event) => {
                  event.stopPropagation();
                  void onForceCloseSession(session.id);
                }}
              >
                强停
              </button>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}
