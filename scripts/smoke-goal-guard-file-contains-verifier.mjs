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
        server.close(() => reject(new Error("file contains verifier smoke: 无法分配空闲端口")));
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
  throw new Error("file contains verifier smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`file contains verifier smoke: 登录失败: ${response.status} ${text}`);
  }
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "file contains verifier smoke: token 无效");
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
    throw new Error(`file contains verifier smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function waitForSatisfied(origin, token, sessionId, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const sessions = await requestJson(origin, token, "/api/session/list");
    const current = sessions.items.find((item) => item.id === sessionId);
    if (current?.guardDecisionState === "satisfied") {
      return current;
    }
    await delay(250);
  }
  throw new Error("file contains verifier smoke: 未进入 satisfied");
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-file-contains-verifier-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  const outputFile = path.join(workspaceDir, "log.txt");
  const expectedText = "READY";
  const mockCodexPath = path.join(tempRoot, "mock-codex-file-contains.sh");
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "history.jsonl"), "", "utf8");
  fs.writeFileSync(
    mockCodexPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"${1:-}\" == \"--help\" ]]; then echo \"mock-codex-file-contains\"; exit 0; fi",
      "echo ready",
      "while IFS= read -r line; do",
      `  printf 'booting\\n${expectedText}\\n' > ${JSON.stringify(outputFile)}`,
      "  echo SUCCESS",
      "done",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(mockCodexPath, 0o755);

  const port = await reservePort();
  const password = "file-contains-verifier-password";
  const server = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      TOUCHMUX_RUNTIME_MODE: "single",
      TOUCHMUX_PASSWORD: password,
      TOUCHMUX_JWT_SECRET: "file-contains-verifier-jwt-secret-1234567890",
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
    assert(workspaceRoot === workspaceDir, "file contains verifier smoke: 根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "file contains verifier smoke session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string", "file contains verifier smoke: 创建会话失败");

    const started = await requestJson(origin, token, `/api/goal-guard/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        goalText: "等待结构化 verifier 验收 log.txt 中 READY 标记",
        successKeywords: ["SUCCESS"],
        successCommand: `file_contains:log.txt::${expectedText}`,
        idleTimeoutSec: 1,
        resumePromptTemplate: "继续执行并写出 READY 到 log.txt",
        allowManualStopAfterSuccess: true,
      }),
    });
    assert(started.verificationSpec?.kind === "file_contains", "file contains verifier smoke: verificationSpec.kind 应为 file_contains");

    const finished = await waitForSatisfied(origin, token, created.id);
    assert(finished.verificationReceipt?.status === "success", "file contains verifier smoke: verifier receipt 未标记成功");
    assert(finished.verificationReceipt?.verificationKind === "file_contains", "file contains verifier smoke: receipt kind 应为 file_contains");
    assert(fs.readFileSync(outputFile, "utf8").includes(expectedText), "file contains verifier smoke: log.txt 未包含 READY");

    const closed = await requestJson(origin, token, `/api/session/${created.id}/close`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "local", force: true }),
    });
    assert(closed.status === "closed", "file contains verifier smoke: 关闭会话失败");

    console.log("goal-guard-file-contains-verifier-smoke: ok");
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
