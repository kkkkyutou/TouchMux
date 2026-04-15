import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGuardPromptText,
  detectCodexSubmitBlockedReason,
  detectTerminalSuccessKeywordMatch,
  detectTerminalFatalStopSignal,
  SessionManager,
} from "./sessionManager.js";

function createManager(): SessionManager {
  const repository = {
    listRuntimeStates: () => [],
    listSessions: () => [],
  };
  return new SessionManager(repository as never);
}

test("sendLiteral clears tmux copy-mode before sending text and Enter", () => {
  const manager = createManager() as any;
  const calls: Array<{ kind: "clear" | "run"; args: string[] | string }> = [];

  manager.clearTmuxCopyMode = (target: string) => {
    calls.push({ kind: "clear", args: target });
  };
  manager.pasteLiteral = (target: string, text: string) => {
    calls.push({ kind: "run", args: ["paste", target, text] });
  };
  manager.runTmux = (args: string[]) => {
    calls.push({ kind: "run", args });
  };

  manager.sendLiteral("guard-session", "resume prompt", true);

  assert.deepEqual(calls, [
    { kind: "clear", args: "guard-session:0.0" },
    { kind: "run", args: ["paste", "guard-session:0.0", "resume prompt"] },
    { kind: "run", args: ["send-keys", "-t", "guard-session:0.0", "Enter"] },
  ]);
});

test("sendLiteral keeps explicit tmux pane target unchanged", () => {
  const manager = createManager() as any;
  const calls: Array<{ kind: "clear" | "run"; args: string[] | string }> = [];

  manager.clearTmuxCopyMode = (target: string) => {
    calls.push({ kind: "clear", args: target });
  };
  manager.pasteLiteral = (target: string, text: string) => {
    calls.push({ kind: "run", args: ["paste", target, text] });
  };
  manager.runTmux = (args: string[]) => {
    calls.push({ kind: "run", args });
  };

  manager.sendLiteral("guard-session:0.0", "resume prompt", false);

  assert.deepEqual(calls, [
    { kind: "clear", args: "guard-session:0.0" },
    { kind: "run", args: ["paste", "guard-session:0.0", "resume prompt"] },
  ]);
});

test("buildGuardPromptText sends only rendered resume template", () => {
  assert.equal(
    buildGuardPromptText({
      enabled: true,
      goalText: "这个目标说明不应再被后端自动拼进 prompt",
      successKeywords: ["SUCCESS"],
      successCommand: null,
      idleTimeoutSec: 90,
      resumePromptTemplate: "继续推进当前目标。\n完成后输出 SUCCESS。",
      allowManualStopAfterSuccess: true,
    }),
    "继续推进当前目标。\n完成后输出 SUCCESS。",
  );
});

test("buildGuardPromptText falls back to default template when resume prompt is empty", () => {
  assert.equal(
    buildGuardPromptText({
      enabled: true,
      goalText: "unused",
      successKeywords: ["DONE"],
      successCommand: null,
      idleTimeoutSec: 90,
      resumePromptTemplate: "",
      allowManualStopAfterSuccess: true,
    }),
    "继续执行既定目标，未完成前不要停止。完成后必须输出 DONE。",
  );
});

test("buildGuardPromptText preserves multi-line structure while trimming noisy whitespace", () => {
  assert.equal(
    buildGuardPromptText({
      enabled: true,
      goalText: "unused",
      successKeywords: ["SUCCESS"],
      successCommand: null,
      idleTimeoutSec: 90,
      resumePromptTemplate: "  当前目标：{{goal_text}}  \r\n   继续推进当前目标，不要停在分析或说明。   \r\n",
      allowManualStopAfterSuccess: true,
    }),
    "当前目标：{{goal_text}}\n继续推进当前目标，不要停在分析或说明。",
  );
});

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
  assert.equal(
    detectTerminalFatalStopSignal([
      "older line: exceeded retry limit",
      ...Array.from({ length: 20 }, (_, index) => `normal output line ${index + 1}`),
    ].join("\n")),
    null,
  );
});

test("detectCodexSubmitBlockedReason identifies working turn panes", () => {
  assert.equal(
    detectCodexSubmitBlockedReason("◦ Working (16s • esc to interrupt)"),
    "Codex 当前仍在执行中的 turn，输入框还没有回到可立即提交态。",
  );
});

test("detectCodexSubmitBlockedReason identifies queued draft panes", () => {
  assert.equal(
    detectCodexSubmitBlockedReason("Messages to be submitted after next tool call"),
    "Codex 已把这次输入暂存为待提交草稿，尚未回到立即发送态。",
  );
});

test("detectTerminalSuccessKeywordMatch requires exact line match instead of substring", () => {
  const goalConfig = {
    enabled: true,
    goalText: "goal",
    successKeywords: ["Success"],
    successCommand: null,
    idleTimeoutSec: 90,
    resumePromptTemplate: "完成后输出 Success。",
    allowManualStopAfterSuccess: true,
  };
  assert.equal(
    detectTerminalSuccessKeywordMatch("请继续推进当前目标。真正完成后再输出 Success。", goalConfig),
    null,
  );
  assert.equal(
    detectTerminalSuccessKeywordMatch("前面还有别的文本\nSuccess\n", goalConfig),
    "Success",
  );
});

