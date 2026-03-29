import { useEffect, useMemo, useState } from "react";
import { listDirectory } from "../lib/api";
import type { FileEntry, HistoryConversationSummary, NodeSummary, SessionMode, SessionSummary } from "../types/api";

interface SessionSidebarProps {
  token: string;
  nodes: NodeSummary[];
  sessions: SessionSummary[];
  historyItems: HistoryConversationSummary[];
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseDrawer: () => void;
  onCreateSession: (payload: {
    nodeId: string;
    title: string;
    workspaceRoot: string;
    cwd: string;
    mode: SessionMode;
    prompt?: string;
    sourceCodexSessionId?: string;
  }) => Promise<void>;
  onCloseSession: (sessionId: string, nodeId: string) => Promise<void>;
  onForceCloseSession: (sessionId: string, nodeId: string) => Promise<void>;
}

function formatDirectoryLabel(rootLabel: string, relativePath: string): string {
  const prefix = rootLabel.startsWith("Home") ? "~" : rootLabel;
  return relativePath === "." ? `${prefix}/` : `${prefix}/${relativePath}`;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!normalized || normalized === "." || normalized === "/") {
    return ".";
  }
  return normalized.replace(/^\.?\//, "").replace(/\/$/, "") || ".";
}

function parentRelativePath(value: string): string {
  const normalized = normalizeRelativePath(value);
  if (normalized === ".") {
    return ".";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return ".";
  }
  return segments.slice(0, -1).join("/");
}

function parsePathInput(input: string, workspaceRoot: string, rootLabel: string): string {
  const trimmed = input.trim();
  const displayPrefix = rootLabel.startsWith("Home") ? "~" : rootLabel;
  if (!trimmed || trimmed === displayPrefix || trimmed === `${displayPrefix}/`) {
    return ".";
  }
  if (displayPrefix === "~" && (trimmed === "~" || trimmed === "~/")) {
    return ".";
  }
  if (displayPrefix === "~" && trimmed.startsWith("~/")) {
    return normalizeRelativePath(trimmed.slice(2));
  }
  if (trimmed.startsWith(`${displayPrefix}/`)) {
    return normalizeRelativePath(trimmed.slice(displayPrefix.length + 1));
  }
  if (trimmed === workspaceRoot || trimmed === `${workspaceRoot}/`) {
    return ".";
  }
  if (trimmed.startsWith(`${workspaceRoot}/`)) {
    return normalizeRelativePath(trimmed.slice(workspaceRoot.length + 1));
  }
  if (trimmed.startsWith("/")) {
    throw new Error("输入路径超出当前允许根目录");
  }
  return normalizeRelativePath(trimmed);
}

function parsePathDraftForSuggestions(
  input: string,
  workspaceRoot: string,
  rootLabel: string,
): { basePath: string; partialName: string } | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  const displayPrefix = rootLabel.startsWith("Home") ? "~" : rootLabel;
  let relativeDraft = trimmed;

  if (!relativeDraft || relativeDraft === displayPrefix || relativeDraft === `${displayPrefix}/`) {
    return { basePath: ".", partialName: "" };
  }
  if (displayPrefix === "~" && (relativeDraft === "~" || relativeDraft === "~/")) {
    return { basePath: ".", partialName: "" };
  }
  if (displayPrefix === "~" && relativeDraft.startsWith("~/")) {
    relativeDraft = relativeDraft.slice(2);
  } else if (relativeDraft.startsWith(`${displayPrefix}/`)) {
    relativeDraft = relativeDraft.slice(displayPrefix.length + 1);
  } else if (relativeDraft === workspaceRoot || relativeDraft === `${workspaceRoot}/`) {
    return { basePath: ".", partialName: "" };
  } else if (relativeDraft.startsWith(`${workspaceRoot}/`)) {
    relativeDraft = relativeDraft.slice(workspaceRoot.length + 1);
  } else if (relativeDraft.startsWith("/")) {
    return null;
  }

  const compact = relativeDraft.replace(/\/+/g, "/");
  if (!compact) {
    return { basePath: ".", partialName: "" };
  }
  const normalized = compact.replace(/^\.?\//, "");
  if (!normalized) {
    return { basePath: ".", partialName: "" };
  }
  if (normalized.endsWith("/")) {
    return {
      basePath: normalizeRelativePath(normalized),
      partialName: "",
    };
  }

  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex === -1) {
    return { basePath: ".", partialName: normalized };
  }
  return {
    basePath: normalizeRelativePath(normalized.slice(0, slashIndex)),
    partialName: normalized.slice(slashIndex + 1),
  };
}

