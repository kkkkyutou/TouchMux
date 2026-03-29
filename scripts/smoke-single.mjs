import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = process.cwd();
const backendEntry = path.join(projectRoot, "backend", "dist", "server.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForServer(origin, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`${origin}/api/system/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await delay(250);
  }
  throw new Error("single smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert(response.ok, "single smoke: 登录失败");
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "single smoke: token 无效");
  return data.token;
}

async function requestJson(origin, token, pathname, init = undefined) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`single smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function openTerminal(origin, token, sessionId) {
  const wsOrigin = origin.replace(/^http/i, "ws");
  const socket = new WebSocket(
    `${wsOrigin}/ws/terminal?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}&nodeId=local&cols=120&rows=30`,
  );
  const chunks = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("single smoke: terminal 打开超时")), 5000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "input", payload: "smoke-single\n" }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "data" && typeof message.payload === "string") {
        chunks.push(message.payload);
        if (chunks.join("").includes("smoke-single")) {
          clearTimeout(timer);
          resolve();
        }
      }
      if (message.type === "error") {
        clearTimeout(timer);
        reject(new Error(`single smoke: terminal 错误 ${message.payload}`));
      }
    });
  });
  socket.close();
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-single-smoke-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  const mockCodexPath = path.join(tempRoot, "mock-codex");
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "history.jsonl"), "", "utf8");
  fs.writeFileSync(
    mockCodexPath,
    "#!/usr/bin/env bash\nif [[ \"${1:-}\" == \"--help\" ]]; then echo \"mock-codex\"; exit 0; fi\necho \"mock-codex-start:$*\"\nwhile IFS= read -r line; do echo \"$line\"; done\n",
    "utf8",
  );
  fs.chmodSync(mockCodexPath, 0o755);

  const port = 8897;
  const password = "single-smoke-password";
  const server = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      TOUCHMUX_RUNTIME_MODE: "single",
      TOUCHMUX_PASSWORD: password,
      TOUCHMUX_JWT_SECRET: "single-smoke-jwt-secret-1234567890",
      TOUCHMUX_HOST: "127.0.0.1",
      TOUCHMUX_PORT: String(port),
      TOUCHMUX_DATA_DIR: dataDir,
      TOUCHMUX_WORKSPACE_ROOTS: workspaceDir,
      TOUCHMUX_CODEX_COMMAND: mockCodexPath,
      TOUCHMUX_ALLOW_INSECURE_DEFAULTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(origin);
    const token = await login(origin, password);
    const nodes = await requestJson(origin, token, "/api/nodes");
    assert(Array.isArray(nodes.items) && nodes.items.length === 1, "single smoke: 节点列表异常");
    const workspaceRoot = nodes.items[0]?.roots?.[0]?.rootPath;
    assert(typeof workspaceRoot === "string" && workspaceRoot === workspaceDir, "single smoke: 根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "single smoke session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string", "single smoke: 创建会话失败");

    await openTerminal(origin, token, created.id);

    await requestJson(origin, token, "/api/fs/file", {
      method: "POST",
      body: JSON.stringify({ nodeId: "local", rootPath: workspaceRoot, relativePath: "smoke.txt" }),
    });
    await requestJson(origin, token, "/api/fs/file", {
      method: "PUT",
      body: JSON.stringify({ nodeId: "local", rootPath: workspaceRoot, relativePath: "smoke.txt", content: "ok" }),
    });
    const fileData = await requestJson(origin, token, `/api/fs/file?nodeId=local&rootPath=${encodeURIComponent(workspaceRoot)}&relativePath=smoke.txt`);
    assert(fileData.content === "ok", "single smoke: 文件读写失败");

    const closed = await requestJson(origin, token, `/api/session/${created.id}/close`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "local", force: true }),
    });
    assert(closed.status === "closed", "single smoke: 关闭会话失败");

    console.log("single-smoke: ok");
  } finally {
    server.kill("SIGTERM");
    await delay(200);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
