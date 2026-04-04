import assert from "node:assert/strict";

async function main() {
  const { CodexAppServerProbeClient } = await import("../backend/dist/services/codexAppServerProbe.js");
  const client = new CodexAppServerProbeClient();
  try {
    const initResult = await client.initialize({
      clientInfo: {
        name: "touchmux-smoke",
        version: "0.1.0",
        title: "TouchMux Smoke",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    assert.equal(initResult.ok, true, "codex app-server smoke: initialize 未返回 ok");
    assert.ok(Array.isArray(initResult.notifications), "codex app-server smoke: notifications 结构异常");

    const threadResult = await client.startThread({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: true,
    });
    assert.ok(typeof threadResult.threadId === "string" && threadResult.threadId.length > 0, "codex app-server smoke: thread/start 未返回 thread id");
    const threadReadResult = await client.readThread(threadResult.threadId);
    assert.equal(threadReadResult.threadId, threadResult.threadId, "codex app-server smoke: thread/read 返回的 thread id 不一致");

    console.log("smoke-codex-app-server: ok");
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
