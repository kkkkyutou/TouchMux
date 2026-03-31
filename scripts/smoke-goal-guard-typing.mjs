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
  throw new Error("goal guard typing smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert(response.ok, "goal guard typing smoke: 登录失败");
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "goal guard typing smoke: token 无效");
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
    throw new Error(`goal guard typing smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function openTerminal(origin, token, sessionId) {
  const wsOrigin = origin.replace(/^http/i, "ws");
  const socket = new WebSocket(
    `${wsOrigin}/ws/terminal?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}&nodeId=local&cols=120&rows=30`,
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("goal guard typing smoke: terminal 打开超时")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "error") {
        clearTimeout(timer);
        reject(new Error(`goal guard typing smoke: terminal 错误 ${message.payload}`));
      }
    });
  });
  return socket;
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-goal-typing-smoke-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  const inputLogPath = path.join(tempRoot, "goal-typing.log");
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
      `log_file=${JSON.stringify(inputLogPath)}`,
      ": > \"$log_file\"",
      "stty -echo",
      "echo \"mock-codex-ready\"",
      "while IFS= read -r line; do",
      "  printf '%s\\n' \"$line\" >> \"$log_file\"",
      "done",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(mockCodexPath, 0o755);

  const port = 8899;
  const password = "goal-typing-password";
  const server = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      TOUCHMUX_RUNTIME_MODE: "single",
      TOUCHMUX_PASSWORD: password,
      TOUCHMUX_JWT_SECRET: "goal-typing-jwt-secret-1234567890",
      TOUCHMUX_HOST: "127.0.0.1",
      TOUCHMUX_PORT: String(port),
      TOUCHMUX_DATA_DIR: dataDir,
      TOUCHMUX_WORKSPACE_ROOTS: workspaceDir,
      TOUCHMUX_CODEX_COMMAND: mockCodexPath,
      TOUCHMUX_GOAL_GUARD_INTERVAL_MS: "200",
      TOUCHMUX_ALLOW_INSECURE_DEFAULTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let socket = null;
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(origin);
    const token = await login(origin, password);
    const nodes = await requestJson(origin, token, "/api/nodes");
    const workspaceRoot = nodes.items[0]?.roots?.[0]?.rootPath;
    assert(typeof workspaceRoot === "string" && workspaceRoot === workspaceDir, "goal guard typing smoke: 根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "goal typing smoke session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string", "goal guard typing smoke: 创建会话失败");

    await delay(400);
    await requestJson(origin, token, `/api/goal-guard/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        goalText: "不要插入自动续跑提示",
        successKeywords: [],
        successCommand: null,
        idleTimeoutSec: 1,
        resumePromptTemplate: "继续执行既定目标，未完成前不要停止。",
        allowManualStopAfterSuccess: true,
      }),
    });

    socket = await openTerminal(origin, token, created.id);
    socket.send(JSON.stringify({ type: "input", payload: "manual draft" }));
    await delay(700);
    socket.send(JSON.stringify({ type: "input", payload: " keep typing" }));
    await delay(700);

    const pendingLog = fs.readFileSync(inputLogPath, "utf8").trim();
    assert(pendingLog === "", `goal guard typing smoke: 用户未回车时被误触发自动续跑: ${pendingLog}`);

    socket.send(JSON.stringify({ type: "input", payload: "\n" }));
    await delay(400);

    const finalLog = fs
      .readFileSync(inputLogPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    assert(finalLog.length >= 1, "goal guard typing smoke: 用户回车后仍未收到输入");
    assert(
      finalLog[0].includes("keep typing"),
      `goal guard typing smoke: 首条输入未包含最后一段手动输入: ${finalLog[0] ?? "<empty>"}`,
    );
    assert(
      !finalLog[0].includes("当前目标：") && !finalLog[0].includes("继续执行既定目标"),
      `goal guard typing smoke: 自动续跑提示混入用户输入: ${finalLog[0]}`,
    );

    const closed = await requestJson(origin, token, `/api/session/${created.id}/close`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "local", force: true }),
    });
    assert(closed.status === "closed", "goal guard typing smoke: 关闭会话失败");

    console.log("goal-guard-typing-smoke: ok");
  } finally {
    socket?.close();
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
