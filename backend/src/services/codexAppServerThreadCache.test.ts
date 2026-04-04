import test from "node:test";
import assert from "node:assert/strict";
import { codexAppServerThreadCache, CodexAppServerThreadCache } from "./codexAppServerThreadCache.js";
import { CodexAppServerThreadManager } from "./codexAppServerThreadManager.js";
import type { ManagedSessionRecord } from "../types/models.js";

function buildSession(overrides: Partial<ManagedSessionRecord> = {}): ManagedSessionRecord {
  return {
    id: "session-1",
    nodeId: "local",
    title: "test",
    mode: "new",
    executionChannel: "app_server_remote_tui",
    status: "running",
    cwd: "/tmp",
    workspaceRoot: "/tmp",
    tmuxSessionName: "tmux-test",
    sourceCodexSessionId: null,
    currentCodexSessionId: "thread-1",
    currentTaskRunId: null,
    prompt: null,
    command: "codex",
    createdAt: 1,
    updatedAt: 1,
    lastOutputAt: null,
    lastOutputPreview: "",
    goalState: "disabled",
    guardDecisionState: "disabled",
    guardDecisionReason: null,
    goalSpec: null,
    verificationSpec: null,
    verificationReceipt: null,
    successEvidence: null,
    goalConfig: {
      enabled: false,
      goalText: "",
      successKeywords: [],
      successCommand: null,
      idleTimeoutSec: 90,
      resumePromptTemplate: "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。",
      allowManualStopAfterSuccess: true,
    },
    ...overrides,
  };
}

test("thread cache summarizes tracked snapshot state", () => {
  const cache = new CodexAppServerThreadCache();

  cache.setTrackedThreadIds(["thread-1"]);
  cache.recordThreadRead({
    threadId: "thread-1",
    cwd: "/workspace",
    turns: [{ id: "turn-1" }, { id: "turn-2" }],
    rawThread: {
      id: "thread-1",
      updatedAt: "2026-04-04T12:00:00.000Z",
    },
  }, 200);

  assert.deepEqual(cache.getThreadManagerSummary("thread-1"), {
    threadId: "thread-1",
    tracked: true,
    hasSnapshot: true,
    cachedTurnCount: 2,
    lastSyncedAt: 200,
    lastSyncOk: true,
    lastError: null,
    threadUpdatedAt: Date.parse("2026-04-04T12:00:00.000Z"),
  });
});

test("thread manager syncs tracked app-server threads into shared cache", async () => {
  codexAppServerThreadCache.setTrackedThreadIds([]);
  const manager = new CodexAppServerThreadManager(
    {
      listSessions: () => [
        buildSession({
          id: "s1",
          currentCodexSessionId: "thread-success",
        }),
        buildSession({
          id: "s2",
          currentCodexSessionId: "thread-fail",
        }),
        buildSession({
          id: "s3",
          executionChannel: "tmux_local_tui",
          currentCodexSessionId: "thread-ignored",
        }),
        buildSession({
          id: "s4",
          status: "closed",
          currentCodexSessionId: "thread-closed",
        }),
      ],
    },
    5_000,
    () => ({
      async initialize() {
        return { ok: true, userAgent: "test", notifications: [] };
      },
      async readThread(threadId: string) {
        if (threadId === "thread-fail") {
          throw new Error("read failed");
        }
        return {
          threadId,
          cwd: "/workspace",
          turns: [{ id: "turn-1" }],
          rawThread: { id: threadId, updatedAt: "2026-04-04T12:00:00.000Z" },
        };
      },
      async disconnect() {
        return;
      },
    }),
  );

  await manager.syncOnce();

  const successSummary = codexAppServerThreadCache.getThreadManagerSummary("thread-success");
  assert.equal(successSummary.tracked, true);
  assert.equal(successSummary.hasSnapshot, true);
  assert.equal(successSummary.lastSyncOk, true);

  const failedSummary = codexAppServerThreadCache.getThreadManagerSummary("thread-fail");
  assert.equal(failedSummary.tracked, true);
  assert.equal(failedSummary.lastSyncOk, false);
  assert.equal(failedSummary.lastError, "read failed");

  const ignoredSummary = codexAppServerThreadCache.getThreadManagerSummary("thread-ignored");
  assert.equal(ignoredSummary.tracked, false);
  assert.equal(ignoredSummary.hasSnapshot, false);
});
