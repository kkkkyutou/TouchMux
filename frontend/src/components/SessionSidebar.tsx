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

function parentPath(value: string): string {
  if (!value || value === ".") {
    return ".";
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return ".";
  }
  return parts.slice(0, -1).join("/");
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
  onCreateSession,
  onCloseSession,
  onForceCloseSession,
}: SessionSidebarProps) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SessionMode>("new");
  const [workspaceRoot, setWorkspaceRoot] = useState(roots[0]?.rootPath ?? "");
  const [cwd, setCwd] = useState(".");
  const [directoryBrowsePath, setDirectoryBrowsePath] = useState(".");
  const [directoryEntries, setDirectoryEntries] = useState<FileEntry[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sourceId, setSourceId] = useState("");

  const historyOptions = useMemo(() => historyItems.slice(0, 20), [historyItems]);
  const selectedRootLabel = useMemo(
    () => roots.find((root) => root.rootPath === workspaceRoot)?.label ?? "当前根目录",
    [roots, workspaceRoot],
  );
  const directoryOptions = useMemo(
    () => directoryEntries.filter((entry) => entry.type === "directory"),
    [directoryEntries],
  );

  useEffect(() => {
    if (roots.length > 0 && !workspaceRoot) {
      setWorkspaceRoot(roots[0].rootPath);
    }
  }, [roots, workspaceRoot]);

  useEffect(() => {
    setCwd(".");
    setDirectoryBrowsePath(".");
  }, [workspaceRoot]);

  useEffect(() => {
    if (!token || !workspaceRoot) {
      return;
    }
    let cancelled = false;
    async function loadDirectories(): Promise<void> {
      try {
        setDirectoryLoading(true);
        const items = await listDirectory(token, workspaceRoot, directoryBrowsePath);
        if (cancelled) {
          return;
        }
        setDirectoryEntries(items);
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
    void loadDirectories();
    return () => {
      cancelled = true;
    };
  }, [token, workspaceRoot, directoryBrowsePath]);

  return (
    <aside className="panel session-sidebar">
      <div className="panel-header">
        <div>
          <div className="eyebrow">会话</div>
          <h2>Codex / tmux</h2>
          <div className="session-meta">直接访问现有工作环境，不强制单独工作区。</div>
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
        <div className="directory-picker">
          <div className="directory-picker-top">
            <strong>启动目录</strong>
            <span className="session-meta">当前选中：{formatDirectoryLabel(selectedRootLabel, cwd)}</span>
          </div>
          <div className="directory-picker-top">
            <span className="session-meta">当前浏览：{formatDirectoryLabel(selectedRootLabel, directoryBrowsePath)}</span>
            {directoryLoading ? <span className="session-meta">读取中...</span> : null}
          </div>
          <div className="file-entry-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setCwd(directoryBrowsePath);
              }}
            >
              使用当前目录
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={directoryBrowsePath === "."}
              onClick={() => {
                setDirectoryBrowsePath(parentPath(directoryBrowsePath));
              }}
            >
              上一级
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={directoryBrowsePath === "."}
              onClick={() => {
                setDirectoryBrowsePath(".");
              }}
            >
              回到根目录
            </button>
          </div>
          <select
            value=""
            onChange={(event) => {
              const nextPath = event.target.value;
              if (!nextPath) {
                return;
              }
              setDirectoryBrowsePath(nextPath);
              setCwd(nextPath);
            }}
          >
            <option value="">{directoryOptions.length > 0 ? "点此选择当前层级的子目录" : "当前层级没有子目录"}</option>
            {directoryOptions.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.name}
              </option>
            ))}
          </select>
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
