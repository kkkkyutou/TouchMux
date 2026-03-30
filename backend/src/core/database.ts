import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const databasePath = path.join(config.dataDir, "touchmux.sqlite");

export const db = new DatabaseSync(databasePath);

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
    status TEXT NOT NULL,
    cwd TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    tmux_session_name TEXT NOT NULL UNIQUE,
    source_codex_session_id TEXT,
    prompt TEXT,
    command TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_output_at INTEGER,
    last_output_preview TEXT NOT NULL DEFAULT '',
    goal_state TEXT NOT NULL,
    goal_config_json TEXT NOT NULL
  );
`);

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
    last_auto_resume_at INTEGER,
    auto_resume_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`);

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