test("autoResume skips submit when Codex pane is still busy", () => {
  const session = {
    id: "session-1",
    nodeId: "local",
    title: "test",
    mode: "new",
    executionChannel: "tmux_local_tui",
    status: "running",
    cwd: ".",
    workspaceRoot: "/tmp",
    tmuxSessionName: "guard-session",
    sourceCodexSessionId: null,
    prompt: null,
    command: "codex --no-alt-screen",
    goalConfig: {
      enabled: true,
      goalText: "goal",
      successKeywords: ["SUCCESS"],
      successCommand: null,
      idleTimeoutSec: 90,
      resumePromptTemplate: "继续推进",
      allowManualStopAfterSuccess: true,
    },
    createdAt: 1,
    updatedAt: 1,
    lastOutputAt: null,
    lastOutputPreview: "",
    goalState: "running",
    guardDecisionState: "waiting_for_idle",
    guardDecisionReason: null,
    goalSpec: null,
    verificationSpec: null,
    verificationReceipt: null,
    successEvidence: null,
    currentCodexSessionId: null,
    currentTaskRunId: null,
  } as const;
  let updatedPayload: Record<string, unknown> | null = null;
  let sendLiteralCalled = false;
  let auditAction: string | null = null;
  const repository = {
    listRuntimeStates: () => [],
    listSessions: () => [],
    getRuntimeState: () => null,
    getSession: () => session,
    updateSession: (_id: string, payload: Record<string, unknown>) => {
      updatedPayload = payload;
      return { ...session, ...payload };
    },
    logAudit: (action: string) => {
      auditAction = action;
    },
  };
  const manager = new SessionManager(repository as never) as any;
  manager.captureTmuxPane = () => "◦ Working (16s • esc to interrupt)";
  manager.sendLiteral = () => {
    sendLiteralCalled = true;
  };

  const summary = manager.autoResume("session-1") as any;

  assert.equal(sendLiteralCalled, false);
  assert.equal(auditAction, "goal.auto_resume.skipped_busy");
  assert.equal(updatedPayload?.["guardDecisionState"], "observing_codex_turn");
  assert.match(String(updatedPayload?.["guardDecisionReason"] ?? ""), /跳过自动续跑/);
  assert.equal(summary.guardDecisionState, "observing_codex_turn");
});

test("updateGoalConfig resets guard observation state when enabling a new run", () => {
  const session = {
    id: "session-2",
    nodeId: "local",
    title: "test",
    mode: "new",
    executionChannel: "tmux_local_tui",
    status: "running",
    cwd: ".",
    workspaceRoot: "/tmp",
    tmuxSessionName: "guard-session",
    sourceCodexSessionId: null,
    prompt: null,
    command: "codex --no-alt-screen",
    goalConfig: {
      enabled: false,
      goalText: "",
      successKeywords: [],
      successCommand: null,
      idleTimeoutSec: 90,
      resumePromptTemplate: "",
      allowManualStopAfterSuccess: true,
    },
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
    currentCodexSessionId: null,
    currentTaskRunId: null,
  } as const;
  let clearedSessionId: string | null = null;
  const repository = {
    listRuntimeStates: () => [],
    listSessions: () => [],
    getRuntimeState: () => null,
    updateRuntimeState: () => ({ updatedAt: 1 }),
    getSession: () => session,
    updateSession: (_id: string, payload: Record<string, unknown>) => ({ ...session, ...payload }),
    logAudit: () => undefined,
    clearGuardEvents: (sid: string) => {
      clearedSessionId = sid;
    },
  };
  const manager = new SessionManager(repository as never) as any;
  manager.hasTmuxSession = () => false;
  manager.captureTmuxPane = () => "existing pane";
  const runtime = manager.getRuntime("session-2");
  runtime.buffer = "old output";
  runtime.lastCapturedPane = "old pane";
  runtime.lastPaneSnapshot = "old snapshot";
  runtime.lastGuardPromptAt = 123;
  runtime.lastGuardPromptText = "old prompt";
  runtime.autoResumeCount = 3;
  runtime.goalCheckEventSeq = 99;
  runtime.goalCheckOffset = 88;
  runtime.goalCheckPaneSnapshot = "old checkpoint";

  manager.updateGoalConfig("session-2", {
    enabled: true,
    goalText: "goal",
    successKeywords: ["SUCCESS"],
    successCommand: null,
    idleTimeoutSec: 90,
    resumePromptTemplate: "继续推进",
    allowManualStopAfterSuccess: true,
  });

  assert.equal(clearedSessionId, "session-2");
  assert.equal(runtime.buffer, "");
  assert.equal(runtime.goalCheckEventSeq, 0);
  assert.equal(runtime.goalCheckOffset, 0);
  assert.equal(runtime.lastGuardPromptAt, null);
  assert.equal(runtime.lastGuardPromptText, "");
  assert.equal(runtime.autoResumeCount, 0);
});
