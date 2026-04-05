import test from "node:test";
import assert from "node:assert/strict";
import { detectTerminalFatalStopSignal } from "./sessionManager.js";

test("detectTerminalFatalStopSignal matches supported fatal terminal patterns", () => {
  assert.equal(
    detectTerminalFatalStopSignal("request failed: exceeded retry limit after several attempts"),
    "exceeded retry limit",
  );
  assert.equal(
    detectTerminalFatalStopSignal("network error: ECONNRESET while connecting"),
    "network error",
  );
});

test("detectTerminalFatalStopSignal ignores empty or unrelated text", () => {
  assert.equal(detectTerminalFatalStopSignal(""), null);
  assert.equal(
    detectTerminalFatalStopSignal("SUCCESS\nall checks passed\nno blocking issue"),
    null,
  );
});
