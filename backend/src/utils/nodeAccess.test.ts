import test from "node:test";
import assert from "node:assert/strict";
import { deriveWebSocketBaseUrl, resolveNodeDirectAccess } from "./nodeAccess.js";

test("deriveWebSocketBaseUrl converts http and https origins", () => {
  assert.equal(deriveWebSocketBaseUrl("http://node-a.example.com"), "ws://node-a.example.com");
  assert.equal(deriveWebSocketBaseUrl("https://node-a.example.com/base"), "wss://node-a.example.com/base");
});

test("deriveWebSocketBaseUrl rejects invalid schemes", () => {
  assert.equal(deriveWebSocketBaseUrl("ftp://node-a.example.com"), null);
  assert.equal(deriveWebSocketBaseUrl("not-a-url"), null);
});

test("resolveNodeDirectAccess requires public http base url", () => {
  assert.deepEqual(resolveNodeDirectAccess({ publicBaseUrl: "", publicWsBaseUrl: "" }), {
    directHttpBaseUrl: null,
    directWsBaseUrl: null,
    directAccessReady: false,
  });
});

test("resolveNodeDirectAccess derives websocket base when omitted", () => {
  assert.deepEqual(resolveNodeDirectAccess({ publicBaseUrl: "https://node-a.example.com/" }), {
    directHttpBaseUrl: "https://node-a.example.com",
    directWsBaseUrl: "wss://node-a.example.com",
    directAccessReady: true,
  });
});

test("resolveNodeDirectAccess prefers explicit websocket base url", () => {
  assert.deepEqual(
    resolveNodeDirectAccess({
      publicBaseUrl: "https://node-a.example.com",
      publicWsBaseUrl: "wss://terminal.node-a.example.com/",
    }),
    {
      directHttpBaseUrl: "https://node-a.example.com",
      directWsBaseUrl: "wss://terminal.node-a.example.com",
      directAccessReady: true,
    },
  );
});
