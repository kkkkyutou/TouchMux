import crypto from "node:crypto";
import { db } from "../core/database.js";
import { config } from "../core/config.js";
import type {
  ExecutionChannel,
  GuardEventRecord,
  GuardEventSource,
  GuardDecisionState,
  GoalSpec,
  GoalGuardConfig,
  GoalState,
  ManagedSessionRecord,
  SessionRuntimeStateRecord,
  SessionStatus,
  SuccessEvidence,
  VerificationReceipt,
  VerificationSpec,
} from "../types/models.js";

const defaultGoalConfig = {
  enabled: false,
  goalText: "",
  successKeywords: [],
  successCommand: null,
  idleTimeoutSec: 90,
  resumePromptTemplate: "继续执行既定目标，未完成前不要停止。完成后必须输出 SUCCESS。",
  allowManualStopAfterSuccess: true,
} satisfies GoalGuardConfig;

const hiddenOverlayJson = JSON.stringify({
  visible: false,
  source: "",
  options: [],
  excerpt: "",
  detectedAt: 0,
});
const maxGuardEventsPerSession = 80;

function deriveGuardDecisionStateFromLegacyGoalState(goalState: GoalState): GuardDecisionState {
  switch (goalState) {
    case "disabled":
      return "disabled";
    case "running":
      return "observing_output";
    case "idle_waiting":
      return "waiting_for_idle";
    case "auto_resuming":
      return "resuming";
    case "goal_satisfied":
      return "satisfied";
    case "manual_override_stopped":
      return "manually_overridden";
    case "failed_check":
      return "blocked_by_fatal_error";
    default:
      return "disabled";
  }
}

function deriveLegacyGoalState(guardDecisionState: GuardDecisionState): GoalState {
  switch (guardDecisionState) {
    case "disabled":
      return "disabled";
    case "observing_output":
    case "observing_codex_turn":
      return "running";
    case "verifying":
      return "running";
    case "waiting_for_idle":
    case "verification_failed":
      return "idle_waiting";
    case "blocked_by_missing_verifier":
      return "failed_check";
    case "resuming":
      return "auto_resuming";
    case "satisfied":
      return "goal_satisfied";
    case "manually_overridden":
      return "manual_override_stopped";
    case "blocked_by_fatal_error":
      return "failed_check";
    default:
      return "disabled";
  }
}

function mapRow(row: Record<string, unknown>): ManagedSessionRecord {
  const guardDecisionState = row.guard_decision_state
    ? (String(row.guard_decision_state) as GuardDecisionState)
    : deriveGuardDecisionStateFromLegacyGoalState(row.goal_state as GoalState);
  const legacyStatus = String(row.status ?? "running") as SessionStatus;
  const normalizedStatus: SessionStatus =
    legacyStatus === "closed" || legacyStatus === "disconnected" || legacyStatus === "idle" ? legacyStatus : "running";
  return {
    id: String(row.id),
    nodeId: row.node_id ? String(row.node_id) : config.localNode.id,
    title: String(row.title),
    mode: row.mode as ManagedSessionRecord["mode"],
    executionChannel: String(row.execution_channel ?? "tmux_local_tui") as ExecutionChannel,
    status: normalizedStatus,
    cwd: String(row.cwd),
    workspaceRoot: String(row.workspace_root),
    tmuxSessionName: String(row.tmux_session_name),
    sourceCodexSessionId: row.source_codex_session_id ? String(row.source_codex_session_id) : null,
    currentCodexSessionId: row.current_codex_session_id ? String(row.current_codex_session_id) : null,
    currentTaskRunId: row.current_task_run_id ? String(row.current_task_run_id) : null,
    prompt: row.prompt ? String(row.prompt) : null,
    command: String(row.command),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastOutputAt: row.last_output_at ? Number(row.last_output_at) : null,
    lastOutputPreview: String(row.last_output_preview ?? ""),
    goalState: deriveLegacyGoalState(guardDecisionState),
    guardDecisionState,
    guardDecisionReason: row.guard_decision_reason ? String(row.guard_decision_reason) : null,
    goalSpec: row.goal_spec_json ? (JSON.parse(String(row.goal_spec_json)) as GoalSpec) : null,
    verificationSpec: row.verification_spec_json ? (JSON.parse(String(row.verification_spec_json)) as VerificationSpec) : null,
    verificationReceipt: row.verification_receipt_json
      ? (JSON.parse(String(row.verification_receipt_json)) as VerificationReceipt)
      : null,
    successEvidence: row.success_evidence_json ? (JSON.parse(String(row.success_evidence_json)) as SuccessEvidence) : null,
    goalConfig: JSON.parse(String(row.goal_config_json)) as GoalGuardConfig,
  };
}

