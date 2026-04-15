export type RuntimeMode = "single" | "hub" | "node";
export type InterfaceOwner = "portal" | "node" | "shared";
export type InterfacePlane = "control" | "data";
export type InterfaceAccessMode = "portal_only" | "node_first_read" | "gateway_first_write" | "gateway_only";

export type SessionMode = "new" | "resume" | "fork";

export type ExecutionChannel =
  | "tmux_local_tui"
  | "app_server_remote_tui";

export type SessionStatus =
  | "idle"
  | "running"
  | "disconnected"
  | "closed";

export type GoalState =
  | "disabled"
  | "running"
  | "idle_waiting"
  | "auto_resuming"
  | "goal_satisfied"
  | "manual_override_stopped"
  | "failed_check";

export type GuardDecisionState =
  | "disabled"
  | "observing_output"
  | "observing_codex_turn"
  | "waiting_for_idle"
  | "verifying"
  | "resuming"
  | "satisfied"
  | "verification_failed"
  | "blocked_by_missing_verifier"
  | "blocked_by_fatal_error"
  | "manually_overridden";

export type GuardEventSource =
  | "terminal_output"
  | "user_input"
  | "guard_prompt"
  | "guard_echo";

export type SuccessEvidenceKind =
  | "standalone_success"
  | "success_keyword"
  | "command_check"
  | "codex_assistant_message";

export type GoalSpecKind =
  | "terminal_signal";

export type VerificationKind =
  | "command_check"
  | "file_exists"
  | "file_contains"
  | "json_field_equals"
  | "candidate_signal";

export type VerificationReceiptStatus =
  | "success"
  | "failed";

export type CodexObservationMatchMode =
  | "current_session_id"
  | "source_session_id"
  | "cwd_timestamp"
  | null;

export type CodexObservedTurnState =
  | "unavailable"
  | "idle"
  | "running"
  | "completed"
  | "failed";

export type AppServerTurnStateSource =
  | "notification_cache"
  | "thread_read"
  | "failed_conflict"
  | null;

export type GoalGuardProgressSignal =
  | "structured_codex"
  | "terminal_fallback"
  | "none";

export type GoalGuardStructuredFactSource =
  | "rollout_observer"
  | "app_server_thread_read"
  | "app_server_notification_cache"
  | "none";

export interface AppServerNotificationSummary {
  threadId: string | null;
  cachedCount: number;
  latestMethod: string | null;
  latestReceivedAt: number | null;
}

export interface InterfaceCatalogEntry {
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "WS";
  path: string;
  owner: InterfaceOwner;
  plane: InterfacePlane;
  accessMode: InterfaceAccessMode;
  summary: string;
  currentStatus: string;
}

export interface AppServerNotificationManagerSummary {
  active: boolean;
  connected: boolean;
  trackedThreadCount: number;
  lastConnectedAt: number | null;
  lastError: string | null;
}

export interface AppServerDebugSummary {
  enabled: boolean;
  matchedThreadId: string | null;
  finalTurnState: CodexObservedTurnState;
  finalTurnStateSource: AppServerTurnStateSource;
  fatalError: string | null;
  healthStatus: "disabled" | "fatal_error" | "notification_disconnected" | "waiting_snapshot" | "healthy";
  healthLabel: string;
  notificationManager: AppServerNotificationManagerSummary;
  notificationCache: AppServerNotificationSummary;
  threadManager: AppServerThreadManagerSummary;
}

export interface GoalGuardConfig {
  enabled: boolean;
  goalText: string;
  successKeywords: string[];
  successCommand: string | null;
  idleTimeoutSec: number;
  resumePromptTemplate: string;
  allowManualStopAfterSuccess: boolean;
}

