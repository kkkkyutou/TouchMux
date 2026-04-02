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
  throw new Error("goal guard background smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert(response.ok, "goal guard background smoke: 登录失败");
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "goal guard background smoke: token 无效");
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
    throw new Error(`goal guard background smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function waitForGoalSatisfied(origin, token, sessionId, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    const sessions = await requestJson(origin, token, "/api/session/list");
    const current = sessions.items.find((item) => item.id === sessionId);
    if (current?.goalState === "goal_satisfied") {
      return current;
    }
    await delay(250);
  }
  throw new Error("goal guard background smoke: 后台守卫未能在无附着终端时识别成功输出");
}

async function waitForStableSatisfied(origin, token, sessionId, attempts = 12) {
  for (let index = 0; index < attempts; index += 1) {
    const sessions = await requestJson(origin, token, "/api/session/list");
    const current = sessions.items.find((item) => item.id === sessionId);
    if (!current) {
      throw new Error("goal guard background smoke: 会话在稳定性检查阶段丢失");
    }
    assert(
      current.goalState === "goal_satisfied",
      `goal guard background smoke: 达标后状态回退为 ${current.goalState}`,
    );
    assert(
      current.status !== "auto_resuming",
      "goal guard background smoke: 达标后仍触发了自动续跑",
    );
    await delay(250);
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-goal-background-smoke-"));
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
      "sleep 0.3",
      "echo \"SUCCESS\"",
      "while IFS= read -r line; do",
      "  echo \"received:$line\"",
      "  echo \"SUCCESS\"",
      "done",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(mockCodexPath, 0o755);

  const port = 8900;
  const password = "goal-background-password";
  const server = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      TOUCHMUX_RUNTIME_MODE: "single",
      TOUCHMUX_PASSWORD: password,
      TOUCHMUX_JWT_SECRET: "goal-background-jwt-secret-1234567890",
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

  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(origin);
    const token = await login(origin, password);
    const nodes = await requestJson(origin, token, "/api/nodes");
    const workspaceRoot = nodes.items[0]?.roots?.[0]?.rootPath;
    assert(typeof workspaceRoot === "string" && workspaceRoot === workspaceDir, "goal guard background smoke: 根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "goal background smoke session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string", "goal guard background smoke: 创建会话失败");

    await delay(900);

    const started = await requestJson(origin, token, `/api/goal-guard/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        goalText: "旧 SUCCESS 不应被当成当前任务完成",
        successKeywords: ["SUCCESS"],
        successCommand: "exit 1",
        idleTimeoutSec: 5,
        resumePromptTemplate: "继续执行既定目标，未完成前不要停止。",
        allowManualStopAfterSuccess: true,
      }),
    });

    assert(started.goalState === "idle_waiting", `goal guard background smoke: 启动后状态异常 ${started.goalState}`);

    await delay(1400);
    const interimSessions = await requestJson(origin, token, "/api/session/list");
    const interim = interimSessions.items.find((item) => item.id === created.id);
    assert(interim, "goal guard background smoke: 会话未找到");
    assert(
      interim.goalState !== "goal_satisfied" && interim.goalState !== "failed_check",
      `goal guard background smoke: 守卫错误消费了启动前旧输出 ${interim.goalState}`,
    );

    const restarted = await requestJson(origin, token, `/api/goal-guard/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        goalText: "等待后台收到守卫提示后\n再输出 SUCCESS",
        successKeywords: ["SUCCESS"],
        successCommand: null,
        idleTimeoutSec: 1,
        resumePromptTemplate: "继续执行既定目标，\n未完成前不要停止。",
        allowManualStopAfterSuccess: true,
      }),
    });

    assert(restarted.goalState === "idle_waiting", `goal guard background smoke: 重新配置后状态异常 ${restarted.goalState}`);

    const finished = await waitForGoalSatisfied(origin, token, created.id);
    assert(
      typeof finished.lastOutputPreview === "string" && finished.lastOutputPreview.includes("SUCCESS"),
      "goal guard background smoke: 后台输出预览未更新到 SUCCESS",
    );
    assert(
      finished.lastOutputPreview.includes("received:当前目标：等待后台收到守卫提示后 再输出 SUCCESS；继续执行既定目标") &&
        finished.lastOutputPreview.includes("未完成前不要"),
      `goal guard background smoke: 自动续跑提示没有以单行方式提交: ${finished.lastOutputPreview}`,
    );
    await waitForStableSatisfied(origin, token, created.id);

    const closed = await requestJson(origin, token, `/api/session/${created.id}/close`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "local", force: true }),
    });
    assert(closed.status === "closed", "goal guard background smoke: 关闭会话失败");

    console.log("goal-guard-background-smoke: ok");
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
