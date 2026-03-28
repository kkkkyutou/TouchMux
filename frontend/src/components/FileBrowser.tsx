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
  roots: WorkspaceEntry[];
  activeSessionCwd: string | null;
  activeSessionRoot: string | null;
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

export function FileBrowser({ token, roots, activeSessionCwd, activeSessionRoot }: FileBrowserProps) {
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function refresh(nextRoot = rootPath, nextRelative = relativePath): Promise<void> {
    if (!nextRoot) {
      return;
    }
    try {
      const items = await listDirectory(token, nextRoot, nextRelative);
      setEntries(items);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "目录读取失败");
    }
  }

  useEffect(() => {
    if (roots.length > 0 && !rootPath) {
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
    setSelectedFilePath(null);
    setPreview("");
    setIsDirty(false);
  }, [rootPath, relativePath]);

  useEffect(() => {
    setPathInput(relativePath);
  }, [relativePath]);

  useEffect(() => {
    void refresh();
  }, [rootPath, relativePath]);

  const breadcrumbs = breadcrumbItems(relativePath);
  const canSave = Boolean(selectedFilePath) && isDirty && !isSaving;

  function confirmDiscardChanges(): boolean {
    if (!isDirty) {
      return true;
    }
    return window.confirm("当前文件还有未保存的修改，确定继续并丢弃这些修改吗？");
  }

  function navigateToDirectory(nextPath: string): void {
    if (!confirmDiscardChanges()) {
      return;
    }
    setRelativePath(nextPath);
  }

  async function openFile(filePath: string): Promise<void> {
    if (selectedFilePath !== filePath && !confirmDiscardChanges()) {
      return;
    }
    const content = await readFile(token, rootPath, filePath);
    setSelectedFilePath(filePath);
    setPreview(content);
    setIsDirty(false);
  }

  async function handleSave(): Promise<void> {
    if (!selectedFilePath) {
      return;
    }
    try {
      setIsSaving(true);
      await updateFile(token, rootPath, selectedFilePath, preview);
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
      const blob = await downloadFile(token, rootPath, filePath);
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
      setIsUploading(true);
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const contentBase64 = btoa(binary);
      const uploaded = await uploadFile(token, {
        rootPath,
        directoryPath: relativePath,
        fileName: file.name,
        contentBase64,
      });
      setError(null);
      await refresh();
      if (file.type.startsWith("text/")) {
        await openFile(uploaded.relativePath);
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
    <section className="panel file-browser">
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
              if (!confirmDiscardChanges()) {
                return;
              }
              if (activeSessionRoot) {
                setRootPath(activeSessionRoot);
              }
              if (activeSessionCwd) {
                setRelativePath(activeSessionCwd);
              }
            }}
          >
            跳到当前会话目录
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
            if (!confirmDiscardChanges()) {
              return;
            }
            setRootPath(event.target.value);
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
            const name = window.prompt("输入新文件夹相对路径", relativePath === "." ? "new-folder" : `${relativePath}/new-folder`);
            if (!name) {
              return;
            }
            void createFolder(token, rootPath, name).then(() => refresh());
          }}
        >
          新建文件夹
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            const name = window.prompt("输入新文件相对路径", relativePath === "." ? "new-file.txt" : `${relativePath}/new-file.txt`);
            if (!name) {
              return;
            }
            void createFile(token, rootPath, name)
              .then(async () => {
                await refresh();
                await openFile(name);
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
                void openFile(entry.path).catch((openError) => {
                  setError(openError instanceof Error ? openError.message : "文件读取失败");
                });
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
                  const target = window.prompt("输入新的相对路径", entry.path);
                  if (!target) {
                    return;
                  }
                  void renameEntry(token, rootPath, entry.path, target).then(() => {
                    if (selectedFilePath === entry.path) {
                      setSelectedFilePath(target);
                    }
                    return refresh();
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
                  const confirmed = window.confirm(`确认删除 ${entry.path} ?`);
                  if (!confirmed) {
                    return;
                  }
                  void deleteEntry(token, rootPath, entry.path).then(() => {
                    if (selectedFilePath === entry.path) {
                      setSelectedFilePath(null);
                      setPreview("");
                      setIsDirty(false);
                    }
                    return refresh();
                  });
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
    </section>
  );
}
