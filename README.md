# TouchMux

[简体中文](./README_CN.md)

A mobile-first web workbench for `tmux` and `Codex`.

Persistent sessions · Touch-friendly terminal · Resume/fork Codex conversations · Controlled workspace access · Clickable choices · Goal-guard auto-resume

TouchMux turns your phone browser into a remote cockpit for terminal work. It is designed for self-hosted use cases where you want to manage long-running `tmux` / `Codex` sessions, browse files, and keep tasks alive until their goals are actually satisfied.

- Backend: Node.js + TypeScript + Express + WebSocket
- Frontend: React + Vite + TypeScript + xterm.js
- Storage: SQLite via Node 24 built-in `node:sqlite`
- Terminal bridge: `tmux` session hosting + WebSocket terminal streaming

## Repository Layout

- `backend/`: session management, filesystem APIs, goal guard, WebSocket
- `frontend/`: mobile-first workbench UI
- `docs/`: technical and deployment docs
- `deploy/`: systemd service example
- `scripts/`: startup and deployment helpers

## Features

- Manage `tmux` / `Codex` from a phone browser
- Create, resume, fork, and close persistent Codex sessions
- Pick startup directories by clicking through child folders under the selected root, instead of relying only on manual path typing
- Import existing Codex conversation indexes from `~/.codex/history.jsonl`
- Use the real Ubuntu working environment as the default root, with support for multiple allowed roots
- Browse controlled roots, navigate with breadcrumbs, and jump to the active session directory
- Edit and save text files directly in the browser
- Upload and download files from the browser
- Click common terminal choices instead of relying only on arrow keys
- Enforce goal-guarded auto-resume before a task is allowed to stop
- Configure frontend dev port, backend port, and proxy targets
- Start backend and frontend together with one command during development
- Apply basic login rate limiting and write local audit logs for key actions
- Expose health checks and config schema for deployment and extension

## Current Status

TouchMux is currently a self-hosted, single-user MVP. The main workflow is working end-to-end, but it is not yet a production-grade remote development platform.

## Not Yet Implemented

- Multi-user accounts, roles, and permission isolation are not implemented yet.
- Binary preview, richer in-browser editing, and large-file handling are not implemented yet.
- Choice clicking is still heuristic-based, not a full TUI semantic parser.
- Goal guard is rule-based, not a true semantic task-completion judge.
- Automatic recovery after backend restart is partial and still depends on real `tmux` state.
- Docker deployment skeleton is provided, but containerized Codex runtime is not fully turnkey.
- Security hardening is still incomplete: no 2FA, no OAuth/SSO, no stronger session management, and no full production security review yet.

## Quick Start

1. Copy the environment template.

```bash
cp .env.example .env
```

2. Install dependencies.

```bash
npm install
```

3. Start the full development stack with one command.

```bash
npm run dev
```

4. Set the key ports and roots in `.env` if needed.

```env
TOUCHMUX_PORT=8787
TOUCHMUX_FRONTEND_PORT=5173
TOUCHMUX_BACKEND_ORIGIN=http://127.0.0.1:8787
TOUCHMUX_BACKEND_WS_ORIGIN=ws://127.0.0.1:8787
# Optional. If omitted, TouchMux uses the current Linux user's home directory.
# TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
TOUCHMUX_LOGIN_WINDOW_MS=60000
TOUCHMUX_LOGIN_MAX_ATTEMPTS=6
```

5. Open the frontend and log in.

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`

If you changed the ports above, use your configured values instead.

For focused debugging, `npm run dev:backend` and `npm run dev:frontend` are still available separately.

## Requirements

- Node.js 24+
- `tmux`
- `codex` CLI
- Linux first; macOS may work but is not fully validated yet

## Production Deployment

- Backend can run as a single service process
- Frontend builds to static assets
- Cloudflare Tunnel or a reverse proxy is recommended
- Do not expose `/` as a workspace root by default; prefer explicit roots such as `/home/your-user` or shared project paths
- See [docs/01_technical_overview.md](./docs/01_technical_overview.md)

## Open Source Safety Notes

- `.env`, runtime SQLite files, `**/.data/`, and local autoresearch artifacts are git-ignored by default
- This repository is intended for self-hosted use; review secrets, proxy settings, and allowed workspace roots before deployment
- Runtime audit logs are written under `TOUCHMUX_DATA_DIR` as `audit.jsonl`
- If you publish screenshots or demo recordings, avoid leaking real filesystem paths, shell history, or Codex session content

## Docker

```bash
docker compose up --build
```

By default, the current repository is mounted as `/workspace`, and `docker-data/` is used for runtime data.

Notes:

- If you want to run `codex` inside the container, you need to provision the Codex CLI and authentication yourself.
- The current `docker-compose.yml` is a deployment skeleton, not a guaranteed turnkey runtime for every host.

## Open Source

- License: MIT
- Contributing guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- systemd example: [touchmux.service](./deploy/touchmux.service)