function mapRuntimeRow(row: Record<string, unknown>): SessionRuntimeStateRecord {
  return {
    sessionId: String(row.session_id),
    buffer: String(row.buffer ?? ""),
    choiceOverlay: JSON.parse(String(row.choice_overlay_json ?? hiddenOverlayJson)) as SessionRuntimeStateRecord["choiceOverlay"],
    goalActivatedAt: row.goal_activated_at ? Number(row.goal_activated_at) : null,
    lastAutoResumeAt: row.last_auto_resume_at ? Number(row.last_auto_resume_at) : null,
    autoResumeCount: Number(row.auto_resume_count ?? 0),
    goalCheckOffset: Number(row.goal_check_offset ?? 0),
    goalCheckEventSeq: Number(row.goal_check_event_seq ?? 0),
    lastGuardPromptAt: row.last_guard_prompt_at ? Number(row.last_guard_prompt_at) : null,
    lastGuardPromptText: String(row.last_guard_prompt_text ?? ""),
    lastCapturedPane: String(row.last_captured_pane ?? ""),
    lastPaneSnapshot: String(row.last_pane_snapshot ?? ""),
    goalCheckPaneSnapshot: String(row.goal_check_pane_snapshot ?? ""),
    updatedAt: Number(row.updated_at),
  };
}

