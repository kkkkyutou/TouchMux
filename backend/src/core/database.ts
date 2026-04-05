import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const databasePath = path.join(config.dataDir, "touchmux.sqlite");

export const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
`);

function ensureColumn(tableName: string, columnName: string, statement: string): void {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => String((row as Record<string, unknown>).name));
  if (!columns.includes(columnName)) {
    db.exec(statement);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS managed_sessions (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL DEFAULT 'local',
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    execution_channel TEXT NOT NULL DEFAULT 'tmux_local_tui',
    status TEXT NOT NULL,
    cwd TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    tmux_session_name TEXT NOT NULL UNIQUE,
    source_codex_session_id TEXT,
    current_codex_session_id TEXT,
    current_task_run_id TEXT,
    prompt TEXT,
    command TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_output_at INTEGER,
    last_output_preview TEXT NOT NULL DEFAULT '',
    goal_state TEXT NOT NULL,
    guard_decision_state TEXT NOT NULL DEFAULT 'disabled',
    guard_decision_reason TEXT,
    goal_spec_json TEXT,
    verification_spec_json TEXT,
    verification_receipt_json TEXT,
    success_evidence_json TEXT,
    goal_config_json TEXT NOT NULL
  );
`);

ensureColumn(
  "managed_sessions",
  "current_codex_session_id",
  "ALTER TABLE managed_sessions ADD COLUMN current_codex_session_id TEXT;",
);

ensureColumn(
  "managed_sessions",
  "current_task_run_id",
  "ALTER TABLE managed_sessions ADD COLUMN current_task_run_id TEXT;",
);

ensureColumn(
  "managed_sessions",
  "execution_channel",
  "ALTER TABLE managed_sessions ADD COLUMN execution_channel TEXT NOT NULL DEFAULT 'tmux_local_tui';",
);

ensureColumn(
  "managed_sessions",
  "success_evidence_json",
  "ALTER TABLE managed_sessions ADD COLUMN success_evidence_json TEXT;",
);

ensureColumn(
  "managed_sessions",
  "goal_spec_json",
  "ALTER TABLE managed_sessions ADD COLUMN goal_spec_json TEXT;",
);

ensureColumn(
  "managed_sessions",
  "verification_spec_json",
  "ALTER TABLE managed_sessions ADD COLUMN verification_spec_json TEXT;",
);

ensureColumn(
  "managed_sessions",
  "verification_receipt_json",
  "ALTER TABLE managed_sessions ADD COLUMN verification_receipt_json TEXT;",
);

ensureColumn(
  "managed_sessions",
  "guard_decision_state",
  "ALTER TABLE managed_sessions ADD COLUMN guard_decision_state TEXT NOT NULL DEFAULT 'disabled';",
);

ensureColumn(
  "managed_sessions",
  "guard_decision_reason",
  "ALTER TABLE managed_sessions ADD COLUMN guard_decision_reason TEXT;",
);

ensureColumn(
  "managed_sessions",
  "node_id",
  "ALTER TABLE managed_sessions ADD COLUMN node_id TEXT NOT NULL DEFAULT 'local';",
);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    session_id TEXT,
    detail_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS session_runtime_state (
    session_id TEXT PRIMARY KEY,
    buffer TEXT NOT NULL DEFAULT '',
    choice_overlay_json TEXT NOT NULL,
    goal_activated_at INTEGER,
    last_auto_resume_at INTEGER,
    auto_resume_count INTEGER NOT NULL DEFAULT 0,
    goal_check_offset INTEGER NOT NULL DEFAULT 0,
    goal_check_event_seq INTEGER NOT NULL DEFAULT 0,
    last_guard_prompt_at INTEGER,
    last_guard_prompt_text TEXT NOT NULL DEFAULT '',
    last_captured_pane TEXT NOT NULL DEFAULT '',
    last_pane_snapshot TEXT NOT NULL DEFAULT '',
    goal_check_pane_snapshot TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS guard_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_guard_events_session_seq
  ON guard_events(session_id, seq DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS goal_guard_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

ensureColumn(
  "goal_guard_templates",
  "is_default",
  "ALTER TABLE goal_guard_templates ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;",
);

ensureColumn(
  "session_runtime_state",
  "goal_activated_at",
  "ALTER TABLE session_runtime_state ADD COLUMN goal_activated_at INTEGER;",
);

ensureColumn(
  "session_runtime_state",
  "last_auto_resume_at",
  "ALTER TABLE session_runtime_state ADD COLUMN last_auto_resume_at INTEGER;",
);

ensureColumn(
  "session_runtime_state",
  "auto_resume_count",
  "ALTER TABLE session_runtime_state ADD COLUMN auto_resume_count INTEGER NOT NULL DEFAULT 0;",
);

ensureColumn(
  "session_runtime_state",
  "goal_check_offset",
  "ALTER TABLE session_runtime_state ADD COLUMN goal_check_offset INTEGER NOT NULL DEFAULT 0;",
);

ensureColumn(
  "session_runtime_state",
  "last_guard_prompt_at",
  "ALTER TABLE session_runtime_state ADD COLUMN last_guard_prompt_at INTEGER;",
);

ensureColumn(
  "session_runtime_state",
  "last_guard_prompt_text",
  "ALTER TABLE session_runtime_state ADD COLUMN last_guard_prompt_text TEXT NOT NULL DEFAULT '';",
);

ensureColumn(
  "session_runtime_state",
  "goal_check_event_seq",
  "ALTER TABLE session_runtime_state ADD COLUMN goal_check_event_seq INTEGER NOT NULL DEFAULT 0;",
);

ensureColumn(
  "session_runtime_state",
  "last_captured_pane",
  "ALTER TABLE session_runtime_state ADD COLUMN last_captured_pane TEXT NOT NULL DEFAULT '';",
);

ensureColumn(
  "session_runtime_state",
  "last_pane_snapshot",
  "ALTER TABLE session_runtime_state ADD COLUMN last_pane_snapshot TEXT NOT NULL DEFAULT '';",
);

ensureColumn(
  "session_runtime_state",
  "goal_check_pane_snapshot",
  "ALTER TABLE session_runtime_state ADD COLUMN goal_check_pane_snapshot TEXT NOT NULL DEFAULT '';",
);
