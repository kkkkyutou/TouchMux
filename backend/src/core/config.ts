import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { NodeConfigEntry, RuntimeMode, WorkspaceEntry } from "../types/models.js";

const backendRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const projectRoot = path.resolve(backendRoot, "..");
const homeRoot = os.homedir();

dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const dataDir = path.resolve(process.env.TOUCHMUX_DATA_DIR ?? path.join(backendRoot, ".data"));

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const workspaceRoots = (process.env.TOUCHMUX_WORKSPACE_ROOTS ?? os.homedir())
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => path.resolve(item));

const codexCommandRaw = process.env.TOUCHMUX_CODEX_COMMAND ?? "codex --no-alt-screen";
const [codexExecutable, ...codexArgs] = codexCommandRaw.split(/\s+/).filter(Boolean);
const runtimeMode = (process.env.TOUCHMUX_RUNTIME_MODE ?? "single").trim() as RuntimeMode;
const localNodeId = (process.env.TOUCHMUX_NODE_ID ?? "local").trim() || "local";
const localNodeLabel =
  (process.env.TOUCHMUX_NODE_LABEL ?? (runtimeMode === "node" ? os.hostname() : "This Machine")).trim() ||
  "This Machine";
const localNodeBaseUrl = (process.env.TOUCHMUX_NODE_PUBLIC_BASE_URL ?? "").trim();

function readHubNodes(): NodeConfigEntry[] {
  const json = process.env.TOUCHMUX_HUB_NODES_JSON?.trim();
  const file = process.env.TOUCHMUX_HUB_NODES_FILE?.trim();
  let raw = "[]";
  if (json) {
    raw = json;
  } else if (file) {
    raw = fs.readFileSync(path.resolve(file), "utf8");
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const candidate = entry as Record<string, unknown>;
        const id = String(candidate.id ?? "").trim();
        const label = String(candidate.label ?? id).trim();
        const baseUrl = String(candidate.baseUrl ?? "").trim().replace(/\/$/, "");
        const sharedSecret = String(candidate.sharedSecret ?? "").trim();
        if (!id || !label || !baseUrl) {
          return null;
        }
        return {
          id,
          label,
          baseUrl,
          ...(sharedSecret ? { sharedSecret } : {}),
        } satisfies NodeConfigEntry;
      })
      .filter((entry): entry is NodeConfigEntry => entry !== null);
  } catch {
    return [];
  }
}

const hubNodes = readHubNodes();

export interface AppConfig {
  runtimeMode: RuntimeMode;
  host: string;
  port: number;
  password: string;
  jwtSecret: string;
  tokenTtlSec: number;
  dataDir: string;
  historyFile: string;
  sessionsDir: string;
  shell: string;
  goalGuardIntervalMs: number;
  defaultIdleTimeoutSec: number;
  loginRateLimitWindowMs: number;
  loginRateLimitMaxAttempts: number;
  maxUploadBytes: number;
  nodeRequestTimeoutMs: number;
  allowInsecureDefaults: boolean;
  workspaceRoots: WorkspaceEntry[];
  codexExecutable: string;
  codexArgs: string[];
  localNode: NodeConfigEntry;
  nodeSharedSecret: string;
  hubNodes: NodeConfigEntry[];
  securityWarnings: string[];
}

export interface ConfigSchemaEntry {
  key: string;
  required: boolean;
  defaultValue: string | number | boolean | null;
  example: string;
  description: string;
}

