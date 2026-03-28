import { useEffect, useMemo, useState } from "react";
import { listDirectory } from "../lib/api";
import type { FileEntry, HistoryConversationSummary, SessionMode, SessionSummary, WorkspaceEntry } from "../types/api";

interface SessionSidebarProps {
  token: string;
  sessions: SessionSummary[];
  historyItems: HistoryConversationSummary[];
  roots: WorkspaceEntry[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseDrawer: () => void;
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

function formatDirectoryLabel(rootLabel: string, relativePath: string): string {
  const prefix = rootLabel.startsWith("Home") ? "~" : rootLabel;
  return relativePath === "." ? `${prefix}/` : `${prefix}/${relativePath}`;
}

export function SessionSidebar({
  token,
  sessions,
  historyItems,
  roots,
  currentSessionId,
  onSelectSession,
  onCloseDrawer,
  onCreateSession,
  onCloseSession,
  onForceCloseSession,
}: SessionSidebarProps) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SessionMode>("new");
  const [workspaceRoot, setWorkspaceRoot] = useState(roots[0]?.rootPath ?? "");
  const [directoryChain, setDirectoryChain] = useState<string[]>([]);
  const [directoryLevels, setDirectoryLevels] = useState<FileEntry[][]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const historyOptions = useMemo(() => historyItems.slice(0, 20), [historyItems]);
  const liveSessions = useMemo(() => sessions.filter((session) => session.hasTmuxSession), [sessions]);
  const rootLabelMap = useMemo(
    () => new Map(roots.map((root) => [root.rootPath, root.label])),
    [roots],
  );
  const selectedRootLabel = useMemo(
    () => roots.find((root) => root.rootPath === workspaceRoot)?.label ?? "当前根目录",
    [roots, workspaceRoot],
  );
  const cwd = directoryChain.at(-1) ?? ".";

  useEffect(() => {
    if (roots.length > 0 && !workspaceRoot) {
      setWorkspaceRoot(roots[0].rootPath);
    }
  }, [roots, workspaceRoot]);

  useEffect(() => {
    setDirectoryChain([]);
  }, [workspaceRoot]);

  useEffect(() => {
    if (!token || !workspaceRoot) {
      return;
    }
    let cancelled = false;
    async function loadDirectoryLevels(): Promise<void> {
      try {
        setDirectoryLoading(true);
        const paths = [".", ...directoryChain];
        const results = await Promise.all(
          paths.map((relativePath) => listDirectory(token, workspaceRoot, relativePath)),
        );
        if (cancelled) {
          return;
        }
        setDirectoryLevels(
          results.map((items) => items.filter((entry) => entry.type === "directory")),
        );
        setDirectoryError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setDirectoryError(error instanceof Error ? error.message : "目录读取失败");
      } finally {
        if (!cancelled) {
          setDirectoryLoading(false);
        }
      }
    }
    void loadDirectoryLevels();
    return () => {
      cancelled = true;
    };
  }, [token, workspaceRoot, directoryChain]);

  return (
    <div className="drawer-section session-sidebar">
      <div className="drawer-section-header">
        <div>
          <div className="eyebrow">Codex</div>
          <h2>管理终端</h2>
          <div className="session-meta">当前运行中的会话会显示在这里，点一下即可切回控制台。</div>
        </div>
      </div>

      <div className="session-list">
        {liveSessions.length === 0 ? <div className="session-meta">当前没有运行中的 Codex 终端。</div> : null}
        {liveSessions.map((session) => (
          <article
            key={session.id}
            className={`session-card ${currentSessionId === session.id ? "active" : ""}`}
          >
            <button
              type="button"
              className="session-card-main"
              onClick={() => {
                onSelectSession(session.id);
                onCloseDrawer();
              }}
            >
              <div className="session-card-top">
                <strong>{session.title}</strong>
                <span className={`status-pill status-${session.status}`}>{session.status}</span>
              </div>
              <div className="session-meta">
                {formatDirectoryLabel(rootLabelMap.get(session.workspaceRoot) ?? "当前根目录", session.cwd)}
              </div>
              <div className="session-preview">{session.lastOutputPreview || "尚无输出"}</div>
            </button>
            <div className="session-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  onSelectSession(session.id);
                  onCloseDrawer();
                }}
              >
                显示
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void onCloseSession(session.id);
                }}
              >
                关闭
              </button>
              <button
                type="button"
                className="ghost-button danger"
                onClick={() => {
                  void onForceCloseSession(session.id);
                }}
              >
                删除终端
              </button>
            </div>
          </article>
        ))}
      </div>

      <form
        className="session-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitting(true);
          setSubmitError(null);
          void onCreateSession({
            title: title || `${mode === "new" ? "新建" : mode === "resume" ? "恢复" : "Fork"} 会话`,
            workspaceRoot,
            cwd,
            mode,
            prompt: prompt || undefined,
            sourceCodexSessionId: sourceId || undefined,
          })
            .then(() => {
              setTitle("");
              setPrompt("");
              setDirectoryChain([]);
              onCloseDrawer();
            })
            .catch((error) => {
              setSubmitError(error instanceof Error ? error.message : "创建会话失败");
            })
            .finally(() => {
              setSubmitting(false);
            });
        }}
      >
        <div className="drawer-section-header">
          <div>
            <div className="eyebrow">新建</div>
            <h2>创建 Codex 终端</h2>
          </div>
        </div>
        {submitError ? <div className="error-banner">{submitError}</div> : null}
        <div className="inline-grid">
          <label>
            标题
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="比如：修复终端附着" />
          </label>
          <label>
            模式
            <select value={mode} onChange={(event) => setMode(event.target.value as SessionMode)}>
              <option value="new">新建</option>
              <option value="resume">恢复已有 Codex 会话</option>
              <option value="fork">Fork 已有 Codex 会话</option>
            </select>
          </label>
          <label>
            工作根目录
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
          工作根目录
          <select value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)}>
            {roots.map((root) => (
              <option key={root.rootPath} value={root.rootPath}>
                {root.label}
              </option>
            ))}
          </select>
        </label>
        <div className="directory-picker">
          <div className="directory-picker-summary">
            <strong>启动目录</strong>
            <span className="session-meta">{formatDirectoryLabel(selectedRootLabel, cwd)}</span>
          </div>
          <div className="directory-picker-top">
            <span className="session-meta">从根目录开始，逐级选择子目录。</span>
            {directoryLoading ? <span className="session-meta">读取中...</span> : null}
          </div>
          <div className="directory-chain">
            {directoryLevels.map((level, index) => (
              <label key={`level-${index}`}>
                {index === 0 ? "第 1 级子目录" : `第 ${index + 1} 级子目录`}
                <select
                  value={directoryChain[index] ?? ""}
                  onChange={(event) => {
                    const nextPath = event.target.value;
                    if (!nextPath) {
                      setDirectoryChain((current) => current.slice(0, index));
                      return;
                    }
                    setDirectoryChain((current) => [...current.slice(0, index), nextPath]);
                  }}
                >
                  <option value="">{index === 0 ? "保持在根目录" : "停在当前层级"}</option>
                  {level.map((entry) => (
                    <option key={entry.path} value={entry.path}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="file-entry-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setDirectoryChain([]);
              }}
            >
              回到根目录
            </button>
          </div>
          <input value={cwd} readOnly aria-label="选中的启动目录" />
          {directoryError ? <div className="error-banner">{directoryError}</div> : null}
        </div>
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
        <button type="submit" disabled={submitting || !workspaceRoot || (mode !== "new" && !sourceId)}>
          {submitting
            ? "处理中..."
            : mode === "new"
              ? "创建并启动"
              : mode === "resume"
                ? "恢复到新 tmux"
                : "Fork 到新 tmux"}
        </button>
      </form>
    </div>
  );
}
