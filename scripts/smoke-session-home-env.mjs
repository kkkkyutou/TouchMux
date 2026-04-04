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
        server.close(() => reject(new Error("session home env smoke: 无法分配空闲端口")));
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
  throw new Error("session home env smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`session home env smoke: 登录失败: ${response.status} ${text}`);
  }
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "session home env smoke: token 无效");
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
    throw new Error(`session home env smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

async function waitForEnvFile(filePath, expectedList, attempts = 30) {
  let lastContent = "";
  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      lastContent = content;
      if (expectedList.every((item) => content.includes(item))) {
        return content;
      }
    }
    await delay(250);
  }
  throw new Error(`session home env smoke: 未在 env 文件中看到预期环境变量 ${expectedList.join(", ")}; lastContent=${lastContent}`);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-session-home-env-"));
  const processHome = path.join(tempRoot, "process-home");
  const sessionHome = path.join(tempRoot, "session-home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  const mockCodexPath = path.join(tempRoot, "mock-codex-env.sh");
  const envReportPath = path.join(workspaceDir, "env-report.txt");
  fs.mkdirSync(processHome, { recursive: true });
  fs.mkdirSync(path.join(sessionHome, ".codex"), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(mockCodexPath), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"--help\" ]]; then echo \"mock-codex-env\"; exit 0; fi",
    `cat > ${JSON.stringify(envReportPath)} <<EOF`,
    "HOME=$HOME",
    "TOUCHMUX_SESSION_HOME=${TOUCHMUX_SESSION_HOME:-}",
    "CODEX_HOME=${CODEX_HOME:-}",
    "EOF",
    "echo env-written",
    "sleep 2",
    "",
  ].join("\n"), "utf8");
  fs.chmodSync(mockCodexPath, 0o755);

  const port = await reservePort();
  const password = "session-home-env-password";
  const server = spawn("node", [backendEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: processHome,
      TOUCHMUX_SESSION_HOME: sessionHome,
      TOUCHMUX_RUNTIME_MODE: "single",
      TOUCHMUX_PASSWORD: password,
      TOUCHMUX_JWT_SECRET: "session-home-env-jwt-secret-1234567890",
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
    assert(workspaceRoot === workspaceDir, "session home env smoke: 根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "session home env smoke session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string", "session home env smoke: 创建会话失败");

    const envContent = await waitForEnvFile(envReportPath, [
      `HOME=${processHome}`,
      `TOUCHMUX_SESSION_HOME=${sessionHome}`,
      `CODEX_HOME=${path.join(sessionHome, ".codex")}`,
    ]);
    const detail = await requestJson(origin, token, `/api/session/${created.id}/detail`);
    assert(typeof detail.lastOutputPreview === "string", "session home env smoke: detail 输出预览异常");
    assert(envContent.includes(`HOME=${processHome}`), "session home env smoke: HOME 未保留服务进程 HOME");

    const closed = await requestJson(origin, token, `/api/session/${created.id}/close`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "local", force: true }),
    });
    assert(closed.status === "closed", "session home env smoke: 关闭会话失败");

    console.log("smoke-session-home-env: ok");
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