export const config: AppConfig = {
  runtimeMode,
  host: process.env.TOUCHMUX_HOST ?? "0.0.0.0",
  port: Number(process.env.TOUCHMUX_PORT ?? 8787),
  password: process.env.TOUCHMUX_PASSWORD ?? "change-me",
  jwtSecret: process.env.TOUCHMUX_JWT_SECRET ?? "change-this-secret",
  tokenTtlSec: Number(process.env.TOUCHMUX_TOKEN_TTL_SEC ?? 60 * 60 * 24 * 7),
  dataDir,
  historyFile: path.join(os.homedir(), ".codex", "history.jsonl"),
  sessionsDir: path.join(os.homedir(), ".codex", "sessions"),
  shell: process.env.TOUCHMUX_DEFAULT_SHELL ?? "/bin/bash",
  goalGuardIntervalMs: Number(process.env.TOUCHMUX_GOAL_GUARD_INTERVAL_MS ?? 15000),
  defaultIdleTimeoutSec: Number(process.env.TOUCHMUX_IDLE_TIMEOUT_SEC ?? 90),
  loginRateLimitWindowMs: Number(process.env.TOUCHMUX_LOGIN_WINDOW_MS ?? 60000),
  loginRateLimitMaxAttempts: Number(process.env.TOUCHMUX_LOGIN_MAX_ATTEMPTS ?? 6),
  maxUploadBytes: Number(process.env.TOUCHMUX_MAX_UPLOAD_BYTES ?? 2 * 1024 * 1024),
  nodeRequestTimeoutMs: Number(process.env.TOUCHMUX_NODE_REQUEST_TIMEOUT_MS ?? 8000),
  allowInsecureDefaults: process.env.TOUCHMUX_ALLOW_INSECURE_DEFAULTS === "true",
  workspaceRoots: workspaceRoots.map((rootPath) => ({
    rootPath,
    label:
      rootPath === homeRoot
        ? `Home (${path.basename(homeRoot) || homeRoot})`
        : rootPath === projectRoot
          ? "Current Project"
          : path.basename(rootPath) || rootPath,
  })),
  codexExecutable,
  codexArgs,
  localNode: {
    id: localNodeId,
    label: localNodeLabel,
    baseUrl: localNodeBaseUrl,
  },
  nodeSharedSecret: (process.env.TOUCHMUX_NODE_SHARED_SECRET ?? "").trim(),
  hubNodes,
  securityWarnings: [
    ...(runtimeMode !== "single" && runtimeMode !== "hub" && runtimeMode !== "node"
      ? ["TOUCHMUX_RUNTIME_MODE 非法，当前仅支持 single、hub、node。"]
      : []),
    ...(process.env.TOUCHMUX_PASSWORD ?? "change-me") === "change-me"
      ? ["TOUCHMUX_PASSWORD 仍在使用默认值，公开部署前必须修改。"]
      : [],
    ...(process.env.TOUCHMUX_JWT_SECRET ?? "change-this-secret") === "change-this-secret"
      ? ["TOUCHMUX_JWT_SECRET 仍在使用默认值，公开部署前必须修改。"]
      : [],
    ...(runtimeMode !== "single" &&
    (process.env.TOUCHMUX_PASSWORD ?? "change-me") === "change-me" &&
    !process.env.TOUCHMUX_ALLOW_INSECURE_DEFAULTS
      ? ["当前运行模式不是 single，且 TOUCHMUX_PASSWORD 仍在使用默认值；默认情况下将阻止启动。"]
      : []),
    ...(runtimeMode !== "single" &&
    (process.env.TOUCHMUX_JWT_SECRET ?? "change-this-secret") === "change-this-secret" &&
    !process.env.TOUCHMUX_ALLOW_INSECURE_DEFAULTS
      ? ["当前运行模式不是 single，且 TOUCHMUX_JWT_SECRET 仍在使用默认值；默认情况下将阻止启动。"]
      : []),
    ...(runtimeMode === "hub" && hubNodes.length === 0
      ? ["当前运行在 hub 模式，但没有配置任何 TOUCHMUX_HUB_NODES_* 节点列表。"]
      : []),
    ...(runtimeMode === "node" && !process.env.TOUCHMUX_NODE_SHARED_SECRET
      ? ["当前运行在 node 模式，但未配置 TOUCHMUX_NODE_SHARED_SECRET，Hub 无法安全连接该节点。"]
      : []),
    ...(runtimeMode !== "single" &&
    process.env.TOUCHMUX_NODE_SHARED_SECRET &&
    process.env.TOUCHMUX_NODE_SHARED_SECRET.trim().length < 24
      ? ["TOUCHMUX_NODE_SHARED_SECRET 长度过短，建议至少 24 个字符。"]
      : []),
    ...workspaceRoots.some((rootPath) => rootPath === path.parse(rootPath).root)
      ? ["TOUCHMUX_WORKSPACE_ROOTS 包含文件系统根目录 `/`，这会显著扩大暴露面。"]
      : [],
  ],
};

