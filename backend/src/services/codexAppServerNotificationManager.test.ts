import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerNotificationManager } from "./codexAppServerNotificationManager.js";
import type { ManagedSessionRecord } from "../types/models.js";

function buildSession(overrides: Partial<ManagedSessionRecord> = {}): ManagedSessionRecord {
  return {
    id: "session-notification-manager-test",
    nodeId: "local",
    title: "notification manager test",
    mode: "new",
    executionChannel: "app_server_remote_tui",
    status: "running",
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    tmuxSessionName: "notification-manager-test",
    sourceCodexSessionId: null,
    currentCodexSessionId: "thread-notification-manager-test",
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

test("notification manager stays inactive without tracked app-server threads", async () => {
  let initializeCalled = 0;
  const manager = new CodexAppServerNotificationManager(
    {
      listSessions: () => [],
    },
    5_000,
    () => ({
      async initialize() {
        initializeCalled += 1;
        return { ok: true, userAgent: "test", notifications: [] };
      },
      async disconnect() {
        return;
      },
    }),
  );

  await manager.reconcile();

  assert.equal(initializeCalled, 0);
  assert.deepEqual(manager.getSummary(), {
    active: false,
    connected: false,
    trackedThreadCount: 0,
    lastConnectedAt: null,
    lastError: null,
  });
});

test("notification manager connects when tracked app-server threads exist", async () => {
  let initializeCalled = 0;
  const manager = new CodexAppServerNotificationManager(
    {
      listSessions: () => [buildSession()],
    },
    5_000,
    () => ({
      async initialize() {
        initializeCalled += 1;
        return { ok: true, userAgent: "test", notifications: [] };
      },
      async disconnect() {
        return;
      },
    }),
  );

  await manager.reconcile();

  assert.equal(initializeCalled, 1);
  assert.equal(manager.getSummary().active, true);
  assert.equal(manager.getSummary().connected, true);
  assert.equal(manager.getSummary().trackedThreadCount, 1);
});

test("notification manager records initialize failures without crashing", async () => {
  const manager = new CodexAppServerNotificationManager(
    {
      listSessions: () => [buildSession()],
    },
    5_000,
    () => ({
      async initialize() {
        throw new Error("init failed");
      },
      async disconnect() {
        return;
      },
    }),
  );

  await manager.reconcile();

  assert.equal(manager.getSummary().active, true);
  assert.equal(manager.getSummary().connected, false);
  assert.equal(manager.getSummary().lastError, "init failed");
});
