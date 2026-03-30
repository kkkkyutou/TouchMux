import { useEffect, useRef, useState } from "react";
import type { FileEntry, WorkspaceEntry } from "../types/api";
import {
  createFile,
  createFolder,
  deleteEntry,
  downloadFile,
  listDirectory,
  readFile,
  renameEntry,
  uploadFile,
  updateFile,
} from "../lib/api";

interface FileBrowserProps {
  token: string;
  nodeId: string | null;
  roots: WorkspaceEntry[];
  activeSessionCwd: string | null;
  activeSessionRoot: string | null;
}

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  tone?: "default" | "danger";
}

interface EntryDialogState {
  kind: "create-folder" | "create-file" | "rename";
  title: string;
  submitLabel: string;
  value: string;
  sourcePath?: string;
}

function normalizeDirectoryPath(value: string): string {
  return value && value !== "." ? value : ".";
}

function parentPath(value: string): string {
  const normalized = normalizeDirectoryPath(value);
  if (normalized === ".") {
    return ".";
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return ".";
  }
  return parts.slice(0, -1).join("/");
}

function breadcrumbItems(value: string): Array<{ label: string; path: string }> {
  const normalized = normalizeDirectoryPath(value);
  if (normalized === ".") {
    return [{ label: "Home", path: "." }];
  }
  const parts = normalized.split("/").filter(Boolean);
  return [
    { label: "Home", path: "." },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join("/"),
    })),
  ];
}