export interface GoalGuardTemplate {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GoalSpec {
  kind: GoalSpecKind;
  goalText: string;
  successKeywords: string[];
}

export interface VerificationSpec {
  kind: VerificationKind;
  raw: string | null;
  command: string | null;
  required: boolean;
  strict: boolean;
}

export interface VerificationReceipt {
  schema: "touchmux.goal_guard.result.v1";
  taskRunId: string;
  sessionId: string;
  status: VerificationReceiptStatus;
  verificationKind: VerificationKind;
  candidateSource?: "terminal_signal" | "codex_assistant_message";
  candidateKind?: SuccessEvidenceKind;
  candidateDetail?: string;
  passed: boolean;
  detail: string;
  exitCode: number | null;
  evidenceEventSeq: number | null;
  createdAt: number;
}

export interface AppServerThreadManagerSummary {
  threadId: string | null;
  tracked: boolean;
  hasSnapshot: boolean;
  cachedTurnCount: number;
  lastSyncedAt: number | null;
  lastSyncOk: boolean;
  lastError: string | null;
  threadUpdatedAt: number | null;
}

export interface GoalGuardDebugInfo {
  sessionId: string;
  goalState: GoalState;
  guardDecisionState: GuardDecisionState;
  guardDecisionReason: string | null;
  currentTaskRunId: string | null;
  guardEnabled: boolean;
  hasTmuxSession: boolean;
  goalActivatedAt: number | null;
  lastOutputAt: number | null;
  structuredLastEventAt: number | null;
  observedActivityAt: number | null;
  progressSignal: GoalGuardProgressSignal;
  structuredFactSource: GoalGuardStructuredFactSource;
  terminalSignalsAllowed: boolean;
  appServerNotificationSummary: AppServerNotificationSummary;
  appServerNotificationManagerSummary: AppServerNotificationManagerSummary;
  appServerThreadManagerSummary: AppServerThreadManagerSummary;
  appServerDebugSummary: AppServerDebugSummary;
  lastAutoResumeAt: number | null;
  lastViewerActivityAt: number | null;
  autoResumeCount: number;
  baselineSnapshot: string;
  currentSnapshot: string;
  snapshotChanged: boolean;
  baselineTailLines: string[];
  currentTailLines: string[];
  goalWindowTailLines: string[];
  sanitizedGoalWindowTailLines: string[];
  matchedSuccessKeyword: string | null;
  matchedStandaloneSuccess: boolean;
  matchedIncompleteSignals: string[];
  changedTailLines: Array<{
    line: number;
    baseline: string;
    current: string;
  }>;
  goalSpec: GoalSpec | null;
  verificationSpec: VerificationSpec | null;
  verificationReceipt: VerificationReceipt | null;
  recentEvents: GuardEventRecord[];
  successEvidence: SuccessEvidence | null;
  codexObservation: CodexObservation;
}

export interface GuardEventRecord {
  id: string;
  sessionId: string;
  seq: number;
  source: GuardEventSource;
  text: string;
  normalizedText: string;
  createdAt: number;
}

export interface SuccessEvidence {
  kind: SuccessEvidenceKind;
  eventSeq: number | null;
  confirmedAt: number;
  detail: string;
}

export interface CodexAssistantMessageRecord {
  timestamp: number;
  phase: string | null;
  text: string;
}

export interface CodexObservation {
  available: boolean;
  matchedSessionId: string | null;
  matchedBy: CodexObservationMatchMode;
  sessionCwd: string | null;
  sessionStartedAt: number | null;
  lastEventAt: number | null;
  turnState: CodexObservedTurnState;
  appServerTurnStateSource: AppServerTurnStateSource;
  currentTurnStartedAt: number | null;
  lastTurnCompletedAt: number | null;
  recentAssistantMessages: CodexAssistantMessageRecord[];
  recentErrors: string[];
  recentCommands: string[];
  matchedSuccessKeyword: string | null;
  matchedStandaloneSuccess: boolean;
  matchedIncompleteSignals: string[];
  successMessage: string | null;
  successMessageAt: number | null;
  fatalError: string | null;
}

export interface AppServerBridgeProbeResult {
  sessionId: string;
  executionChannel: ExecutionChannel;
  cwd: string;
  startedThreadId: string;
  threadReadId: string;
  threadReadCwd: string | null;
  model: string | null;
  currentCodexSessionIdBefore: string | null;
  currentCodexSessionIdAfter: string | null;
  currentCodexSessionIdUnchanged: boolean;
}

export interface ChoiceOption {
  id: string;
  label: string;
  send: string;
}

export interface ChoiceOverlay {
  visible: boolean;
  source: string;
  options: ChoiceOption[];
  excerpt: string;
  detectedAt: number;
}

export interface SessionSummary {
  id: string;
  nodeId: string;
  nodeLabel: string;
  title: string;
  mode: SessionMode;
  executionChannel: ExecutionChannel;
  status: SessionStatus;
  cwd: string;
  workspaceRoot: string;
  tmuxSessionName: string;
  sourceCodexSessionId: string | null;
  currentCodexSessionId: string | null;
  currentTaskRunId: string | null;
  prompt: string | null;
  command: string;
  createdAt: number;
  updatedAt: number;
  lastOutputAt: number | null;
  lastOutputPreview: string;
  goalState: GoalState;
  guardDecisionState: GuardDecisionState;
  guardDecisionReason: string | null;
  goalSpec: GoalSpec | null;
  verificationSpec: VerificationSpec | null;
  verificationReceipt: VerificationReceipt | null;
  successEvidence: SuccessEvidence | null;
  goalConfig: GoalGuardConfig;
  hasTmuxSession: boolean;
  choiceOverlay: ChoiceOverlay;
  tmuxCopyModeActive: boolean;
  tmuxViewStateUpdatedAt: number | null;
  activeViewerCount: number;
  runtimeContextState: "live" | "tmux_resynced" | "persisted_only";
  runtimeContextDetail: string | null;
  runtimeContextUpdatedAt: number | null;
}

export interface HistoryConversationSummary {
  sessionId: string;
  lastUpdatedAt: number;
  firstUpdatedAt: number;
  messageCount: number;
  firstSnippet: string;
  lastSnippet: string;
}

export interface WorkspaceEntry {
  rootPath: string;
  label: string;
}

export interface NodeSummary {
  id: string;
  label: string;
  baseUrl: string;
  directHttpBaseUrl: string | null;
  directWsBaseUrl: string | null;
  directAccessReady: boolean;
  status: "online" | "offline";
  runtimeMode: RuntimeMode | "unknown";
  roots: WorkspaceEntry[];
  error: string | null;
  lastCheckedAt: number;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: number;
}
