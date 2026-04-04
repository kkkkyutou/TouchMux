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
        server.close(() => reject(new Error("codex session binding smoke: 无法分配空闲端口")));
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeRollout(homeDir, isoDate, sessionId, cwd) {
  const date = new Date(isoDate);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dirPath = path.join(homeDir, ".codex", "sessions", year, month, day);
  ensureDir(dirPath);
  const filePath = path.join(dirPath, `rollout-${isoDate.replaceAll(":", "-")}-${sessionId}.jsonl`);
  const lines = [
    {
      timestamp: isoDate,
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: isoDate,
        cwd,
        originator: "codex_cli_rs",
        source: "cli",
      },
    },
    {
      timestamp: new Date(Date.parse(isoDate) + 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-bind",
      },
    },
  ];
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
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
  throw new Error("codex session binding smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert(response.ok, "codex session binding smoke: 登录失败");
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "codex session binding smoke: token 无效");
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
    throw new Error(`codex session binding smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-codex-binding-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  const mockCodexPath = path.join(tempRoot, "mock-codex");
  ensureDir(path.join(homeDir, ".codex"));
  ensureDir(workspaceDir);
  ensureDir(dataDir);
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
  const password = "codex-binding-password";
  const server = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      TOUCHMUX_RUNTIME_MODE: "single",
      TOUCHMUX_PASSWORD: password,
      TOUCHMUX_JWT_SECRET: "codex-binding-jwt-secret-1234567890",
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
    assert(workspaceRoot === workspaceDir, "codex session binding smoke: 工作区根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "codex binding smoke session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string", "codex session binding smoke: 创建会话失败");
    assert(created.currentCodexSessionId === null, "codex session binding smoke: 初始 currentCodexSessionId 应为空");

    writeRollout(homeDir, new Date(created.createdAt + 500).toISOString(), "codex-current-bind", workspaceDir);
    await delay(300);

    const debugInfo = await requestJson(origin, token, `/api/goal-guard/${created.id}/debug`);
    assert(debugInfo.codexObservation?.matchedSessionId === "codex-current-bind", "codex session binding smoke: debug 未匹配到预期 rollout");

    const detail = await requestJson(origin, token, `/api/session/${created.id}/detail`);
    assert(
      detail.currentCodexSessionId === "codex-current-bind",
      `codex session binding smoke: currentCodexSessionId 未持久化，实际为 ${detail.currentCodexSessionId}`,
    );

    console.log("smoke-codex-session-binding: ok");
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
