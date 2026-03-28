export type SessionMode = "new" | "resume" | "fork";

export type SessionStatus =
  | "idle"
  | "running"
  | "disconnected"
  | "closed"
  | "goal_satisfied"
  | "auto_resuming"
  | "failed_check";

export type GoalState =
  | "disabled"
  | "running"
  | "idle_waiting"
  | "auto_resuming"
  | "goal_satisfied"
  | "manual_override_stopped"
  | "failed_check";

export interface GoalGuardConfig {
  enabled: boolean;
  goalText: string;
  successKeywords: string[];
  successCommand: string | null;
  idleTimeoutSec: number;
  resumePromptTemplate: string;
  allowManualStopAfterSuccess: boolean;
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

export interface ManagedSessionRecord {
  id: string;
  title: string;
  mode: SessionMode;
  status: SessionStatus;
  cwd: string;
  workspaceRoot: string;
  tmuxSessionName: string;
  sourceCodexSessionId: string | null;
  prompt: string | null;
  command: string;
  createdAt: number;
  updatedAt: number;
  lastOutputAt: number | null;
  lastOutputPreview: string;
  goalState: GoalState;
  goalConfig: GoalGuardConfig;
}

export interface SessionSummary extends ManagedSessionRecord {
  hasTmuxSession: boolean;
  choiceOverlay: ChoiceOverlay;
}

export interface CreateSessionInput {
  title: string;
  workspaceRoot: string;
  cwd: string;
  mode: SessionMode;
  prompt?: string;
  sourceCodexSessionId?: string;
}

export interface HistoryConversationSummary {
  sessionId: string;
  lastUpdatedAt: number;
  firstUpdatedAt: number;
  messageCount: number;
  lastSnippet: string;
}

export interface WorkspaceEntry {
  rootPath: string;
  label: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: number;
}

export interface SessionEventMessage {
  type: "snapshot" | "session-updated" | "session-removed";
  payload: SessionSummary[] | SessionSummary | { sessionId: string };
}
