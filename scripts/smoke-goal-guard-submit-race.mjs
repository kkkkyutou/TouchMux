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
  throw new Error("goal guard submit race smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert(response.ok, "goal guard submit race smoke: 登录失败");
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "goal guard submit race smoke: token 无效");
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
    throw new Error(`goal guard submit race smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function waitForGoalSatisfied(origin, token, sessionId, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const sessions = await requestJson(origin, token, "/api/session/list");
    const current = sessions.items.find((item) => item.id === sessionId);
    if (current?.goalState === "goal_satisfied") {
      return current;
    }
    await delay(250);
  }
  throw new Error("goal guard submit race smoke: 自动续跑提示仍停留在草稿态，没有真正提交");
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-goal-submit-race-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  const mockCodexPath = path.join(tempRoot, "mock-codex-submit-race.sh");
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "history.jsonl"), "", "utf8");
  fs.writeFileSync(
    mockCodexPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      "if [[ \"${1:-}\" == \"--help\" ]]; then echo \"mock-codex-submit-race\"; exit 0; fi",
      "",
      "submit_threshold_ms=120",
      "draft=\"\"",
      "last_printable_at=0",
      "",
      "stty -echo -icanon min 1 time 0",
      "cleanup() {",
      "  stty sane || true",
      "}",
      "trap cleanup EXIT",
      "",
      "printf 'mock-codex-ready\\n\\n› '",
      "",
      "submit_draft() {",
      "  local payload=\"$draft\"",
      "  draft=\"\"",
      "  printf '\\r\\n◦ Working (mock)\\r\\nsubmitted:%s\\r\\nACK_OK\\r\\n\\r\\n› ' \"$payload\"",
      "}",
      "",
      "while IFS= read -rsn1 char; do",
      "  if [[ \"$char\" == $'\\003' ]]; then",
      "    exit 0",
      "  fi",
      "  if [[ -z \"$char\" || \"$char\" == $'\\r' || \"$char\" == $'\\n' ]]; then",
      "    now=$(date +%s%3N)",
      "    if [[ -n \"$draft\" ]] && (( now - last_printable_at >= submit_threshold_ms )); then",
      "      submit_draft",
      "    fi",
      "    continue",
      "  fi",
      "  draft+=\"$char\"",
      "  last_printable_at=$(date +%s%3N)",
      "  printf '%s' \"$char\"",
      "done",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(mockCodexPath, 0o755);

  const port = 8901;
  const password = "goal-submit-race-password";
  const server = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      TOUCHMUX_RUNTIME_MODE: "single",
      TOUCHMUX_PASSWORD: password,
      TOUCHMUX_JWT_SECRET: "goal-submit-race-jwt-secret-1234567890",
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
    assert(typeof workspaceRoot === "string" && workspaceRoot === workspaceDir, "goal guard submit race smoke: 根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "goal submit race smoke session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string", "goal guard submit race smoke: 创建会话失败");

    await delay(500);
    const started = await requestJson(origin, token, `/api/goal-guard/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        goalText: "等待自动续跑真正提交",
        successKeywords: ["ACK_OK"],
        successCommand: null,
        idleTimeoutSec: 1,
        resumePromptTemplate: "请回复 ACK_OK",
        allowManualStopAfterSuccess: true,
      }),
    });
    assert(started.goalState === "idle_waiting", `goal guard submit race smoke: 启动后状态异常 ${started.goalState}`);

    const finished = await waitForGoalSatisfied(origin, token, created.id);
    assert(
      typeof finished.lastOutputPreview === "string" &&
        finished.lastOutputPreview.includes("submitted:当前目标：等待自动续跑真正提交；请回复 ACK_OK"),
      `goal guard submit race smoke: 未看到真正提交后的 mock 输出: ${finished.lastOutputPreview}`,
    );

    const closed = await requestJson(origin, token, `/api/session/${created.id}/close`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "local", force: true }),
    });
    assert(closed.status === "closed", "goal guard submit race smoke: 关闭会话失败");

    console.log("goal-guard-submit-race-smoke: ok");
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
