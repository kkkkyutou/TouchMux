import type {
  AppServerDebugSummary,
  AppServerNotificationManagerSummary,
  AppServerNotificationSummary,
  AppServerThreadManagerSummary,
  CodexObservation,
  GuardDecisionState,
  GoalGuardProgressSignal,
  GoalGuardStructuredFactSource,
  ManagedSessionRecord,
  VerificationReceipt,
  VerificationKind,
} from "../types/models.js";

export interface TerminalGoalCandidateDiagnostics {
  matchedSuccessKeyword: string | null;
  matchedStandaloneSuccess: boolean;
  matchedIncompleteSignals: string[];
  evidenceEventSeq: number | null;
}

export type GoalGuardEvent =
  | { type: "codex_turn_running" }
  | { type: "codex_fatal_error"; message: string }
  | {
      type: "codex_candidate_success";
      candidateKind: "codex_assistant_message" | "success_keyword";
      detail: string;
    }
  | { type: "terminal_incomplete_signal"; labels: string[] }
  | {
      type: "terminal_candidate_success";
      candidateKind: "standalone_success" | "success_keyword";
      detail: string;
      eventSeq: number | null;
    };

export interface GoalGuardReductionInput {
  codexObservation: CodexObservation;
  terminalDiagnostics: TerminalGoalCandidateDiagnostics;
  hasKeywordRule: boolean;
  verificationKind: VerificationKind;
  allowTerminalSignals: boolean;
}

export interface GoalGuardReductionResult {
  nextState: GuardDecisionState | null;
  fatalReason: string | null;
  candidate:
    | {
        source: "codex_assistant_message" | "terminal_signal";
        kind: "codex_assistant_message" | "standalone_success" | "success_keyword";
        detail: string;
        eventSeq: number | null;
      }
    | null;
}

export interface GoalGuardVerificationReductionResult {
  nextState: GuardDecisionState;
  reason: string;
  keepPreviousSuccessEvidence: boolean;
}

export interface GoalGuardOutputActivityReductionResult {
  nextState: GuardDecisionState;
  reason: string;
}

export interface GoalGuardResumeReductionInput {
  currentState: GuardDecisionState;
  hasRecentOutput: boolean;
  hasBootstrapped: boolean;
  withinActivationSettleWindow: boolean;
  reachedFirstProbeDelay: boolean;
  idleTimedOut: boolean;
  hasTmuxSession: boolean;
}

export interface GoalGuardResumeReductionResult {
  action: "none" | "mark_waiting" | "auto_resume";
  reason: string | null;
}

export interface GoalGuardStateSnapshot {
  session: ManagedSessionRecord;
  codexObservation: CodexObservation;
  terminalDiagnostics: TerminalGoalCandidateDiagnostics;
  hasKeywordRule: boolean;
  verificationKind: VerificationKind;
  allowTerminalSignals: boolean;
  progressSignal: GoalGuardProgressSignal;
  structuredFactSource: GoalGuardStructuredFactSource;
  appServerNotificationSummary: AppServerNotificationSummary;
  appServerNotificationManagerSummary: AppServerNotificationManagerSummary;
  appServerDebugSummary: AppServerDebugSummary;
  terminalActivityAt: number;
  structuredActivityAt: number | null;
  withinActivationSettleWindow: boolean;
  reachedFirstProbeDelay: boolean;
  hasBootstrapped: boolean;
  hasRecentOutput: boolean;
  idleTimedOut: boolean;
  hasTmuxSession: boolean;
  observedActivityAt: number;
  appServerThreadManagerSummary: AppServerThreadManagerSummary;
}

export function buildGoalGuardEvents(input: GoalGuardReductionInput): GoalGuardEvent[] {
  const events: GoalGuardEvent[] = [];
  const { codexObservation, terminalDiagnostics, allowTerminalSignals } = input;
  const allowTerminalFallback = allowTerminalSignals && !codexObservation.available;

  if (codexObservation.available && codexObservation.turnState === "running") {
    events.push({ type: "codex_turn_running" });
  }
  if (codexObservation.fatalError) {
    events.push({ type: "codex_fatal_error", message: codexObservation.fatalError });
  }
  if (
    codexObservation.available
    && codexObservation.matchedIncompleteSignals.length === 0
    && codexObservation.matchedStandaloneSuccess
  ) {
    events.push({
      type: "codex_candidate_success",
      candidateKind: "codex_assistant_message",
      detail: "检测到 Codex 结构化 assistant message 中的独立 SUCCESS 成功标记，开始执行 verifier。",
    });
  } else if (
    codexObservation.available
    && codexObservation.matchedIncompleteSignals.length === 0
    && codexObservation.matchedSuccessKeyword
  ) {
    events.push({
      type: "codex_candidate_success",
      candidateKind: "success_keyword",
      detail: `检测到 Codex 结构化 assistant message 中的成功关键词：${codexObservation.matchedSuccessKeyword}，开始执行 verifier。`,
    });
  }
  if (allowTerminalFallback && !terminalDiagnostics.matchedStandaloneSuccess && terminalDiagnostics.matchedIncompleteSignals.length > 0) {
    events.push({
      type: "terminal_incomplete_signal",
      labels: terminalDiagnostics.matchedIncompleteSignals,
    });
  }
  if (allowTerminalFallback && terminalDiagnostics.matchedStandaloneSuccess) {
    events.push({
      type: "terminal_candidate_success",
      candidateKind: "standalone_success",
      detail: "检测到 checkpoint 之后 terminal_output 事件中的独立 SUCCESS 成功标记，开始执行 verifier。",
      eventSeq: terminalDiagnostics.evidenceEventSeq,
    });
  } else if (allowTerminalFallback && terminalDiagnostics.matchedSuccessKeyword) {
    events.push({
      type: "terminal_candidate_success",
      candidateKind: "success_keyword",
      detail: `检测到 checkpoint 之后 terminal_output 事件中的成功关键词：${terminalDiagnostics.matchedSuccessKeyword}，开始执行 verifier。`,
      eventSeq: terminalDiagnostics.evidenceEventSeq,
    });
  }

  return events;
}

