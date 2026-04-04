import fs from "node:fs";
import net from "node:net";
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

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("app-server bridge probe smoke: 无法分配空闲端口")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
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
  throw new Error("app-server bridge probe smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert(response.ok, "app-server bridge probe smoke: 登录失败");
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "app-server bridge probe smoke: token 无效");
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
    throw new Error(`app-server bridge probe smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-app-server-bridge-"));
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
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"${1:-}\" == \"--help\" ]]; then echo \"mock-codex\"; exit 0; fi",
      "echo \"mock-codex-ready\"",
      "sleep 5",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(mockCodexPath, 0o755);

  const port = await reservePort();
  const password = "app-server-bridge-password";
  const server = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      TOUCHMUX_RUNTIME_MODE: "single",
      TOUCHMUX_PASSWORD: password,
      TOUCHMUX_JWT_SECRET: "app-server-bridge-jwt-secret-1234567890",
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
    const workspaceRoot = nodes.items[0]?.roots?.[0]?.rootPath;
    assert(workspaceRoot === workspaceDir, "app-server bridge probe smoke: 工作区根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "app server bridge probe session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });

    assert(created.executionChannel === "tmux_local_tui", "app-server bridge probe smoke: 当前测试只接受 tmux_local_tui 主链路");
    assert(created.currentCodexSessionId === null, "app-server bridge probe smoke: 初始 currentCodexSessionId 应为空");

    const probe = await requestJson(origin, token, `/api/session/${created.id}/app-server-bridge-probe`, {
      method: "POST",
    });

    assert(typeof probe.startedThreadId === "string" && probe.startedThreadId.length > 0, "app-server bridge probe smoke: startedThreadId 无效");
    assert(probe.threadReadId === probe.startedThreadId, "app-server bridge probe smoke: thread/read 返回 id 与 start 不一致");
    assert(probe.cwd === workspaceDir, "app-server bridge probe smoke: probe cwd 异常");
    assert(probe.threadReadCwd === workspaceDir, "app-server bridge probe smoke: thread/read 回读 cwd 异常");
    assert(probe.currentCodexSessionIdUnchanged === true, "app-server bridge probe smoke: bridge probe 不应修改 currentCodexSessionId");
    assert(probe.currentCodexSessionIdBefore === null && probe.currentCodexSessionIdAfter === null, "app-server bridge probe smoke: before/after 应保持为空");

    const detail = await requestJson(origin, token, `/api/session/${created.id}/detail`);
    assert(detail.currentCodexSessionId === null, "app-server bridge probe smoke: 会话详情中的 currentCodexSessionId 不应被污染");

    console.log("smoke-app-server-bridge-probe: ok");
  } finally {
    server.kill("SIGTERM");
    await delay(200);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
