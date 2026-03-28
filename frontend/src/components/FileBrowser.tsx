import { useEffect, useState } from "react";
import type { FileEntry, WorkspaceEntry } from "../types/api";
import {
  createFile,
  createFolder,
  deleteEntry,
  listDirectory,
  readFile,
  renameEntry,
} from "../lib/api";

interface FileBrowserProps {
  token: string;
  roots: WorkspaceEntry[];
  activeSessionCwd: string | null;
}

export function FileBrowser({ token, roots, activeSessionCwd }: FileBrowserProps) {
  const [rootPath, setRootPath] = useState(roots[0]?.rootPath ?? "");
  const [relativePath, setRelativePath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState("");
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
    void refresh();
  }, [rootPath, relativePath]);

  return (
    <section className="panel file-browser">
      <div className="panel-header">
        <div>
          <div className="eyebrow">文件</div>
          <h2>受控工作区</h2>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            if (activeSessionCwd) {
              setRelativePath(activeSessionCwd);
            }
          }}
        >
          跳到当前会话目录
        </button>
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
        <button type="button" className="ghost-button" onClick={() => void refresh()}>
          刷新
        </button>
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
            void createFile(token, rootPath, name).then(() => refresh());
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
                void readFile(token, rootPath, entry.path).then((content) => setPreview(content));
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
                  void deleteEntry(token, rootPath, entry.path).then(() => refresh());
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      <textarea className="file-preview" value={preview} readOnly placeholder="点击文件后在这里预览文本内容" />
    </section>
  );
}