export function reduceGoalGuardEvents(input: GoalGuardReductionInput): GoalGuardReductionResult {
  const events = buildGoalGuardEvents(input);
  const fatalEvent = events.find((event) => event.type === "codex_fatal_error");
  if (fatalEvent && fatalEvent.type === "codex_fatal_error") {
    return {
      nextState: "blocked_by_fatal_error",
      fatalReason: fatalEvent.message,
      candidate: null,
    };
  }

  const runningEvent = events.find((event) => event.type === "codex_turn_running");
  if (runningEvent) {
    return {
      nextState: "observing_codex_turn",
      fatalReason: null,
      candidate: null,
    };
  }

  const codexCandidate = events.find((event) => event.type === "codex_candidate_success");
  if (codexCandidate && codexCandidate.type === "codex_candidate_success") {
    return {
      nextState: "verifying",
      fatalReason: null,
      candidate: {
        source: "codex_assistant_message",
        kind: codexCandidate.candidateKind,
        detail: codexCandidate.detail,
        eventSeq: null,
      },
    };
  }

  const incompleteEvent = events.find((event) => event.type === "terminal_incomplete_signal");
  if (incompleteEvent) {
    return {
      nextState: null,
      fatalReason: null,
      candidate: null,
    };
  }

  const terminalCandidate = events.find((event) => event.type === "terminal_candidate_success");
  if (terminalCandidate && terminalCandidate.type === "terminal_candidate_success") {
    if (
      !input.hasKeywordRule
      && input.verificationKind !== "command_check"
      && terminalCandidate.candidateKind !== "standalone_success"
    ) {
      return {
        nextState: null,
        fatalReason: null,
        candidate: null,
      };
    }
    return {
      nextState: "verifying",
      fatalReason: null,
      candidate: {
        source: "terminal_signal",
        kind: terminalCandidate.candidateKind,
        detail: terminalCandidate.detail,
        eventSeq: terminalCandidate.eventSeq,
      },
    };
  }

  return {
    nextState: null,
    fatalReason: null,
    candidate: null,
  };
}

export function reduceGoalGuardVerificationResult(
  receipt: VerificationReceipt,
): GoalGuardVerificationReductionResult {
  if (receipt.passed) {
    return {
      nextState: "satisfied",
      reason: receipt.detail,
      keepPreviousSuccessEvidence: false,
    };
  }
  if (receipt.verificationKind === "candidate_signal") {
    return {
      nextState: "blocked_by_missing_verifier",
      reason: receipt.detail,
      keepPreviousSuccessEvidence: true,
    };
  }
  return {
    nextState: "verification_failed",
    reason: `${receipt.detail} 守卫继续等待新的输出或下一次候选完成信号。`,
    keepPreviousSuccessEvidence: true,
  };
}

export function reduceGoalGuardOutputActivity(
  hasNewOutput: boolean,
  progressSignal: GoalGuardProgressSignal = hasNewOutput ? "terminal_fallback" : "none",
): GoalGuardOutputActivityReductionResult {
  return {
    nextState: hasNewOutput ? "observing_output" : "waiting_for_idle",
    reason: hasNewOutput
      ? progressSignal === "structured_codex"
        ? "守卫当前主要依据结构化 Codex 事件判断仍有新进展。"
        : progressSignal === "terminal_fallback"
          ? "守卫当前主要依据终端 fallback 信号判断仍有新进展。"
          : "守卫在 checkpoint 之后观测到新的进展信号。"
      : "守卫当前未检测到新的有效进展信号。",
  };
}

export function reduceGoalGuardResumeDecision(
  input: GoalGuardResumeReductionInput,
): GoalGuardResumeReductionResult {
  if (input.withinActivationSettleWindow) {
    return { action: "none", reason: null };
  }
  if (
    (input.currentState === "observing_output" || input.currentState === "observing_codex_turn")
    && !input.hasRecentOutput
  ) {
    return { action: "mark_waiting", reason: "结构化进展与终端 fallback 当前都已静默，守卫转入等待态。" };
  }
  if (!input.hasTmuxSession) {
    return { action: "none", reason: null };
  }
  if (!input.hasBootstrapped && input.reachedFirstProbeDelay) {
    return { action: "auto_resume", reason: "首轮观察窗口已结束，且尚未完成 bootstrap，守卫触发一次自动续跑。" };
  }
  if (input.idleTimedOut) {
    return { action: "auto_resume", reason: "当前已超过空闲阈值且没有新的有效进展信号，守卫触发自动续跑。" };
  }
  return { action: "none", reason: null };
}
