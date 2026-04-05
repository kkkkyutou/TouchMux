import test from "node:test";
import assert from "node:assert/strict";
import {
  reduceGoalGuardEvents,
  reduceGoalGuardOutputActivity,
  reduceGoalGuardResumeDecision,
  reduceGoalGuardVerificationResult,
} from "./goalGuardReducer.js";
import type { CodexObservation, VerificationReceipt } from "../types/models.js";

function buildObservation(overrides: Partial<CodexObservation> = {}): CodexObservation {
  return {
    available: false,
    matchedSessionId: null,
    matchedBy: null,
    sessionCwd: null,
    sessionStartedAt: null,
    lastEventAt: null,
    turnState: "unavailable",
    appServerTurnStateSource: null,
    currentTurnStartedAt: null,
    lastTurnCompletedAt: null,
    recentAssistantMessages: [],
    recentErrors: [],
    recentCommands: [],
    matchedSuccessKeyword: null,
    matchedStandaloneSuccess: false,
    matchedIncompleteSignals: [],
    successMessage: null,
    successMessageAt: null,
    fatalError: null,
    ...overrides,
  };
}

function buildReceipt(overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  return {
    schema: "touchmux.goal_guard.result.v1",
    taskRunId: "guardrun_test",
    sessionId: "session_test",
    status: "failed",
    verificationKind: "candidate_signal",
    passed: false,
    detail: "detail",
    exitCode: null,
    evidenceEventSeq: null,
    createdAt: 1,
    ...overrides,
  };
}

test("reduceGoalGuardEvents prioritizes fatal Codex errors", () => {
  const reduction = reduceGoalGuardEvents({
    codexObservation: buildObservation({
      available: true,
      turnState: "failed",
      fatalError: "429 Too Many Requests",
    }),
    terminalDiagnostics: {
      matchedSuccessKeyword: "SUCCESS",
      matchedStandaloneSuccess: true,
      matchedIncompleteSignals: [],
      evidenceEventSeq: 5,
    },
    hasKeywordRule: true,
    verificationKind: "file_exists",
    allowTerminalSignals: true,
  });

  assert.equal(reduction.nextState, "blocked_by_fatal_error");
  assert.equal(reduction.fatalReason, "429 Too Many Requests");
  assert.equal(reduction.candidate, null);
});

test("reduceGoalGuardEvents returns verifying candidate for Codex standalone success", () => {
  const reduction = reduceGoalGuardEvents({
    codexObservation: buildObservation({
      available: true,
      turnState: "completed",
      matchedStandaloneSuccess: true,
      matchedIncompleteSignals: [],
    }),
    terminalDiagnostics: {
      matchedSuccessKeyword: null,
      matchedStandaloneSuccess: false,
      matchedIncompleteSignals: [],
      evidenceEventSeq: null,
    },
    hasKeywordRule: true,
    verificationKind: "file_exists",
    allowTerminalSignals: true,
  });

  assert.equal(reduction.nextState, "verifying");
  assert.deepEqual(reduction.candidate, {
    source: "codex_assistant_message",
    kind: "codex_assistant_message",
    detail: "检测到 Codex 结构化 assistant message 中的独立 SUCCESS 成功标记，开始执行 verifier。",
    eventSeq: null,
  });
});

test("reduceGoalGuardEvents returns verifying candidate for Codex success keyword", () => {
  const reduction = reduceGoalGuardEvents({
    codexObservation: buildObservation({
      available: true,
      turnState: "completed",
      matchedSuccessKeyword: "SUCCESS-done",
      matchedStandaloneSuccess: false,
      matchedIncompleteSignals: [],
    }),
    terminalDiagnostics: {
      matchedSuccessKeyword: null,
      matchedStandaloneSuccess: false,
      matchedIncompleteSignals: [],
      evidenceEventSeq: null,
    },
    hasKeywordRule: true,
    verificationKind: "file_exists",
    allowTerminalSignals: true,
  });

  assert.equal(reduction.nextState, "verifying");
  assert.deepEqual(reduction.candidate, {
    source: "codex_assistant_message",
    kind: "success_keyword",
    detail: "检测到 Codex 结构化 assistant message 中的成功关键词：SUCCESS-done，开始执行 verifier。",
    eventSeq: null,
  });
});

