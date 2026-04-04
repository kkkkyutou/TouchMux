import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerNotificationCache } from "./codexAppServerNotificationCache.js";

test("notification cache groups notifications by thread id from threadId or thread.id", () => {
  const cache = new CodexAppServerNotificationCache();

  cache.ingest({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
    receivedAt: 100,
  });
  cache.ingest({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
    receivedAt: 120,
  });
  cache.ingest({
    method: "turn/completed",
    params: {
      threadId: "thread-2",
      turn: { id: "turn-2" },
    },
    receivedAt: 140,
  });

  const thread1 = cache.listThreadNotifications("thread-1");
  const thread2 = cache.listThreadNotifications("thread-2");

  assert.equal(thread1.length, 2);
  assert.deepEqual(thread1.map((entry) => entry.method), ["turn/started", "thread/started"]);
  assert.equal(cache.getThreadUpdatedAt("thread-1"), 120);

  assert.equal(thread2.length, 1);
  assert.equal(thread2[0]?.method, "turn/completed");
  assert.equal(cache.getThreadUpdatedAt("thread-2"), 140);
});

test("notification cache ignores notifications without resolvable thread identity", () => {
  const cache = new CodexAppServerNotificationCache();

  cache.ingest({
    method: "error",
    params: {
      error: { message: "no thread info" },
    },
    receivedAt: 200,
  });

  assert.deepEqual(cache.listThreadNotifications("missing"), []);
  assert.equal(cache.getThreadUpdatedAt("missing"), null);
});
