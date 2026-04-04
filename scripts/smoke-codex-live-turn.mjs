import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const { CodexAppServerProbeClient } = await import("../backend/dist/services/codexAppServerProbe.js");
  const client = new CodexAppServerProbeClient();
  const cwd = path.join(os.tmpdir());
  try {
    await client.initialize({
      clientInfo: {
        name: "touchmux-live-turn-smoke",
        version: "0.1.0",
        title: "TouchMux Live Turn Smoke",
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
    assert.ok(thread.threadId, "codex live turn smoke: thread/start 未返回 thread id");

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
    assert.ok(turn.turnId, "codex live turn smoke: turn/start 未返回 turn id");

    await client.waitForNotification(
      (notification) => notification.method === "turn/started",
      20_000,
    );

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

    await delay(500);
    const notifications = client.listNotifications();
    const fatalNotification = notifications.find((notification) =>
      notification.method === "error"
      || notification.method === "turn/failed"
      || notification.method === "item/commandExecution/requestApproval"
      || notification.method === "item/fileChange/requestApproval",
    );
    assert.equal(fatalNotification, undefined, "codex live turn smoke: live turn 出现失败或越权请求");

    const agentText = notifications
      .filter((notification) => notification.method === "item/agentMessage/delta")
      .map((notification) => {
        const params = notification.params;
        if (!params || typeof params !== "object") {
          return "";
        }
        return typeof params.delta === "string" ? params.delta : "";
      })
      .join("");

    assert.ok(agentText.includes("SUCCESS"), `codex live turn smoke: 未在 agent message delta 中看到 SUCCESS，实际输出=${JSON.stringify(agentText)}`);
    const threadRead = await client.readThread(thread.threadId, true);
    assert.ok(Array.isArray(threadRead.turns) && threadRead.turns.length > 0, "codex live turn smoke: includeTurns 未返回 turn 列表");
    const lastTurn = threadRead.turns.at(-1);
    assert.ok(lastTurn && typeof lastTurn === "object", "codex live turn smoke: 最后一个 turn 结构缺失");
    assert.equal(lastTurn.status, "completed", "codex live turn smoke: thread/read 返回的最后 turn 状态不是 completed");
    assert.ok(
      Array.isArray(lastTurn.items) && lastTurn.items.some((item) => item && typeof item === "object" && item.type === "agentMessage" && item.text === "SUCCESS"),
      "codex live turn smoke: thread/read 未返回 SUCCESS agentMessage",
    );
    console.log("smoke-codex-live-turn: ok");
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
