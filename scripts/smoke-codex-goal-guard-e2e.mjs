import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

async function waitFor(check, message, attempts = 80, intervalMs = 500) {
  let lastValue = null;
  for (let index = 0; index < attempts; index += 1) {
    lastValue = await check();
    if (lastValue) {
      return lastValue;
    }
    await delay(intervalMs);
  }
  throw new Error(`${message}; lastValue=${JSON.stringify(lastValue)}`);
}

async function runCodexExec(cwd, prompt) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        prompt,
      ],
      {
        cwd,
        env: {
          ...process.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`codex exec failed: code=${code ?? "null"} stderr=${stderr}`));
        return;
      }
      resolve({
        stdout,
        stderr,
      });
    });
  });
}

function parseJsonLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-codex-goal-guard-e2e-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  const markerName = `goal-guard-cli-marker-${Date.now()}.txt`;
  const markerPath = path.join(workspaceRoot, markerName);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  process.env.TOUCHMUX_DATA_DIR = dataDir;
  process.env.TOUCHMUX_WORKSPACE_ROOTS = workspaceRoot;
  process.env.TOUCHMUX_RUNTIME_MODE = "single";
  process.env.TOUCHMUX_PASSWORD = "codex-goal-guard-e2e-password";
  process.env.TOUCHMUX_JWT_SECRET = "codex-goal-guard-e2e-jwt-secret-1234567890";
  process.env.TOUCHMUX_ALLOW_INSECURE_DEFAULTS = "false";

  const [{ SessionRepository }, { SessionManager }] = await Promise.all([
    import("../backend/dist/services/sessionRepository.js"),
    import("../backend/dist/services/sessionManager.js"),
  ]);

  const repository = new SessionRepository();
  const sessionManager = new SessionManager(repository);

  const sessionId = `live-e2e-${crypto.randomUUID()}`;
  const tmuxSessionName = `touchmux_fake_${crypto.randomUUID().slice(0, 8)}`;

  try {
    repository.createSession({
      id: sessionId,
      nodeId: "local",
      title: "codex goal guard live e2e",
      mode: "new",
      executionChannel: "tmux_local_tui",
      status: "running",
      cwd: ".",
      workspaceRoot,
      tmuxSessionName,
      sourceCodexSessionId: null,
      prompt: null,
      command: "codex exec live goal guard e2e",
      goalConfig: {
        enabled: false,
      },
    });

    sessionManager.updateGoalConfig(sessionId, {
      enabled: true,
      goalText: `创建 ${markerName} 并在完成后输出 SUCCESS`,
      successKeywords: ["SUCCESS"],
      successCommand: `file_exists:${markerName}`,
      idleTimeoutSec: 15,
      resumePromptTemplate: "继续执行当前目标，完成后只输出 SUCCESS。",
      allowManualStopAfterSuccess: true,
    });

    const run = await runCodexExec(
      workspaceRoot,
      `请不要做额外分析，也不要输出解释。只在当前目录创建文件 ${markerName}，内容写入 READY。完成后只回复单独一行 SUCCESS。`,
    );
    const events = parseJsonLines(run.stdout);
    const threadStarted = events.find((entry) => entry.type === "thread.started" && typeof entry.thread_id === "string");
    assert.ok(threadStarted?.thread_id, `codex goal guard e2e: 未从 codex exec 输出中解析到 thread id; stdout=${run.stdout}`);

    repository.updateSession(sessionId, {
      currentCodexSessionId: threadStarted.thread_id,
    });

    await waitFor(
      async () => (fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : null),
      "codex goal guard e2e: 未看到真实产物文件落地",
      20,
      250,
    );

    const observation = await waitFor(
      async () => {
        const current = await sessionManager.inspectCodexSession(sessionId);
        if (current.available && current.turnState === "completed" && current.matchedStandaloneSuccess) {
          return current;
        }
        return null;
      },
      "codex goal guard e2e: 未观察到真实 Codex rollout 中的 completed + SUCCESS",
      30,
      500,
    );

    assert.equal(observation.matchedSessionId, threadStarted.thread_id, "codex goal guard e2e: observer 未精确匹配到真实 thread id");
    assert.equal(observation.turnState, "completed", "codex goal guard e2e: turnState 应为 completed");
    assert.equal(observation.matchedStandaloneSuccess, true, "codex goal guard e2e: 未识别独立 SUCCESS");

    const passed = await sessionManager.evaluateGoal(sessionId);
    assert.equal(passed, true, "codex goal guard e2e: evaluateGoal 未通过");

    const summary = sessionManager.getSessionSummary(sessionId);
    assert.ok(summary, "codex goal guard e2e: 会话 summary 缺失");
    assert.equal(summary.guardDecisionState, "satisfied", "codex goal guard e2e: 守卫未进入 satisfied");
    assert.equal(summary.verificationReceipt?.status, "success", "codex goal guard e2e: receipt.status 应为 success");
    assert.equal(summary.verificationReceipt?.verificationKind, "file_exists", "codex goal guard e2e: receipt.verificationKind 应为 file_exists");
    assert.equal(summary.successEvidence?.kind, "command_check", "codex goal guard e2e: successEvidence.kind 应收敛为 command_check");

    console.log("smoke-codex-goal-guard-e2e: ok");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