test("reduceGoalGuardEvents ignores terminal keyword without strict verifier or standalone success", () => {
  const reduction = reduceGoalGuardEvents({
    codexObservation: buildObservation(),
    terminalDiagnostics: {
      matchedSuccessKeyword: "SUCCESS",
      matchedStandaloneSuccess: false,
      matchedIncompleteSignals: [],
      evidenceEventSeq: 8,
    },
    hasKeywordRule: false,
    verificationKind: "candidate_signal",
    allowTerminalSignals: true,
  });

  assert.equal(reduction.nextState, null);
  assert.equal(reduction.candidate, null);
});

test("reduceGoalGuardEvents ignores terminal-only candidates when terminal signals are disabled", () => {
  const reduction = reduceGoalGuardEvents({
    codexObservation: buildObservation(),
    terminalDiagnostics: {
      matchedSuccessKeyword: "SUCCESS",
      matchedStandaloneSuccess: true,
      matchedIncompleteSignals: [],
      evidenceEventSeq: 9,
    },
    hasKeywordRule: true,
    verificationKind: "file_exists",
    allowTerminalSignals: false,
  });

  assert.equal(reduction.nextState, null);
  assert.equal(reduction.candidate, null);
});

test("reduceGoalGuardEvents ignores terminal candidates when structured Codex observation is available", () => {
  const reduction = reduceGoalGuardEvents({
    codexObservation: buildObservation({
      available: true,
      turnState: "completed",
      matchedStandaloneSuccess: false,
      matchedIncompleteSignals: [],
    }),
    terminalDiagnostics: {
      matchedSuccessKeyword: "SUCCESS",
      matchedStandaloneSuccess: true,
      matchedIncompleteSignals: [],
      evidenceEventSeq: 10,
    },
    hasKeywordRule: true,
    verificationKind: "file_exists",
    allowTerminalSignals: true,
  });

  assert.equal(reduction.nextState, null);
  assert.equal(reduction.candidate, null);
});

test("reduceGoalGuardVerificationResult maps receipt outcomes into guard states", () => {
  const success = reduceGoalGuardVerificationResult(buildReceipt({
    passed: true,
    status: "success",
    verificationKind: "file_exists",
    detail: "ok",
  }));
  assert.deepEqual(success, {
    nextState: "satisfied",
    reason: "ok",
    keepPreviousSuccessEvidence: false,
  });

  const missingVerifier = reduceGoalGuardVerificationResult(buildReceipt({
    passed: false,
    verificationKind: "candidate_signal",
    detail: "need verifier",
  }));
  assert.deepEqual(missingVerifier, {
    nextState: "blocked_by_missing_verifier",
    reason: "need verifier",
    keepPreviousSuccessEvidence: true,
  });

  const failed = reduceGoalGuardVerificationResult(buildReceipt({
    passed: false,
    verificationKind: "file_exists",
    detail: "not found",
  }));
  assert.deepEqual(failed, {
    nextState: "verification_failed",
    reason: "not found 守卫继续等待新的输出或下一次候选完成信号。",
    keepPreviousSuccessEvidence: true,
  });
});

test("reduceGoalGuardOutputActivity and resume decision keep waiting logic stable", () => {
  assert.deepEqual(reduceGoalGuardOutputActivity(true), {
    nextState: "observing_output",
    reason: "守卫当前主要依据终端 fallback 信号判断仍有新进展。",
  });
  assert.deepEqual(reduceGoalGuardOutputActivity(false), {
    nextState: "waiting_for_idle",
    reason: "守卫当前未检测到新的有效进展信号。",
  });

  assert.deepEqual(
    reduceGoalGuardResumeDecision({
      currentState: "observing_output",
      hasRecentOutput: false,
      hasBootstrapped: true,
      withinActivationSettleWindow: false,
      reachedFirstProbeDelay: true,
      idleTimedOut: false,
      hasTmuxSession: true,
    }),
    { action: "mark_waiting", reason: "结构化进展与终端 fallback 当前都已静默，守卫转入等待态。" },
  );

  assert.deepEqual(
    reduceGoalGuardResumeDecision({
      currentState: "waiting_for_idle",
      hasRecentOutput: false,
      hasBootstrapped: false,
      withinActivationSettleWindow: false,
      reachedFirstProbeDelay: true,
      idleTimedOut: false,
      hasTmuxSession: true,
    }),
    { action: "auto_resume", reason: "首轮观察窗口已结束，且尚未完成 bootstrap，守卫触发一次自动续跑。" },
  );
});