export const configSchema: ConfigSchemaEntry[] = [
  {
    key: "TOUCHMUX_RUNTIME_MODE",
    required: false,
    defaultValue: "single",
    example: "single",
    description: "运行角色：single 为单机版，hub 为统一入口，node 为被 Hub 代理的节点机。",
  },
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
    key: "TOUCHMUX_TOKEN_TTL_SEC",
    required: false,
    defaultValue: 60 * 60 * 24 * 7,
    example: "604800",
    description: "网页登录 token 的有效期，单位秒。",
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
    defaultValue: homeRoot,
    example: "/home/your-user,/srv/shared",
    description: "允许在网页中访问的根目录列表，默认使用当前 Linux 用户主目录。",
  },
  {
    key: "TOUCHMUX_NODE_ID",
    required: false,
    defaultValue: "local",
    example: "workstation-a",
    description: "node 模式下的节点唯一标识；single 模式下默认也会作为本地节点 id。",
  },
  {
    key: "TOUCHMUX_NODE_LABEL",
    required: false,
    defaultValue: "This Machine",
    example: "Office Workstation",
    description: "对前端显示的节点名称。",
  },
  {
    key: "TOUCHMUX_NODE_PUBLIC_BASE_URL",
    required: false,
    defaultValue: "",
    example: "https://node-a.example.com",
    description: "节点对外可达地址，仅用于展示或未来扩展；single 模式下可留空。",
  },
  {
    key: "TOUCHMUX_NODE_SHARED_SECRET",
    required: false,
    defaultValue: "",
    example: "replace-with-a-long-random-secret",
    description: "Hub 与 node 通信时使用的共享密钥；node 模式应设置，hub 模式下每个节点也需要对应密钥。",
  },
  {
    key: "TOUCHMUX_NODE_REQUEST_TIMEOUT_MS",
    required: false,
    defaultValue: 8000,
    example: "8000",
    description: "Hub 调用 Node HTTP 接口的超时时间，单位毫秒。",
  },
  {
    key: "TOUCHMUX_HUB_NODES_JSON",
    required: false,
    defaultValue: "[]",
    example:
      "[{\"id\":\"workstation-a\",\"label\":\"Workstation A\",\"baseUrl\":\"http://127.0.0.1:9787\",\"sharedSecret\":\"secret\"}]",
    description: "hub 模式下的静态节点列表 JSON。",
  },
  {
    key: "TOUCHMUX_HUB_NODES_FILE",
    required: false,
    defaultValue: null,
    example: "/etc/touchmux/hub-nodes.json",
    description: "hub 模式下的静态节点列表文件路径；若与 JSON 同时存在，优先使用 JSON。",
  },
  {
    key: "TOUCHMUX_DATA_DIR",
    required: false,
    defaultValue: path.join(backendRoot, ".data"),
    example: "/var/lib/touchmux",
    description: "SQLite 和运行时状态文件目录。",
  },
  {
    key: "TOUCHMUX_MAX_UPLOAD_BYTES",
    required: false,
    defaultValue: 2 * 1024 * 1024,
    example: "2097152",
    description: "网页文件上传的最大允许字节数。",
  },
  {
    key: "TOUCHMUX_ALLOW_INSECURE_DEFAULTS",
    required: false,
    defaultValue: false,
    example: "true",
    description: "仅用于本地调试时放宽默认弱口令限制；公开部署不应开启。",
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
  {
    key: "TOUCHMUX_LOGIN_WINDOW_MS",
    required: false,
    defaultValue: 60000,
    example: "60000",
    description: "登录失败限流窗口，单位毫秒。",
  },
  {
    key: "TOUCHMUX_LOGIN_MAX_ATTEMPTS",
    required: false,
    defaultValue: 6,
    example: "6",
    description: "登录失败达到该次数后，在窗口期内临时阻断继续尝试。",
  },
];
