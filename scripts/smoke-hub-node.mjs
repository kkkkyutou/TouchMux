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
  throw new Error(`hub-node smoke: ${origin} 启动超时`);
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert(response.ok, `hub-node smoke: ${origin} 登录失败`);
  const data = await response.json();
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
    throw new Error(`hub-node smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function waitForOnlineNode(origin, token, nodeId, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    const nodes = await requestJson(origin, token, "/api/nodes");
    const node = Array.isArray(nodes.items) ? nodes.items.find((entry) => entry.id === nodeId) : null;
    if (node?.status === "online") {
      return node;
    }
    await delay(250);
  }
  throw new Error("hub-node smoke: 节点未在线");
}

async function openTerminal(origin, token, nodeId, sessionId) {
  const wsOrigin = origin.replace(/^http/i, "ws");
  const socket = new WebSocket(
    `${wsOrigin}/ws/terminal?token=${encodeURIComponent(token)}&nodeId=${encodeURIComponent(nodeId)}&sessionId=${encodeURIComponent(sessionId)}&cols=120&rows=30`,
  );
  const chunks = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hub-node smoke: terminal 打开超时")), 6000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "input", payload: "smoke-hub-node\n" }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "data" && typeof message.payload === "string") {
        chunks.push(message.payload);
        if (chunks.join("").includes("smoke-hub-node")) {
          clearTimeout(timer);
          resolve();
        }
      }
      if (message.type === "error") {
        clearTimeout(timer);
        reject(new Error(`hub-node smoke: terminal 错误 ${message.payload}`));
      }
    });
  });
  socket.close();
}

function startServer(envOverrides) {
  const child = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return { child, readStderr: () => stderr };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-hub-node-smoke-"));
  const nodeHome = path.join(tempRoot, "node-home");
  const hubHome = path.join(tempRoot, "hub-home");
  const nodeWorkspace = path.join(tempRoot, "node-workspace");
  const nodeData = path.join(tempRoot, "node-data");
  const hubData = path.join(tempRoot, "hub-data");
  const mockCodexPath = path.join(tempRoot, "mock-codex");
  fs.mkdirSync(path.join(nodeHome, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(hubHome, ".codex"), { recursive: true });
  fs.mkdirSync(nodeWorkspace, { recursive: true });
  fs.mkdirSync(nodeData, { recursive: true });
  fs.mkdirSync(hubData, { recursive: true });
  fs.writeFileSync(path.join(nodeHome, ".codex", "history.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(hubHome, ".codex", "history.jsonl"), "", "utf8");
  fs.writeFileSync(
    mockCodexPath,
    "#!/usr/bin/env bash\nif [[ \"${1:-}\" == \"--help\" ]]; then echo \"mock-codex\"; exit 0; fi\necho \"mock-codex-start:$*\"\nwhile IFS= read -r line; do echo \"$line\"; done\n",
    "utf8",
  );
  fs.chmodSync(mockCodexPath, 0o755);

  const nodePort = 9897;
  const hubPort = 9898;
  const nodeSharedSecret = "hub-node-shared-secret-123456789012345";

  const nodeServer = startServer({
    HOME: nodeHome,
    TOUCHMUX_RUNTIME_MODE: "node",
    TOUCHMUX_PASSWORD: "node-password-123456",
    TOUCHMUX_JWT_SECRET: "node-jwt-secret-123456789012345",
    TOUCHMUX_NODE_SHARED_SECRET: nodeSharedSecret,
    TOUCHMUX_NODE_ID: "node-a",
    TOUCHMUX_NODE_LABEL: "Node A",
    TOUCHMUX_HOST: "127.0.0.1",
    TOUCHMUX_PORT: String(nodePort),
    TOUCHMUX_DATA_DIR: nodeData,
    TOUCHMUX_WORKSPACE_ROOTS: nodeWorkspace,
    TOUCHMUX_CODEX_COMMAND: mockCodexPath,
    TOUCHMUX_ALLOW_INSECURE_DEFAULTS: "false",
  });

  const hubServer = startServer({
    HOME: hubHome,
    TOUCHMUX_RUNTIME_MODE: "hub",
    TOUCHMUX_PASSWORD: "hub-password-123456",
    TOUCHMUX_JWT_SECRET: "hub-jwt-secret-123456789012345",
    TOUCHMUX_HOST: "127.0.0.1",
    TOUCHMUX_PORT: String(hubPort),
    TOUCHMUX_DATA_DIR: hubData,
    TOUCHMUX_HUB_NODES_JSON: JSON.stringify([
      {
        id: "node-a",
        label: "Node A",
        baseUrl: `http://127.0.0.1:${nodePort}`,
        sharedSecret: nodeSharedSecret,
      },
    ]),
    TOUCHMUX_ALLOW_INSECURE_DEFAULTS: "false",
  });

  try {
    const nodeOrigin = `http://127.0.0.1:${nodePort}`;
    const hubOrigin = `http://127.0.0.1:${hubPort}`;
    await waitForServer(nodeOrigin);
    await waitForServer(hubOrigin);

    const token = await login(hubOrigin, "hub-password-123456");
    const node = await waitForOnlineNode(hubOrigin, token, "node-a");
    const workspaceRoot = node?.roots?.[0]?.rootPath;
    assert(typeof workspaceRoot === "string" && workspaceRoot === nodeWorkspace, "hub-node smoke: 节点根目录异常");

    const created = await requestJson(hubOrigin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "node-a",
        title: "hub node smoke session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string" && created.nodeId === "node-a", "hub-node smoke: Hub 创建会话失败");

    await openTerminal(hubOrigin, token, "node-a", created.id);

    await requestJson(hubOrigin, token, "/api/fs/file", {
      method: "POST",
      body: JSON.stringify({ nodeId: "node-a", rootPath: workspaceRoot, relativePath: "hub-smoke.txt" }),
    });
    await requestJson(hubOrigin, token, "/api/fs/file", {
      method: "PUT",
      body: JSON.stringify({
        nodeId: "node-a",
        rootPath: workspaceRoot,
        relativePath: "hub-smoke.txt",
        content: "hub-ok",
      }),
    });
    const fileData = await requestJson(
      hubOrigin,
      token,
      `/api/fs/file?nodeId=node-a&rootPath=${encodeURIComponent(workspaceRoot)}&relativePath=hub-smoke.txt`,
    );
    assert(fileData.content === "hub-ok", "hub-node smoke: Hub 文件读写失败");

    const closed = await requestJson(hubOrigin, token, `/api/session/${created.id}/close`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "node-a", force: true }),
    });
    assert(closed.status === "closed", "hub-node smoke: Hub 关闭会话失败");

    console.log("hub-node-smoke: ok");
  } finally {
    nodeServer.child.kill("SIGTERM");
    hubServer.child.kill("SIGTERM");
    await delay(200);
    const stderr = `${nodeServer.readStderr()}${hubServer.readStderr()}`.trim();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (stderr) {
      process.stderr.write(`${stderr}\n`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
