import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-codex-app-server-goal-guard-e2e-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  const markerName = `goal-guard-app-server-marker-${Date.now()}.txt`;
  const markerPath = path.join(workspaceRoot, markerName);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(markerPath, "READY\n", "utf8");

  process.env.TOUCHMUX_DATA_DIR = dataDir;
  process.env.TOUCHMUX_WORKSPACE_ROOTS = workspaceRoot;
  process.env.TOUCHMUX_RUNTIME_MODE = "single";
  process.env.TOUCHMUX_PASSWORD = "codex-app-server-goal-guard-e2e-password";
  process.env.TOUCHMUX_JWT_SECRET = "codex-app-server-goal-guard-e2e-jwt-secret-1234567890";
  process.env.TOUCHMUX_ALLOW_INSECURE_DEFAULTS = "false";

  const [{ SessionRepository }, { SessionManager }, { CodexAppServerProbeClient }] = await Promise.all([
    import("../backend/dist/services/sessionRepository.js"),
    import("../backend/dist/services/sessionManager.js"),
    import("../backend/dist/services/codexAppServerProbe.js"),
  ]);

  const repository = new SessionRepository();
  const sessionManager = new SessionManager(repository);
  const client = new CodexAppServerProbeClient();

  const sessionId = `app-server-e2e-${crypto.randomUUID()}`;
  const tmuxSessionName = `touchmux_fake_${crypto.randomUUID().slice(0, 8)}`;

  try {
    repository.createSession({
      id: sessionId,
      nodeId: "local",
      title: "codex app-server goal guard live e2e",
      mode: "new",
      executionChannel: "app_server_remote_tui",
      status: "running",
      cwd: ".",
      workspaceRoot,
      tmuxSessionName,
      sourceCodexSessionId: null,
      prompt: null,
      command: "codex app-server live goal guard e2e",
      goalConfig: {
        enabled: false,
      },
    });

    sessionManager.updateGoalConfig(sessionId, {
      enabled: true,
      goalText: `确认 ${markerName} 已就绪，并在完成后输出 SUCCESS`,
      successKeywords: ["SUCCESS"],
      successCommand: `file_exists:${markerName}`,
      idleTimeoutSec: 15,
      resumePromptTemplate: "继续执行当前目标，完成后只输出 SUCCESS。",
      allowManualStopAfterSuccess: true,
    });

    await client.initialize({
      clientInfo: {
        name: "touchmux-goal-guard-app-server-e2e",
        version: "0.1.0",
        title: "TouchMux Goal Guard App Server E2E",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    const thread = await client.startThread({
      cwd: workspaceRoot,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
    });

    repository.updateSession(sessionId, {
      currentCodexSessionId: thread.threadId,
    });

    const turn = await client.startTurn({
      threadId: thread.threadId,
      cwd: workspaceRoot,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: true,
      },
      input: [
        {
          type: "text",
          text: `当前目录中已经存在文件 ${markerName}。请不要调用任何工具，也不要输出解释。确认目标满足后，只回复单独一行 SUCCESS。`,
        },
      ],
      personality: "pragmatic",
    });

    await client.waitForNotification(
      (notification) =>
        notification.method === "turn/completed"
        && notification.params
        && typeof notification.params === "object"
        && notification.params.turn
        && typeof notification.params.turn === "object"
        && notification.params.turn.id === turn.turnId,
      120_000,
    );

    await waitFor(
      async () => (fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : null),
      "codex app-server goal guard e2e: 未看到真实产物文件落地",
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
      "codex app-server goal guard e2e: 未观察到 app-server thread/read 中的 completed + SUCCESS",
      30,
      500,
    );

    assert.equal(observation.matchedSessionId, thread.threadId, "codex app-server goal guard e2e: observer 未精确匹配到真实 thread id");
    assert.equal(observation.matchedBy, "current_session_id", "codex app-server goal guard e2e: observer 绑定模式不是 current_session_id");
    assert.equal(observation.turnState, "completed", "codex app-server goal guard e2e: turnState 应为 completed");
    assert.equal(observation.matchedStandaloneSuccess, true, "codex app-server goal guard e2e: 未识别独立 SUCCESS");

    const passed = await sessionManager.evaluateGoal(sessionId);
    assert.equal(passed, true, "codex app-server goal guard e2e: evaluateGoal 未通过");

    const summary = sessionManager.getSessionSummary(sessionId);
    assert.ok(summary, "codex app-server goal guard e2e: 会话 summary 缺失");
    assert.equal(summary.guardDecisionState, "satisfied", "codex app-server goal guard e2e: 守卫未进入 satisfied");
    assert.equal(summary.verificationReceipt?.status, "success", "codex app-server goal guard e2e: receipt.status 应为 success");
    assert.equal(summary.verificationReceipt?.verificationKind, "file_exists", "codex app-server goal guard e2e: receipt.verificationKind 应为 file_exists");
    assert.equal(summary.successEvidence?.kind, "command_check", "codex app-server goal guard e2e: successEvidence.kind 应收敛为 command_check");

    console.log("smoke-codex-app-server-goal-guard-e2e: ok");
  } finally {
    try {
      const currentThreadId = repository.getSession(sessionId)?.currentCodexSessionId ?? null;
      if (currentThreadId) {
        await client.archiveThread(currentThreadId);
      }
    } catch (error) {
      // ignore cleanup failures in smoke teardown
    }
    await client.disconnect();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
