import fs from "node:fs";
import path from "node:path";
import type { FileEntry, WorkspaceEntry } from "../types/models.js";
import { normalizeInsideRoot } from "../utils/paths.js";

export class FileService {
  constructor(private readonly roots: WorkspaceEntry[]) {}

  listRoots(): WorkspaceEntry[] {
    return this.roots;
  }

  private getRoot(rootPath: string): WorkspaceEntry {
    const root = this.roots.find((item) => item.rootPath === path.resolve(rootPath));
    if (!root) {
      throw new Error("工作区根目录不在允许范围内");
    }
    return root;
  }

  listDirectory(rootPath: string, relativePath = "."): FileEntry[] {
    const root = this.getRoot(rootPath);
    const dirPath = normalizeInsideRoot(root.rootPath, relativePath);
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .map((entry) => {
        const absolutePath = path.join(dirPath, entry.name);
        const stats = fs.statSync(absolutePath);
        return {
          name: entry.name,
          path: path.relative(root.rootPath, absolutePath) || ".",
          type: entry.isDirectory() ? "directory" : "file",
          size: stats.size,
          modifiedAt: stats.mtimeMs,
        } satisfies FileEntry;
      })
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name, "zh-CN");
      });
  }

  readFile(rootPath: string, relativePath: string): string {
    const root = this.getRoot(rootPath);
    const filePath = normalizeInsideRoot(root.rootPath, relativePath);
    return fs.readFileSync(filePath, "utf8");
  }

  updateFile(rootPath: string, relativePath: string, content: string): void {
    const root = this.getRoot(rootPath);
    const filePath = normalizeInsideRoot(root.rootPath, relativePath);
    fs.writeFileSync(filePath, content, "utf8");
  }

  writeFileFromBase64(rootPath: string, relativePath: string, contentBase64: string): void {
    const root = this.getRoot(rootPath);
    const filePath = normalizeInsideRoot(root.rootPath, relativePath);
    fs.writeFileSync(filePath, Buffer.from(contentBase64, "base64"));
  }

  resolvePath(rootPath: string, relativePath: string): string {
    const root = this.getRoot(rootPath);
    return normalizeInsideRoot(root.rootPath, relativePath);
  }

  createFolder(rootPath: string, relativePath: string): void {
    const root = this.getRoot(rootPath);
    const dirPath = normalizeInsideRoot(root.rootPath, relativePath);
    fs.mkdirSync(dirPath, { recursive: true });
  }

  createFile(rootPath: string, relativePath: string): void {
    const root = this.getRoot(rootPath);
    const filePath = normalizeInsideRoot(root.rootPath, relativePath);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "", "utf8");
    }
  }

  renameEntry(rootPath: string, sourceRelativePath: string, targetRelativePath: string): void {
    const root = this.getRoot(rootPath);
    const sourcePath = normalizeInsideRoot(root.rootPath, sourceRelativePath);
    const targetPath = normalizeInsideRoot(root.rootPath, targetRelativePath);
    fs.renameSync(sourcePath, targetPath);
  }

  deleteEntry(rootPath: string, relativePath: string): void {
    const root = this.getRoot(rootPath);
    const entryPath = normalizeInsideRoot(root.rootPath, relativePath);
    fs.rmSync(entryPath, { recursive: true, force: false });
  }
}
