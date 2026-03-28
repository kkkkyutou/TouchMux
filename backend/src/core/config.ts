import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { WorkspaceEntry } from "../types/models.js";

const backendRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const projectRoot = path.resolve(backendRoot, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const dataDir = path.resolve(process.env.TOUCHMUX_DATA_DIR ?? path.join(backendRoot, ".data"));

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const workspaceRoots = (process.env.TOUCHMUX_WORKSPACE_ROOTS ?? projectRoot)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => path.resolve(item));

const codexCommandRaw = process.env.TOUCHMUX_CODEX_COMMAND ?? "codex --no-alt-screen";
const [codexExecutable, ...codexArgs] = codexCommandRaw.split(/\s+/).filter(Boolean);

export interface AppConfig {
  host: string;
  port: number;
  password: string;
  jwtSecret: string;
  dataDir: string;
  historyFile: string;
  sessionsDir: string;
  shell: string;
  goalGuardIntervalMs: number;
  defaultIdleTimeoutSec: number;
  workspaceRoots: WorkspaceEntry[];
  codexExecutable: string;
  codexArgs: string[];
}

export interface ConfigSchemaEntry {
  key: string;
  required: boolean;
  defaultValue: string | number | boolean | null;
  example: string;
  description: string;
}

export const config: AppConfig = {
  host: process.env.TOUCHMUX_HOST ?? "0.0.0.0",
  port: Number(process.env.TOUCHMUX_PORT ?? 8787),
  password: process.env.TOUCHMUX_PASSWORD ?? "change-me",
  jwtSecret: process.env.TOUCHMUX_JWT_SECRET ?? "change-this-secret",
  dataDir,
  historyFile: path.join(os.homedir(), ".codex", "history.jsonl"),
  sessionsDir: path.join(os.homedir(), ".codex", "sessions"),
  shell: process.env.TOUCHMUX_DEFAULT_SHELL ?? "/bin/bash",
  goalGuardIntervalMs: Number(process.env.TOUCHMUX_GOAL_GUARD_INTERVAL_MS ?? 15000),
  defaultIdleTimeoutSec: Number(process.env.TOUCHMUX_IDLE_TIMEOUT_SEC ?? 90),
  workspaceRoots: workspaceRoots.map((rootPath) => ({
    rootPath,
    label: path.basename(rootPath) || rootPath,
  })),
  codexExecutable,
  codexArgs,
};

export const configSchema: ConfigSchemaEntry[] = [
  {
    key: "TOUCHMUX_PASSWORD",
    required: true,
    defaultValue: "change-me",
    example: "my-strong-password",
    description: "网页登录口令，单用户模式下用于访问 TouchMux。",
  },
  {
    key: "TOUCHMUX_JWT_SECRET",
    required: true,
    defaultValue: "change-this-secret",
    example: "replace-with-32-bytes-or-more",
    description: "服务端 token 签名密钥。",
  },
  {
    key: "TOUCHMUX_PORT",
    required: false,
    defaultValue: 8787,
    example: "8787",
    description: "后端 HTTP 与 WebSocket 监听端口。",
  },
  {
    key: "TOUCHMUX_HOST",
    required: false,
    defaultValue: "0.0.0.0",
    example: "0.0.0.0",
    description: "后端监听地址。",
  },
  {
    key: "TOUCHMUX_WORKSPACE_ROOTS",
    required: false,
    defaultValue: projectRoot,
    example: "/srv/workspace,/srv/shared",
    description: "允许在网页中访问的根目录列表，逗号分隔。",
  },
  {
    key: "TOUCHMUX_DATA_DIR",
    required: false,
    defaultValue: path.join(backendRoot, ".data"),
    example: "/var/lib/touchmux",
    description: "SQLite 和运行时状态文件目录。",
  },
  {
    key: "TOUCHMUX_CODEX_COMMAND",
    required: false,
    defaultValue: "codex --no-alt-screen",
    example: "codex --no-alt-screen",
    description: "启动 Codex 会话时写入 tmux 的命令模板。",
  },
  {
    key: "TOUCHMUX_DEFAULT_SHELL",
    required: false,
    defaultValue: "/bin/bash",
    example: "/bin/bash",
    description: "执行命令校验和 shell 命令时使用的 shell。",
  },
  {
    key: "TOUCHMUX_GOAL_GUARD_INTERVAL_MS",
    required: false,
    defaultValue: 15000,
    example: "15000",
    description: "goal guard 后台轮询周期，单位毫秒。",
  },
  {
    key: "TOUCHMUX_IDLE_TIMEOUT_SEC",
    required: false,
    defaultValue: 90,
    example: "90",
    description: "默认空闲阈值，超过后可触发自动续跑。",
  },
];
