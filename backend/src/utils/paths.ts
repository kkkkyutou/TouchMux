import fs from "node:fs";
import path from "node:path";

export function normalizeInsideRoot(rootPath: string, relativePath: string): string {
  const resolved = path.resolve(rootPath, relativePath || ".");
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("目标路径超出允许的工作区范围");
  }
  return resolved;
}

export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
