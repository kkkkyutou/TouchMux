import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  throw new Error("runtime recovery smoke: backend 启动超时");
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert(response.ok, "runtime recovery smoke: 登录失败");
  const data = await response.json();
  assert(typeof data.token === "string" && data.token.length > 10, "runtime recovery smoke: token 无效");
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
    throw new Error(`runtime recovery smoke: ${pathname} 失败: ${response.status} ${text}`);
  }
  return response.json();
}

function sendKeysToTmux(sessionName, text, appendEnter = false) {
  const result = spawnSync("tmux", ["send-keys", "-t", sessionName, "-l", text], {
    stdio: "pipe",
    encoding: "utf8",
  });
  assert(result.status === 0, `runtime recovery smoke: tmux send-keys 失败 ${result.stderr || result.stdout}`);
  if (appendEnter) {
    const enterResult = spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    assert(
      enterResult.status === 0,
      `runtime recovery smoke: tmux send-keys Enter 失败 ${enterResult.stderr || enterResult.stdout}`,
    );
  }
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-runtime-recovery-"));
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

  const port = 8898;
  const password = "runtime-recovery-password";
  const env = {
    HOME: homeDir,
    TOUCHMUX_RUNTIME_MODE: "single",
    TOUCHMUX_PASSWORD: password,
    TOUCHMUX_JWT_SECRET: "runtime-recovery-jwt-secret-1234567890",
    TOUCHMUX_HOST: "127.0.0.1",
    TOUCHMUX_PORT: String(port),
    TOUCHMUX_DATA_DIR: dataDir,
    TOUCHMUX_WORKSPACE_ROOTS: workspaceDir,
    TOUCHMUX_CODEX_COMMAND: mockCodexPath,
    TOUCHMUX_ALLOW_INSECURE_DEFAULTS: "false",
  };

  const firstServer = startServer(env);
  let secondServer = null;

  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(origin);
    let token = await login(origin, password);
    const nodes = await requestJson(origin, token, "/api/nodes");
    const workspaceRoot = nodes.items[0]?.roots?.[0]?.rootPath;
    assert(typeof workspaceRoot === "string" && workspaceRoot === workspaceDir, "runtime recovery smoke: 根目录异常");

    const created = await requestJson(origin, token, "/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "local",
        title: "runtime recovery session",
        workspaceRoot,
        cwd: ".",
        mode: "new",
      }),
    });
    assert(typeof created.id === "string", "runtime recovery smoke: 创建会话失败");

    sendKeysToTmux(created.tmuxSessionName, "1. Alpha", true);
    sendKeysToTmux(created.tmuxSessionName, "2. Beta", true);
    await delay(500);

    let sessions = await requestJson(origin, token, "/api/session/list");
    let current = sessions.items.find((item) => item.id === created.id);
    assert(current?.hasTmuxSession === true, "runtime recovery smoke: 初次运行 tmux 会话异常");

    firstServer.child.kill("SIGTERM");
    await delay(400);

    secondServer = startServer(env);
    try {
      await waitForServer(origin);
      token = await login(origin, password);
      sessions = await requestJson(origin, token, "/api/session/list");
      current = sessions.items.find((item) => item.id === created.id);
      assert(current?.hasTmuxSession === true, "runtime recovery smoke: 重启后 tmux 会话未恢复");
      assert(
        current?.choiceOverlay?.visible === true,
        `runtime recovery smoke: 重启后选择项状态未恢复: ${JSON.stringify(current)}`,
      );
      assert(
        typeof current?.lastOutputPreview === "string" && current.lastOutputPreview.includes("Beta"),
        "runtime recovery smoke: 重启后最近输出预览未恢复",
      );
      console.log("runtime-recovery-smoke: ok");
    } finally {
      secondServer.child.kill("SIGTERM");
      await delay(200);
    }
  } finally {
    firstServer.child.kill("SIGTERM");
    if (secondServer) {
      secondServer.child.kill("SIGTERM");
    }
    await delay(200);
    const stderr = `${firstServer.readStderr()}${secondServer ? secondServer.readStderr() : ""}`.trim();
    if (stderr) {
      process.stderr.write(`${stderr}\n`);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