export function SessionSidebar({
  token,
  nodes,
  sessions,
  historyItems,
  currentNodeId,
  onSelectNode,
  currentSessionId,
  onSelectSession,
  onCloseDrawer,
  onCreateSession,
  onCloseSession,
  onForceCloseSession,
}: SessionSidebarProps) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SessionMode>("new");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [directoryPath, setDirectoryPath] = useState(".");
  const [childDirectories, setChildDirectories] = useState<FileEntry[]>([]);
  const [pathDraft, setPathDraft] = useState("");
  const [pathSuggestions, setPathSuggestions] = useState<FileEntry[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const historyOptions = useMemo(() => historyItems.slice(0, 20), [historyItems]);
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === currentNodeId) ?? null,
    [nodes, currentNodeId],
  );
  const roots = selectedNode?.roots ?? [];
  const liveSessions = useMemo(
    () => sessions.filter((session) => session.hasTmuxSession && session.nodeId === currentNodeId),
    [sessions, currentNodeId],
  );
  const rootLabelMap = useMemo(
    () => new Map(roots.map((root) => [root.rootPath, root.label])),
    [roots],
  );
  const selectedRootLabel = useMemo(
    () => roots.find((root) => root.rootPath === workspaceRoot)?.label ?? "当前根目录",
    [roots, workspaceRoot],
  );
  const cwd = directoryPath;
  const selectedDirectoryLabel = formatDirectoryLabel(selectedRootLabel, cwd);

  useEffect(() => {
    if (roots.length === 0) {
      setWorkspaceRoot("");
      return;
    }
    if (!workspaceRoot || !roots.some((root) => root.rootPath === workspaceRoot)) {
      setWorkspaceRoot(roots[0].rootPath);
    }
  }, [roots, workspaceRoot]);

  useEffect(() => {
    setDirectoryPath(".");
    setPathDraft(formatDirectoryLabel(selectedRootLabel, "."));
    setSourceId("");
  }, [workspaceRoot, selectedRootLabel]);

  useEffect(() => {
    setPathDraft(selectedDirectoryLabel);
  }, [selectedDirectoryLabel]);

  useEffect(() => {
    if (!token || !currentNodeId || !workspaceRoot || !showCreateForm) {
      return;
    }
    let cancelled = false;
    const nodeId = currentNodeId;
    async function loadCurrentDirectories(): Promise<void> {
      try {
        setDirectoryLoading(true);
        const items = await listDirectory(token, nodeId, workspaceRoot, cwd);
        if (cancelled) {
          return;
        }
        setChildDirectories(items.filter((entry) => entry.type === "directory"));
        setDirectoryError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setChildDirectories([]);
        setDirectoryError(error instanceof Error ? error.message : "目录读取失败");
      } finally {
        if (!cancelled) {
          setDirectoryLoading(false);
        }
      }
    }
    void loadCurrentDirectories();
    return () => {
      cancelled = true;
    };
  }, [token, currentNodeId, workspaceRoot, cwd, showCreateForm]);

  useEffect(() => {
    if (!token || !currentNodeId || !workspaceRoot || !showCreateForm) {
      return;
    }
    const context = parsePathDraftForSuggestions(pathDraft, workspaceRoot, selectedRootLabel);
    if (!context) {
      setPathSuggestions([]);
      setSuggestionLoading(false);
      return;
    }
    const suggestionContext = context;
    let cancelled = false;
    const nodeId = currentNodeId;
    async function loadSuggestions(): Promise<void> {
      try {
        setSuggestionLoading(true);
        const items = await listDirectory(token, nodeId, workspaceRoot, suggestionContext.basePath);
        if (cancelled) {
          return;
        }
        const next = items
          .filter((entry) => entry.type === "directory")
          .filter((entry) =>
            suggestionContext.partialName
              ? entry.name.toLowerCase().includes(suggestionContext.partialName.toLowerCase())
              : true,
          )
          .slice(0, 8);
        setPathSuggestions(next);
      } catch {
        if (!cancelled) {
          setPathSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setSuggestionLoading(false);
        }
      }
    }
    void loadSuggestions();
    return () => {
      cancelled = true;
    };
  }, [token, currentNodeId, workspaceRoot, pathDraft, selectedRootLabel, showCreateForm]);

  function applyPathDraft(): void {
    try {
      const nextPath = parsePathInput(pathDraft, workspaceRoot, selectedRootLabel);
      setDirectoryPath(nextPath);
      setDirectoryError(null);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "路径无效");
    }
  }

  function resetCreateForm(): void {
    setTitle("");
    setPrompt("");
    setSourceId("");
    setDirectoryPath(".");
    setPathDraft(formatDirectoryLabel(selectedRootLabel, "."));
    setSubmitError(null);
    setDirectoryError(null);
    setMode("new");
  }

  return (
    <div className="drawer-section session-sidebar">
      <div className="drawer-section-header">
        <div>
          <div className="eyebrow">终端</div>
          <h2>管理终端</h2>
          <div className="session-meta">默认控制台保持空白，只有你手动选择某个终端后才显示对应内容。</div>
        </div>
      </div>

      <div className="node-picker">
        <div className="directory-picker-summary">
          <strong>当前机器</strong>
          {selectedNode ? <span className="session-meta">{selectedNode.status === "online" ? "在线" : "离线"}</span> : null}
        </div>
        <select
          value={currentNodeId ?? ""}
          onChange={(event) => {
            onSelectNode(event.target.value);
          }}
        >
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label} · {node.status === "online" ? "在线" : "离线"}
            </option>
          ))}
        </select>
        {selectedNode?.error ? <div className="session-meta">{selectedNode.error}</div> : null}
      </div>

      <div className="session-list">
        {liveSessions.length === 0 ? <div className="session-meta">当前没有运行中的 Codex 终端。</div> : null}
        {liveSessions.map((session) => (
          <article key={session.id} className={`session-card ${currentSessionId === session.id ? "active" : ""}`}>
            <div className="session-card-main compact">
              <strong className="session-card-title">{session.title}</strong>
              <div className="session-meta session-path">
                {formatDirectoryLabel(rootLabelMap.get(session.workspaceRoot) ?? "当前根目录", session.cwd)}
              </div>
            </div>
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
                className="ghost-button danger"
                onClick={() => {
                  void onForceCloseSession(session.id, session.nodeId);
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="drawer-section">
        <div className="drawer-section-header">
          <div>
            <div className="eyebrow">新建</div>
            <h2>创建终端</h2>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setShowCreateForm((current) => {
                const next = !current;
                if (!next) {
                  resetCreateForm();
                }
                return next;
              });
            }}
          >
            {showCreateForm ? "收起" : "新建终端"}
          </button>
        </div>

        {!showCreateForm ? null : (
          <form
            className="session-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitting(true);
              setSubmitError(null);
              if (!currentNodeId) {
                setSubmitError("请先选择一个节点");
                setSubmitting(false);
                return;
              }
              void onCreateSession({
                nodeId: currentNodeId,
                title: title || `${mode === "new" ? "新建" : mode === "resume" ? "恢复" : "Fork"} 会话`,
                workspaceRoot,
                cwd,
                mode,
                prompt: prompt || undefined,
                sourceCodexSessionId: sourceId || undefined,
              })
                .then(() => {
                  resetCreateForm();
                  setShowCreateForm(false);
                })
                .catch((error) => {
                  setSubmitError(error instanceof Error ? error.message : "创建会话失败");
                })
                .finally(() => {
                  setSubmitting(false);
                });
            }}
          >
            {submitError ? <div className="error-banner">{submitError}</div> : null}
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
              <select value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} disabled={roots.length === 0}>
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
                {directoryLoading ? <span className="session-meta">读取中...</span> : null}
              </div>
              <div className="address-bar-row">
                <input
                  value={pathDraft}
                  onChange={(event) => setPathDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }
                    event.preventDefault();
                    applyPathDraft();
                  }}
                  aria-label="启动目录路径"
                  placeholder={formatDirectoryLabel(selectedRootLabel, ".")}
                />
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    applyPathDraft();
                  }}
                >
                  打开
                </button>
              </div>
              {!suggestionLoading && pathSuggestions.length === 0 ? null : (
                <div className="path-suggestion-list">
                  {suggestionLoading ? <span className="session-meta">路径建议读取中...</span> : null}
                  {pathSuggestions.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="ghost-button path-suggestion-button"
                      onClick={() => {
                        setDirectoryPath(entry.path);
                        setPathDraft(formatDirectoryLabel(selectedRootLabel, entry.path));
                        setDirectoryError(null);
                      }}
                    >
                      {formatDirectoryLabel(selectedRootLabel, entry.path)}
                    </button>
                  ))}
                </div>
              )}
              <div className="directory-picker-top">
                <span className="session-meta">可以直接输入完整路径，例如 {formatDirectoryLabel(selectedRootLabel, "projects")}。</span>
              </div>
              <div className="directory-actions-row">
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    setDirectoryPath(".");
                    setDirectoryError(null);
                  }}
                >
                  根目录
                </button>
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    setDirectoryPath(parentRelativePath(cwd));
                    setDirectoryError(null);
                  }}
                  disabled={cwd === "."}
                >
                  上一级
                </button>
              </div>
              <label>
                进入子目录
                <select
                  value=""
                  onChange={(event) => {
                    const nextPath = event.target.value;
                    if (!nextPath) {
                      return;
                    }
                    setDirectoryPath(nextPath);
                    setDirectoryError(null);
                  }}
                >
                  <option value="">请选择</option>
                  {childDirectories.map((entry) => (
                    <option key={entry.path} value={entry.path}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
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
        )}
      </div>
    </div>
  );
}