export class SessionRepository {
  listRecentGuardEvents(sessionId: string, limit = 20): GuardEventRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, maxGuardEventsPerSession));
    const statement = db.prepare(`
      SELECT * FROM guard_events
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT ?
    `);
    return statement
      .all(sessionId, safeLimit)
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        id: String(row.id),
        sessionId: String(row.session_id),
        seq: Number(row.seq),
        source: String(row.source) as GuardEventSource,
        text: String(row.text),
        normalizedText: String(row.normalized_text),
        createdAt: Number(row.created_at),
      }))
      .reverse();
  }

  appendGuardEvent(sessionId: string, source: GuardEventSource, text: string, normalizedText: string): GuardEventRecord {
    const nextSeq =
      Number(
        (db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM guard_events WHERE session_id = ?").get(sessionId) as {
          max_seq?: number;
        }).max_seq ?? 0,
      ) + 1;
    const record: GuardEventRecord = {
      id: crypto.randomUUID(),
      sessionId,
      seq: nextSeq,
      source,
      text,
      normalizedText,
      createdAt: Date.now(),
    };
    db.prepare(`
      INSERT INTO guard_events (id, session_id, seq, source, text, normalized_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.sessionId, record.seq, record.source, record.text, record.normalizedText, record.createdAt);
    db.prepare(`
      DELETE FROM guard_events
      WHERE session_id = ?
        AND seq <= (
          SELECT COALESCE(MAX(seq), 0) - ?
          FROM guard_events
          WHERE session_id = ?
        )
    `).run(sessionId, maxGuardEventsPerSession, sessionId);
    return record;
  }

  getLastGuardEventSeq(sessionId: string): number {
    return Number(
      (db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM guard_events WHERE session_id = ?").get(sessionId) as {
        max_seq?: number;
      }).max_seq ?? 0,
    );
  }

  listGuardEventsSince(sessionId: string, seqExclusive: number, source?: GuardEventSource): GuardEventRecord[] {
    const statement = source
      ? db.prepare(`
          SELECT * FROM guard_events
          WHERE session_id = ? AND seq > ? AND source = ?
          ORDER BY seq ASC
        `)
      : db.prepare(`
          SELECT * FROM guard_events
          WHERE session_id = ? AND seq > ?
          ORDER BY seq ASC
        `);
    const rows = source ? statement.all(sessionId, seqExclusive, source) : statement.all(sessionId, seqExclusive);
    return rows.map((row) => row as Record<string, unknown>).map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      seq: Number(row.seq),
      source: String(row.source) as GuardEventSource,
      text: String(row.text),
      normalizedText: String(row.normalized_text),
      createdAt: Number(row.created_at),
    }));
  }

  listSessions(): ManagedSessionRecord[] {
    const statement = db.prepare("SELECT * FROM managed_sessions ORDER BY updated_at DESC");
    return statement.all().map((row) => mapRow(row as Record<string, unknown>));
  }

  getSession(sessionId: string): ManagedSessionRecord | null {
    const statement = db.prepare("SELECT * FROM managed_sessions WHERE id = ?");
    const row = statement.get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  listRuntimeStates(): SessionRuntimeStateRecord[] {
    const statement = db.prepare("SELECT * FROM session_runtime_state ORDER BY updated_at DESC");
    return statement.all().map((row) => mapRuntimeRow(row as Record<string, unknown>));
  }

  getRuntimeState(sessionId: string): SessionRuntimeStateRecord | null {
    const statement = db.prepare("SELECT * FROM session_runtime_state WHERE session_id = ?");
    const row = statement.get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapRuntimeRow(row) : null;
  }

  createSession(
    partial: Omit<
      ManagedSessionRecord,
      | "createdAt"
      | "updatedAt"
      | "lastOutputAt"
      | "lastOutputPreview"
      | "goalState"
      | "guardDecisionState"
      | "guardDecisionReason"
      | "goalSpec"
      | "verificationSpec"
      | "verificationReceipt"
      | "successEvidence"
      | "currentCodexSessionId"
      | "currentTaskRunId"
      | "goalConfig"
    > & { goalConfig?: Partial<GoalGuardConfig> },
  ): ManagedSessionRecord {
    const now = Date.now();
    const goalConfig: GoalGuardConfig = {
      ...defaultGoalConfig,
      ...partial.goalConfig,
    };
    const record: ManagedSessionRecord = {
      ...partial,
      createdAt: now,
      updatedAt: now,
      lastOutputAt: null,
      lastOutputPreview: "",
      goalState: goalConfig.enabled ? "idle_waiting" : "disabled",
      guardDecisionState: goalConfig.enabled ? "waiting_for_idle" : "disabled",
      guardDecisionReason: null,
      goalSpec: null,
      verificationSpec: null,
      verificationReceipt: null,
      successEvidence: null,
      currentCodexSessionId: null,
      currentTaskRunId: null,
      goalConfig,
    };
    const statement = db.prepare(`
      INSERT INTO managed_sessions (
        id, node_id, title, mode, execution_channel, status, cwd, workspace_root, tmux_session_name,
        source_codex_session_id, current_codex_session_id, current_task_run_id, prompt, command, created_at, updated_at,
        last_output_at, last_output_preview, goal_state, guard_decision_state, guard_decision_reason,
        goal_spec_json, verification_spec_json, verification_receipt_json, success_evidence_json, goal_config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    statement.run(
      record.id,
      record.nodeId,
      record.title,
      record.mode,
      record.executionChannel,
      record.status,
      record.cwd,
      record.workspaceRoot,
      record.tmuxSessionName,
      record.sourceCodexSessionId,
      record.currentCodexSessionId,
      record.currentTaskRunId,
      record.prompt,
      record.command,
      record.createdAt,
      record.updatedAt,
      record.lastOutputAt,
      record.lastOutputPreview,
      record.goalState,
      record.guardDecisionState,
      record.guardDecisionReason,
      record.goalSpec ? JSON.stringify(record.goalSpec) : null,
      record.verificationSpec ? JSON.stringify(record.verificationSpec) : null,
      record.verificationReceipt ? JSON.stringify(record.verificationReceipt) : null,
      record.successEvidence ? JSON.stringify(record.successEvidence) : null,
      JSON.stringify(record.goalConfig),
    );
    this.updateRuntimeState(record.id, {});
    return record;
  }

  updateSession(
    sessionId: string,
    changes: Partial<
      Pick<
      ManagedSessionRecord,
        "status" | "lastOutputAt" | "lastOutputPreview" | "goalState" | "guardDecisionState" | "guardDecisionReason"
        | "goalSpec" | "verificationSpec" | "verificationReceipt"
        | "successEvidence" | "currentCodexSessionId" | "currentTaskRunId"
      >
    > & {
      goalConfig?: GoalGuardConfig;
      title?: string;
      executionChannel?: ExecutionChannel;
      updatedAt?: number;
    },
  ): ManagedSessionRecord {
    const current = this.getSession(sessionId);
    if (!current) {
      throw new Error("会话不存在");
    }
    const next: ManagedSessionRecord = {
      ...current,
      ...changes,
      goalState: changes.guardDecisionState ? deriveLegacyGoalState(changes.guardDecisionState) : (changes.goalState ?? current.goalState),
      goalConfig: changes.goalConfig ?? current.goalConfig,
      updatedAt: changes.updatedAt ?? Date.now(),
    };
    const statement = db.prepare(`
      UPDATE managed_sessions
      SET title = ?, execution_channel = ?, status = ?, updated_at = ?, last_output_at = ?, last_output_preview = ?,
          goal_state = ?, guard_decision_state = ?, guard_decision_reason = ?, goal_spec_json = ?, verification_spec_json = ?,
          verification_receipt_json = ?, success_evidence_json = ?, goal_config_json = ?, current_codex_session_id = ?, current_task_run_id = ?
      WHERE id = ?
    `);
    statement.run(
      next.title,
      next.executionChannel,
      next.status,
      next.updatedAt,
      next.lastOutputAt,
      next.lastOutputPreview,
      next.goalState,
      next.guardDecisionState,
      next.guardDecisionReason,
      next.goalSpec ? JSON.stringify(next.goalSpec) : null,
      next.verificationSpec ? JSON.stringify(next.verificationSpec) : null,
      next.verificationReceipt ? JSON.stringify(next.verificationReceipt) : null,
      next.successEvidence ? JSON.stringify(next.successEvidence) : null,
      JSON.stringify(next.goalConfig),
      next.currentCodexSessionId,
      next.currentTaskRunId,
      sessionId,
    );
    return next;
  }

  updateRuntimeState(
    sessionId: string,
    changes: Partial<
      Pick<
        SessionRuntimeStateRecord,
        | "buffer"
        | "choiceOverlay"
        | "goalActivatedAt"
        | "lastAutoResumeAt"
        | "autoResumeCount"
        | "goalCheckOffset"
        | "goalCheckEventSeq"
        | "lastGuardPromptAt"
        | "lastGuardPromptText"
        | "lastCapturedPane"
        | "lastPaneSnapshot"
        | "goalCheckPaneSnapshot"
        | "updatedAt"
      >
    >,
  ): SessionRuntimeStateRecord {
    const current = this.getRuntimeState(sessionId);
    const next: SessionRuntimeStateRecord = {
      sessionId,
      buffer: changes.buffer ?? current?.buffer ?? "",
      choiceOverlay: changes.choiceOverlay ??
        current?.choiceOverlay ?? {
          visible: false,
          source: "",
          options: [],
          excerpt: "",
          detectedAt: 0,
        },
      goalActivatedAt: changes.goalActivatedAt !== undefined ? changes.goalActivatedAt : (current?.goalActivatedAt ?? null),
      lastAutoResumeAt:
        changes.lastAutoResumeAt !== undefined ? changes.lastAutoResumeAt : (current?.lastAutoResumeAt ?? null),
      autoResumeCount: changes.autoResumeCount ?? current?.autoResumeCount ?? 0,
      goalCheckOffset: changes.goalCheckOffset ?? current?.goalCheckOffset ?? 0,
      goalCheckEventSeq: changes.goalCheckEventSeq ?? current?.goalCheckEventSeq ?? 0,
      lastGuardPromptAt:
        changes.lastGuardPromptAt !== undefined ? changes.lastGuardPromptAt : (current?.lastGuardPromptAt ?? null),
      lastGuardPromptText: changes.lastGuardPromptText ?? current?.lastGuardPromptText ?? "",
      lastCapturedPane: changes.lastCapturedPane ?? current?.lastCapturedPane ?? "",
      lastPaneSnapshot: changes.lastPaneSnapshot ?? current?.lastPaneSnapshot ?? "",
      goalCheckPaneSnapshot: changes.goalCheckPaneSnapshot ?? current?.goalCheckPaneSnapshot ?? "",
      updatedAt: changes.updatedAt ?? Date.now(),
    };
    const statement = db.prepare(`
      INSERT INTO session_runtime_state (
        session_id, buffer, choice_overlay_json, goal_activated_at, last_auto_resume_at, auto_resume_count, goal_check_offset,
        goal_check_event_seq, last_guard_prompt_at, last_guard_prompt_text, last_captured_pane, last_pane_snapshot, goal_check_pane_snapshot, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        buffer = excluded.buffer,
        choice_overlay_json = excluded.choice_overlay_json,
        goal_activated_at = excluded.goal_activated_at,
        last_auto_resume_at = excluded.last_auto_resume_at,
        auto_resume_count = excluded.auto_resume_count,
        goal_check_offset = excluded.goal_check_offset,
        goal_check_event_seq = excluded.goal_check_event_seq,
        last_guard_prompt_at = excluded.last_guard_prompt_at,
        last_guard_prompt_text = excluded.last_guard_prompt_text,
        last_captured_pane = excluded.last_captured_pane,
        last_pane_snapshot = excluded.last_pane_snapshot,
        goal_check_pane_snapshot = excluded.goal_check_pane_snapshot,
        updated_at = excluded.updated_at
    `);
    statement.run(
      next.sessionId,
      next.buffer,
      JSON.stringify(next.choiceOverlay),
      next.goalActivatedAt,
      next.lastAutoResumeAt,
      next.autoResumeCount,
      next.goalCheckOffset,
      next.goalCheckEventSeq,
      next.lastGuardPromptAt,
      next.lastGuardPromptText,
      next.lastCapturedPane,
      next.lastPaneSnapshot,
      next.goalCheckPaneSnapshot,
      next.updatedAt,
    );
    return next;
  }

  logAudit(action: string, detail: unknown, sessionId?: string): void {
    const statement = db.prepare(`
      INSERT INTO audit_logs (id, action, session_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    statement.run(crypto.randomUUID(), action, sessionId ?? null, JSON.stringify(detail), Date.now());
  }
}
