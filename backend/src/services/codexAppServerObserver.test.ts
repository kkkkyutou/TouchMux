import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerObserver } from "./codexAppServerObserver.js";
import { codexAppServerThreadCache } from "./codexAppServerThreadCache.js";
import { codexAppServerNotificationCache } from "./codexAppServerNotificationCache.js";
import type { ManagedSessionRecord } from "../types/models.js";

function buildSession(overrides: Partial<ManagedSessionRecord> = {}): ManagedSessionRecord {
  return {
    id: "session-observer-test",
    nodeId: "local",
    title: "observer test",
    mode: "new",
    executionChannel: "app_server_remote_tui",
    status: "running",
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    tmuxSessionName: "observer-test",
    sourceCodexSessionId: null,
    currentCodexSessionId: "thread-observer-test",
    currentTaskRunId: null,
    prompt: null,
    command: "codex",
    createdAt: Date.now() - 5_000,
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
      goalText: "done",
      successKeywords: ["SUCCESS"],
      successCommand: null,
      idleTimeoutSec: 90,
      resumePromptTemplate: "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。",
      allowManualStopAfterSuccess: true,
    },
    ...overrides,
  };
}

function buildThreadRead(threadId: string) {
  return {
    threadId,
    cwd: "/workspace",
    rawThread: {
      id: threadId,
      cwd: "/workspace",
      createdAt: new Date(Date.now() - 4_000).toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
    },
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            phase: "final",
            text: "SUCCESS",
          },
        ],
      },
    ],
  };
}

test("app-server observer prefers fresh manager snapshot without opening live probe", async () => {
  const threadId = `thread-fresh-${Date.now()}`;
  codexAppServerThreadCache.setTrackedThreadIds([threadId]);
  codexAppServerThreadCache.recordThreadRead(buildThreadRead(threadId), Date.now());

  let clientUsed = false;
  const observer = new CodexAppServerObserver(() => ({
    async initialize() {
      clientUsed = true;
      throw new Error("should not initialize");
    },
    async readThread() {
      clientUsed = true;
      throw new Error("should not read");
    },
    async disconnect() {
      return;
    },
  }));

  const observation = await observer.inspectSession(
    buildSession({
      currentCodexSessionId: threadId,
    }),
    {
      goalConfig: buildSession().goalConfig,
    },
  );

  assert.equal(clientUsed, false);
  assert.equal(observation.available, true);
  assert.equal(observation.matchedSessionId, threadId);
  assert.equal(observation.turnState, "completed");
  assert.equal(observation.appServerTurnStateSource, "thread_read");
  assert.equal(observation.matchedStandaloneSuccess, true);
});

test("app-server observer falls back to cached manager snapshot when live probe fails", async () => {
  const threadId = `thread-stale-${Date.now()}`;
  codexAppServerThreadCache.setTrackedThreadIds([threadId]);
  codexAppServerThreadCache.recordThreadRead(buildThreadRead(threadId), 1);

  let initializeCalled = 0;
  const observer = new CodexAppServerObserver(() => ({
    async initialize() {
      initializeCalled += 1;
      throw new Error("probe init failed");
    },
    async readThread() {
      throw new Error("should not read");
    },
    async disconnect() {
      return;
    },
  }));

  const observation = await observer.inspectSession(
    buildSession({
      currentCodexSessionId: threadId,
    }),
    {
      goalConfig: buildSession().goalConfig,
    },
  );

  assert.equal(initializeCalled, 1);
  assert.equal(observation.available, true);
  assert.equal(observation.matchedSessionId, threadId);
  assert.equal(observation.appServerTurnStateSource, "thread_read");
  assert.equal(observation.matchedStandaloneSuccess, true);
});