export function FileBrowser({ token, nodeId, roots, activeSessionCwd, activeSessionRoot }: FileBrowserProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [rootPath, setRootPath] = useState(roots[0]?.rootPath ?? "");
  const [relativePath, setRelativePath] = useState(".");
  const [pathInput, setPathInput] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [entryDialog, setEntryDialog] = useState<EntryDialogState | null>(null);
  const [entryDialogError, setEntryDialogError] = useState<string | null>(null);
  const [entryDialogSubmitting, setEntryDialogSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingConfirmActionRef = useRef<(() => void) | null>(null);

  async function refresh(nextRoot = rootPath, nextRelative = relativePath): Promise<void> {
    if (!nodeId || !nextRoot) {
      setEntries([]);
      return;
    }
    try {
      const items = await listDirectory(token, nodeId, nextRoot, nextRelative);
      setEntries(items);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "目录读取失败");
    }
  }

  useEffect(() => {
    if (roots.length === 0) {
      setRootPath("");
      return;
    }
    if (!rootPath || !roots.some((root) => root.rootPath === rootPath)) {
      setRootPath(roots[0].rootPath);
    }
  }, [roots, rootPath]);

  useEffect(() => {
    if (!activeSessionRoot) {
      return;
    }
    setRootPath((current) => (current === activeSessionRoot ? current : activeSessionRoot));
  }, [activeSessionRoot]);

  useEffect(() => {
    if (!activeSessionRoot) {
      return;
    }
    setRootPath(activeSessionRoot);
    setRelativePath(activeSessionCwd || ".");
  }, [activeSessionRoot, activeSessionCwd]);

  useEffect(() => {
    setSelectedFilePath(null);
    setPreview("");
    setIsDirty(false);
    setConfirmState(null);
    pendingConfirmActionRef.current = null;
  }, [rootPath, relativePath]);

  useEffect(() => {
    setPathInput(relativePath);
  }, [relativePath]);

  useEffect(() => {
    void refresh();
  }, [nodeId, rootPath, relativePath]);

  useEffect(() => {
    setEntryDialog(null);
    setEntryDialogError(null);
    setEntryDialogSubmitting(false);
  }, [nodeId]);

  const breadcrumbs = breadcrumbItems(relativePath);
  const canSave = Boolean(selectedFilePath) && isDirty && !isSaving;

  function clearConfirmState(): void {
    pendingConfirmActionRef.current = null;
    setConfirmState(null);
  }

  function requestConfirmation(state: ConfirmState, onConfirm: () => void): void {
    pendingConfirmActionRef.current = () => {
      clearConfirmState();
      onConfirm();
    };
    setConfirmState(state);
  }

  function runWithDiscardProtection(action: () => void): void {
    if (!isDirty) {
      action();
      return;
    }
    requestConfirmation(
      {
        title: "丢弃未保存修改",
        message: "当前文件还有未保存的修改。继续操作会丢弃这些修改。",
        confirmLabel: "丢弃并继续",
        tone: "danger",
      },
      action,
    );
  }

  function navigateToDirectory(nextPath: string): void {
    runWithDiscardProtection(() => {
      setRelativePath(nextPath);
    });
  }

  async function loadFile(filePath: string): Promise<void> {
    if (!nodeId) {
      throw new Error("当前未选择节点");
    }
    const content = await readFile(token, nodeId, rootPath, filePath);
    setSelectedFilePath(filePath);
    setPreview(content);
    setIsDirty(false);
    setError(null);
  }

  function openFile(filePath: string): void {
    const open = () => {
      void loadFile(filePath).catch((openError) => {
        setError(openError instanceof Error ? openError.message : "文件读取失败");
      });
    };
    if (selectedFilePath !== filePath) {
      runWithDiscardProtection(open);
      return;
    }
    open();
  }

  async function handleSave(): Promise<void> {
    if (!selectedFilePath) {
      return;
    }
    try {
      setIsSaving(true);
      if (!nodeId) {
        throw new Error("当前未选择节点");
      }
      await updateFile(token, nodeId, rootPath, selectedFilePath, preview);
      setIsDirty(false);
      setError(null);
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "文件保存失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDownload(filePath: string): Promise<void> {
    try {
      if (!nodeId) {
        throw new Error("当前未选择节点");
      }
      const blob = await downloadFile(token, nodeId, rootPath, filePath);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filePath.split("/").pop() ?? "download";
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "文件下载失败");
    }
  }

  async function handleUpload(file: File): Promise<void> {
    try {
      if (!nodeId) {
        throw new Error("当前未选择节点");
      }
      setIsUploading(true);
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const contentBase64 = btoa(binary);
      const uploaded = await uploadFile(token, {
        nodeId,
        rootPath,
        directoryPath: relativePath,
        fileName: file.name,
        contentBase64,
      });
      setError(null);
      await refresh();
      if (file.type.startsWith("text/")) {
        openFile(uploaded.relativePath);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "文件上传失败");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function openEntryDialog(state: EntryDialogState): void {
    setEntryDialog(state);
    setEntryDialogError(null);
  }

  async function handleEntryDialogSubmit(): Promise<void> {
    if (!entryDialog) {
      return;
    }
    const nextValue = entryDialog.value.trim();
    if (!nextValue) {
      setEntryDialogError("请输入有效路径");
      return;
    }
    if (!nodeId) {
      setEntryDialogError("当前未选择节点");
      return;
    }
    try {
      setEntryDialogSubmitting(true);
      if (entryDialog.kind === "create-folder") {
        await createFolder(token, nodeId, rootPath, nextValue);
      } else if (entryDialog.kind === "create-file") {
        await createFile(token, nodeId, rootPath, nextValue);
      } else if (entryDialog.sourcePath) {
        await renameEntry(token, nodeId, rootPath, entryDialog.sourcePath, nextValue);
        if (selectedFilePath === entryDialog.sourcePath) {
          setSelectedFilePath(nextValue);
        }
      }

      await refresh();
      setEntryDialog(null);
      setEntryDialogError(null);

      if (entryDialog.kind === "create-file") {
        openFile(nextValue);
      }
    } catch (submitError) {
      setEntryDialogError(submitError instanceof Error ? submitError.message : "文件操作失败");
    } finally {
      setEntryDialogSubmitting(false);
    }
  }

  useEffect(() => {
    if (!isDirty) {
      return undefined;
    }
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  return (
    <>
      <div
        className={`browser-sheet-backdrop ${isExpanded ? "open" : ""}`}
        onClick={() => {
          setIsExpanded(false);
        }}
      />
      <section className={`panel file-browser browser-dock ${isExpanded ? "expanded" : "collapsed"}`}>
        <button
          type="button"
          className="panel-toggle-title"
          onClick={() => {
            setIsExpanded((current) => !current);
          }}
        >
          <span>
            <div className="eyebrow">文件管理</div>
            <h2>{isExpanded ? "点击收起文件管理" : "点击展开文件管理"}</h2>
          </span>
          <span className="session-meta">{relativePath === "." ? "根目录" : relativePath}</span>
        </button>
        {!isExpanded ? null : (
          <>
            <div className="panel-header">
              <div>
                <div className="eyebrow">文件</div>
                <h2>现有工作环境</h2>
              </div>
              <div className="file-entry-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    runWithDiscardProtection(() => {
                      if (activeSessionRoot) {
                        setRootPath(activeSessionRoot);
                      }
                      if (activeSessionCwd) {
                        setRelativePath(activeSessionCwd);
                      }
                    });
                  }}
                >
                  同步当前终端目录
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    navigateToDirectory(".");
                  }}
                >
                  回到根目录
                </button>
              </div>
            </div>
            <div className="file-toolbar">
              <select
                value={rootPath}
                onChange={(event) => {
                  runWithDiscardProtection(() => {
                    setRootPath(event.target.value);
                  });
                }}
              >
                {roots.map((root) => (
                  <option key={root.rootPath} value={root.rootPath}>
                    {root.label}
                  </option>
                ))}
              </select>
              <input
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    navigateToDirectory(pathInput || ".");
                  }
                }}
              />
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  navigateToDirectory(pathInput || ".");
                }}
              >
                打开
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  navigateToDirectory(parentPath(relativePath));
                }}
              >
                上一级
              </button>
              <button type="button" className="ghost-button" onClick={() => void refresh()}>
                刷新
              </button>
            </div>
            <div className="file-breadcrumbs">
              {breadcrumbs.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className={`breadcrumb-chip ${item.path === normalizeDirectoryPath(relativePath) ? "active" : ""}`}
                  onClick={() => navigateToDirectory(item.path)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="file-actions">
              <button
                type="button"
                onClick={() => {
                  openEntryDialog({
                    kind: "create-folder",
                    title: "新建文件夹",
                    submitLabel: "创建文件夹",
                    value: relativePath === "." ? "new-folder" : `${relativePath}/new-folder`,
                  });
                }}
              >
                新建文件夹
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  openEntryDialog({
                    kind: "create-file",
                    title: "新建文件",
                    submitLabel: "创建文件",
                    value: relativePath === "." ? "new-file.txt" : `${relativePath}/new-file.txt`,
                  });
                }}
              >
                新建文件
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {isUploading ? "上传中..." : "上传文件"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="file-hidden-input"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleUpload(file);
                  }
                }}
              />
            </div>
            {entryDialog ? (
              <section className="inline-action-card">
                <div className="inline-action-header">
                  <div>
                    <div className="eyebrow">文件操作</div>
                    <h3>{entryDialog.title}</h3>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setEntryDialog(null);
                      setEntryDialogError(null);
                    }}
                  >
                    取消
                  </button>
                </div>
                <label>
                  相对路径
                  <input
                    value={entryDialog.value}
                    onChange={(event) => {
                      setEntryDialog({
                        ...entryDialog,
                        value: event.target.value,
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleEntryDialogSubmit();
                      }
                    }}
                  />
                </label>
                {entryDialogError ? <div className="error-banner inline-banner">{entryDialogError}</div> : null}
                <div className="file-entry-actions">
                  <button type="button" onClick={() => void handleEntryDialogSubmit()} disabled={entryDialogSubmitting}>
                    {entryDialogSubmitting ? "处理中..." : entryDialog.submitLabel}
                  </button>
                </div>
              </section>
            ) : null}
            {confirmState ? (
              <section className="inline-action-card confirm-card">
                <div className="inline-action-header">
                  <div>
                    <div className="eyebrow">确认操作</div>
                    <h3>{confirmState.title}</h3>
                  </div>
                </div>
                <p className="confirm-card-text">{confirmState.message}</p>
                <div className="file-entry-actions">
                  <button type="button" className="ghost-button" onClick={() => clearConfirmState()}>
                    取消
                  </button>
                  <button
                    type="button"
                    className={confirmState.tone === "danger" ? "ghost-button danger" : ""}
                    onClick={() => pendingConfirmActionRef.current?.()}
                  >
                    {confirmState.confirmLabel}
                  </button>
                </div>
              </section>
            ) : null}
            {error ? <div className="error-banner">{error}</div> : null}
            <div className="file-list">
              {entries.map((entry) => (
                <article key={entry.path} className="file-entry">
                  <button
                    type="button"
                    className="file-entry-main"
                    onClick={() => {
                      if (entry.type === "directory") {
                        navigateToDirectory(entry.path);
                        return;
                      }
                      openFile(entry.path);
                    }}
                  >
                    <span>{entry.type === "directory" ? "DIR" : "FILE"}</span>
                    <strong>{entry.name}</strong>
                  </button>
                  <div className="file-entry-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        openEntryDialog({
                          kind: "rename",
                          title: `重命名 ${entry.name}`,
                          submitLabel: "确认改名",
                          value: entry.path,
                          sourcePath: entry.path,
                        });
                      }}
                    >
                      改名
                    </button>
                    {entry.type === "file" ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          void handleDownload(entry.path);
                        }}
                      >
                        下载
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button danger"
                      onClick={() => {
                        requestConfirmation(
                          {
                            title: "删除文件或目录",
                            message: `确认删除 ${entry.path} 吗？此操作不可撤销。`,
                            confirmLabel: "确认删除",
                            tone: "danger",
                          },
                          () => {
                            if (!nodeId) {
                              setError("当前未选择节点");
                              return;
                            }
                            void deleteEntry(token, nodeId, rootPath, entry.path)
                              .then(() => {
                                if (selectedFilePath === entry.path) {
                                  setSelectedFilePath(null);
                                  setPreview("");
                                  setIsDirty(false);
                                }
                                return refresh();
                              })
                              .catch((deleteError) => {
                                setError(deleteError instanceof Error ? deleteError.message : "文件删除失败");
                              });
                          },
                        );
                      }}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="editor-header">
              <div>
                <div className="eyebrow">编辑器</div>
                <strong>{selectedFilePath ?? "未选择文件"}</strong>
                {isDirty ? <div className="session-meta">有未保存修改</div> : null}
              </div>
              <div className="file-entry-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!selectedFilePath}
                  onClick={() => {
                    if (!selectedFilePath) {
                      return;
                    }
                    void handleDownload(selectedFilePath);
                  }}
                >
                  下载当前文件
                </button>
                <button type="button" onClick={() => void handleSave()} disabled={!canSave}>
                  {isSaving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
            <textarea
              className="file-preview"
              value={preview}
              onChange={(event) => {
                setPreview(event.target.value);
                setIsDirty(true);
              }}
              placeholder="点击文件后可直接编辑并保存文本内容"
              spellCheck={false}
            />
          </>
        )}
      </section>
    </>
  );
}
