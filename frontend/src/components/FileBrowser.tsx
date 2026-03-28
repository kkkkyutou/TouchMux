import { useEffect, useState } from "react";
import type { FileEntry, WorkspaceEntry } from "../types/api";
import {
  createFile,
  createFolder,
  deleteEntry,
  listDirectory,
  readFile,
  renameEntry,
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
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    void refresh();
  }, [rootPath, relativePath]);

  const breadcrumbs = breadcrumbItems(relativePath);
  const canSave = Boolean(selectedFilePath) && isDirty && !isSaving;

  async function openFile(filePath: string): Promise<void> {
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
              setRelativePath(".");
            }}
          >
            回到根目录
          </button>
        </div>
      </div>
      <div className="file-toolbar">
        <select value={rootPath} onChange={(event) => setRootPath(event.target.value)}>
          {roots.map((root) => (
            <option key={root.rootPath} value={root.rootPath}>
              {root.label}
            </option>
          ))}
        </select>
        <input value={relativePath} onChange={(event) => setRelativePath(event.target.value)} />
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setRelativePath(parentPath(relativePath));
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
            onClick={() => setRelativePath(item.path)}
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
                  setRelativePath(entry.path);
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
                  void renameEntry(token, rootPath, entry.path, target).then(() => refresh());
                }}
              >
                改名
              </button>
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
        </div>
        <button type="button" onClick={() => void handleSave()} disabled={!canSave}>
          {isSaving ? "保存中..." : "保存"}
        </button>
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
