import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

async function main() {
  const [
    { CodexAppServerProbeClient },
    { codexAppServerNotificationCache },
    { CodexAppServerObserver },
  ] = await Promise.all([
    import("../backend/dist/services/codexAppServerProbe.js"),
    import("../backend/dist/services/codexAppServerNotificationCache.js"),
    import("../backend/dist/services/codexAppServerObserver.js"),
  ]);

  const client = new CodexAppServerProbeClient();
  const observer = new CodexAppServerObserver();
  const cwd = os.tmpdir();

  try {
    await client.initialize({
      clientInfo: {
        name: "touchmux-app-server-notification-cache-smoke",
        version: "0.1.0",
        title: "TouchMux App Server Notification Cache Smoke",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    const thread = await client.startThread({
      cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
    });

    const turn = await client.startTurn({
      threadId: thread.threadId,
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: true,
      },
      input: [
        {
          type: "text",
          text: "只回复单独一行 SUCCESS，不要调用任何工具，不要输出解释。",
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

    const cachedNotifications = codexAppServerNotificationCache.listThreadNotifications(thread.threadId);
    assert.ok(cachedNotifications.length > 0, "app-server notification cache smoke: 未缓存任何 thread notification");
    assert.ok(
      cachedNotifications.some((notification) => notification.method === "turn/started"),
      "app-server notification cache smoke: 未缓存 turn/started",
    );
    assert.ok(
      cachedNotifications.some((notification) => notification.method === "turn/completed"),
      "app-server notification cache smoke: 未缓存 turn/completed",
    );

    const observation = await observer.inspectSession({
      id: "notification-cache-smoke-session",
      nodeId: "local",
      title: "notification cache smoke",
      mode: "new",
      executionChannel: "app_server_remote_tui",
      status: "running",
      cwd: ".",
      workspaceRoot: cwd,
      tmuxSessionName: "touchmux_fake_notification_cache",
      sourceCodexSessionId: null,
      currentCodexSessionId: thread.threadId,
      currentTaskRunId: null,
      prompt: null,
      command: "codex app-server notification cache smoke",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOutputAt: null,
      lastOutputPreview: "",
      goalState: "running",
      guardDecisionState: "observing_codex_turn",
      guardDecisionReason: null,
      goalSpec: null,
      verificationSpec: null,
      verificationReceipt: null,
      successEvidence: null,
      goalConfig: {
        enabled: true,
        goalText: "输出 SUCCESS",
        successKeywords: ["SUCCESS"],
        successCommand: null,
        idleTimeoutSec: 15,
        resumePromptTemplate: "完成后输出 SUCCESS",
        allowManualStopAfterSuccess: true,
      },
    }, {
      sinceTimestamp: null,
      goalConfig: {
        enabled: true,
        goalText: "输出 SUCCESS",
        successKeywords: ["SUCCESS"],
        successCommand: null,
        idleTimeoutSec: 15,
        resumePromptTemplate: "完成后输出 SUCCESS",
        allowManualStopAfterSuccess: true,
      },
    });

    assert.equal(observation.available, true, "app-server notification cache smoke: observer 未返回 available");
    assert.equal(observation.turnState, "completed", "app-server notification cache smoke: observer 未识别 completed");
    assert.equal(observation.matchedStandaloneSuccess, true, "app-server notification cache smoke: observer 未识别 SUCCESS");

    console.log("smoke-codex-app-server-notification-cache: ok");
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
