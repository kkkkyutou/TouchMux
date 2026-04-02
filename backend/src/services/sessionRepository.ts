import crypto from "node:crypto";
import { db } from "../core/database.js";
import { config } from "../core/config.js";
import type {
  GoalGuardConfig,
  GoalState,
  ManagedSessionRecord,
  SessionRuntimeStateRecord,
  SessionStatus,
} from "../types/models.js";

const defaultGoalConfig = {
  enabled: false,
  goalText: "",
  successKeywords: [],
  successCommand: null,
  idleTimeoutSec: 90,
  resumePromptTemplate: "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。",
  allowManualStopAfterSuccess: true,
} satisfies GoalGuardConfig;

const hiddenOverlayJson = JSON.stringify({
  visible: false,
  source: "",
  options: [],
  excerpt: "",
  detectedAt: 0,
});

function mapRow(row: Record<string, unknown>): ManagedSessionRecord {
  return {
    id: String(row.id),
    nodeId: row.node_id ? String(row.node_id) : config.localNode.id,
    title: String(row.title),
    mode: row.mode as ManagedSessionRecord["mode"],
    status: row.status as SessionStatus,
    cwd: String(row.cwd),
    workspaceRoot: String(row.workspace_root),
    tmuxSessionName: String(row.tmux_session_name),
    sourceCodexSessionId: row.source_codex_session_id ? String(row.source_codex_session_id) : null,
    prompt: row.prompt ? String(row.prompt) : null,
    command: String(row.command),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastOutputAt: row.last_output_at ? Number(row.last_output_at) : null,
    lastOutputPreview: String(row.last_output_preview ?? ""),
    goalState: row.goal_state as GoalState,
    goalConfig: JSON.parse(String(row.goal_config_json)) as GoalGuardConfig,
  };
}

function mapRuntimeRow(row: Record<string, unknown>): SessionRuntimeStateRecord {
  return {
    sessionId: String(row.session_id),
    buffer: String(row.buffer ?? ""),
    choiceOverlay: JSON.parse(String(row.choice_overlay_json ?? hiddenOverlayJson)) as SessionRuntimeStateRecord["choiceOverlay"],
    lastAutoResumeAt: row.last_auto_resume_at ? Number(row.last_auto_resume_at) : null,
    autoResumeCount: Number(row.auto_resume_count ?? 0),
    goalCheckOffset: Number(row.goal_check_offset ?? 0),
    lastPaneSnapshot: String(row.last_pane_snapshot ?? ""),
    goalCheckPaneSnapshot: String(row.goal_check_pane_snapshot ?? ""),
    updatedAt: Number(row.updated_at),
  };
}

export class SessionRepository {
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
      "createdAt" | "updatedAt" | "lastOutputAt" | "lastOutputPreview" | "goalState" | "goalConfig"
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
      goalState: goalConfig.enabled ? "running" : "disabled",
      goalConfig,
    };
    const statement = db.prepare(`
      INSERT INTO managed_sessions (
        id, node_id, title, mode, status, cwd, workspace_root, tmux_session_name,
        source_codex_session_id, prompt, command, created_at, updated_at,
        last_output_at, last_output_preview, goal_state, goal_config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    statement.run(
      record.id,
      record.nodeId,
      record.title,
      record.mode,
      record.status,
      record.cwd,
      record.workspaceRoot,
      record.tmuxSessionName,
      record.sourceCodexSessionId,
      record.prompt,
      record.command,
      record.createdAt,
      record.updatedAt,
      record.lastOutputAt,
      record.lastOutputPreview,
      record.goalState,
      JSON.stringify(record.goalConfig),
    );
    this.updateRuntimeState(record.id, {});
    return record;
  }

  updateSession(
    sessionId: string,
    changes: Partial<Pick<ManagedSessionRecord, "status" | "lastOutputAt" | "lastOutputPreview" | "goalState">> & {
      goalConfig?: GoalGuardConfig;
      title?: string;
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
      goalConfig: changes.goalConfig ?? current.goalConfig,
      updatedAt: changes.updatedAt ?? Date.now(),
    };
    const statement = db.prepare(`
      UPDATE managed_sessions
      SET title = ?, status = ?, updated_at = ?, last_output_at = ?, last_output_preview = ?,
          goal_state = ?, goal_config_json = ?
      WHERE id = ?
    `);
    statement.run(
      next.title,
      next.status,
      next.updatedAt,
      next.lastOutputAt,
      next.lastOutputPreview,
      next.goalState,
      JSON.stringify(next.goalConfig),
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
        | "lastAutoResumeAt"
        | "autoResumeCount"
        | "goalCheckOffset"
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
      lastAutoResumeAt:
        changes.lastAutoResumeAt !== undefined ? changes.lastAutoResumeAt : (current?.lastAutoResumeAt ?? null),
      autoResumeCount: changes.autoResumeCount ?? current?.autoResumeCount ?? 0,
      goalCheckOffset: changes.goalCheckOffset ?? current?.goalCheckOffset ?? 0,
      lastPaneSnapshot: changes.lastPaneSnapshot ?? current?.lastPaneSnapshot ?? "",
      goalCheckPaneSnapshot: changes.goalCheckPaneSnapshot ?? current?.goalCheckPaneSnapshot ?? "",
      updatedAt: changes.updatedAt ?? Date.now(),
    };
    const statement = db.prepare(`
      INSERT INTO session_runtime_state (
        session_id, buffer, choice_overlay_json, last_auto_resume_at, auto_resume_count, goal_check_offset,
        last_pane_snapshot, goal_check_pane_snapshot, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        buffer = excluded.buffer,
        choice_overlay_json = excluded.choice_overlay_json,
        last_auto_resume_at = excluded.last_auto_resume_at,
        auto_resume_count = excluded.auto_resume_count,
        goal_check_offset = excluded.goal_check_offset,
        last_pane_snapshot = excluded.last_pane_snapshot,
        goal_check_pane_snapshot = excluded.goal_check_pane_snapshot,
        updated_at = excluded.updated_at
    `);
    statement.run(
      next.sessionId,
      next.buffer,
      JSON.stringify(next.choiceOverlay),
      next.lastAutoResumeAt,
      next.autoResumeCount,
      next.goalCheckOffset,
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
