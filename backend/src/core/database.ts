import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const databasePath = path.join(config.dataDir, "touchmux.sqlite");

export const db = new DatabaseSync(databasePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS managed_sessions (
    id TEXT PRIMARY KEY,
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

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    session_id TEXT,
    detail_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