test("app-server observer treats thread systemError as failed even if last turn reads completed", async () => {
  const threadId = `thread-system-error-${Date.now()}`;
  codexAppServerThreadCache.setTrackedThreadIds([threadId]);
  codexAppServerThreadCache.recordThreadRead({
    threadId,
    cwd: "/workspace",
    rawThread: {
      id: threadId,
      cwd: "/workspace",
      createdAt: new Date(Date.now() - 4_000).toISOString(),
      updatedAt: new Date().toISOString(),
      status: "systemError",
    },
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            phase: "final",
            text: "SUCCESS",
          },
        ],
      },
    ],
  }, Date.now());

  const observer = new CodexAppServerObserver(() => ({
    async initialize() {
      throw new Error("should not initialize");
    },
    async readThread() {
      throw new Error("should not read");
    },
    async disconnect() {
      return;
    },
  }));

  const observation = await observer.inspectSession(buildSession({
    currentCodexSessionId: threadId,
  }), {
    goalConfig: buildSession().goalConfig,
  });

  assert.equal(observation.available, true);
  assert.equal(observation.turnState, "failed");
  assert.equal(observation.appServerTurnStateSource, "failed_conflict");
});

test("app-server observer marks 403 responses service error as fatal", async () => {
  const threadId = `thread-403-fatal-${Date.now()}`;
  codexAppServerThreadCache.setTrackedThreadIds([threadId]);
  codexAppServerThreadCache.recordThreadRead({
    threadId,
    cwd: "/workspace",
    rawThread: {
      id: threadId,
      cwd: "/workspace",
      createdAt: new Date(Date.now() - 4_000).toISOString(),
      updatedAt: new Date().toISOString(),
      status: "failed",
    },
    turns: [
      {
        id: "turn-1",
        status: "failed",
        items: [
          {
            type: "commandExecution",
            command: "codex exec",
            error: "unexpected status 403 Forbidden: Service error, please retry, url: http://127.0.0.1:8327/v1/responses",
          },
        ],
      },
    ],
  }, Date.now());

  const observer = new CodexAppServerObserver(() => ({
    async initialize() {
      throw new Error("should not initialize");
    },
    async readThread() {
      throw new Error("should not read");
    },
    async disconnect() {
      return;
    },
  }));

  const observation = await observer.inspectSession(buildSession({
    currentCodexSessionId: threadId,
  }), {
    goalConfig: buildSession().goalConfig,
  });

  assert.equal(observation.available, true);
  assert.equal(observation.turnState, "failed");
  assert.match(observation.fatalError ?? "", /403 Forbidden/);
});

test("app-server observer keeps failed state when notification cache reports error after completed turn", async () => {
  const threadId = `thread-notify-failed-${Date.now()}`;
  codexAppServerThreadCache.setTrackedThreadIds([threadId]);
  codexAppServerThreadCache.recordThreadRead(buildThreadRead(threadId), Date.now());
  codexAppServerNotificationCache.ingest({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: "turn-1", status: "completed" },
    },
    receivedAt: Date.now() - 100,
  });
  codexAppServerNotificationCache.ingest({
    method: "thread/status/changed",
    params: {
      threadId,
      status: "systemError",
    },
    receivedAt: Date.now(),
  });

  const observer = new CodexAppServerObserver(() => ({
    async initialize() {
      throw new Error("should not initialize");
    },
    async readThread() {
      throw new Error("should not read");
    },
    async disconnect() {
      return;
    },
  }));

  const observation = await observer.inspectSession(buildSession({
    currentCodexSessionId: threadId,
  }), {
    goalConfig: buildSession().goalConfig,
  });

  assert.equal(observation.available, true);
  assert.equal(observation.turnState, "failed");
  assert.equal(observation.appServerTurnStateSource, "failed_conflict");
});

test("app-server observer ignores notification success messages before goal activation timestamp", async () => {
  const threadId = `thread-notify-window-${Date.now()}`;
  const now = Date.now();
  codexAppServerThreadCache.setTrackedThreadIds([threadId]);
  codexAppServerThreadCache.recordThreadRead({
    threadId,
    cwd: "/workspace",
    rawThread: {
      id: threadId,
      cwd: "/workspace",
      createdAt: new Date(now - 10_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      status: "completed",
    },
    turns: [],
  }, now);
  codexAppServerNotificationCache.ingest({
    method: "item/completed",
    params: {
      threadId,
      item: {
        type: "agentMessage",
        phase: "final",
        text: "SUCCESS",
      },
    },
    receivedAt: now - 8_000,
  });

  const observer = new CodexAppServerObserver(() => ({
    async initialize() {
      throw new Error("should not initialize");
    },
    async readThread() {
      throw new Error("should not read");
    },
    async disconnect() {
      return;
    },
  }));

  const observation = await observer.inspectSession(buildSession({
    currentCodexSessionId: threadId,
  }), {
    goalConfig: buildSession().goalConfig,
    sinceTimestamp: now - 2_000,
  });

  assert.equal(observation.matchedStandaloneSuccess, false);
  assert.equal(observation.matchedSuccessKeyword, null);
  assert.equal(observation.successMessage, null);
});

test("app-server observer ignores thread read success payload from turn completed before goal activation", async () => {
  const threadId = `thread-turn-window-${Date.now()}`;
  const now = Date.now();
  codexAppServerThreadCache.setTrackedThreadIds([threadId]);
  codexAppServerThreadCache.recordThreadRead({
    threadId,
    cwd: "/workspace",
    rawThread: {
      id: threadId,
      cwd: "/workspace",
      createdAt: new Date(now - 12_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      status: "completed",
    },
    turns: [
      {
        id: "turn-1",
        status: "completed",
        completedAt: new Date(now - 6_000).toISOString(),
        items: [
          {
            type: "agentMessage",
            phase: "final",
            text: "SUCCESS",
          },
        ],
      },
    ],
  }, now);

  const observer = new CodexAppServerObserver(() => ({
    async initialize() {
      throw new Error("should not initialize");
    },
    async readThread() {
      throw new Error("should not read");
    },
    async disconnect() {
      return;
    },
  }));

  const observation = await observer.inspectSession(buildSession({
    currentCodexSessionId: threadId,
  }), {
    goalConfig: buildSession().goalConfig,
    sinceTimestamp: now - 2_000,
  });

  assert.equal(observation.matchedStandaloneSuccess, false);
  assert.equal(observation.matchedSuccessKeyword, null);
  assert.equal(observation.successMessage, null);
});

test("app-server observer ignores running-turn fatal payload from before goal activation", async () => {
  const threadId = `thread-running-fatal-window-${Date.now()}`;
  const now = Date.now();
  codexAppServerThreadCache.setTrackedThreadIds([threadId]);
  codexAppServerThreadCache.recordThreadRead({
    threadId,
    cwd: "/workspace",
    rawThread: {
      id: threadId,
      cwd: "/workspace",
      createdAt: new Date(now - 20_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      status: "inProgress",
    },
    turns: [
      {
        id: "turn-1",
        status: "inProgress",
        startedAt: new Date(now - 15_000).toISOString(),
        items: [
          {
            type: "commandExecution",
            command: "codex exec",
            error: "unexpected status 403 Forbidden: Service error, please retry, url: http://127.0.0.1:8327/v1/responses",
          },
        ],
      },
    ],
  }, now);

  const observer = new CodexAppServerObserver(() => ({
    async initialize() {
      throw new Error("should not initialize");
    },
    async readThread() {
      throw new Error("should not read");
    },
    async disconnect() {
      return;
    },
  }));

  const observation = await observer.inspectSession(buildSession({
    currentCodexSessionId: threadId,
  }), {
    goalConfig: buildSession().goalConfig,
    sinceTimestamp: now - 2_000,
  });

  assert.equal(observation.turnState, "running");
  assert.equal(observation.fatalError, null);
  assert.equal(observation.recentErrors.length, 0);
});
