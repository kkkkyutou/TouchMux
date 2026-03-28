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
- Import existing Codex conversation indexes from `~/.codex/history.jsonl`
- Browse controlled workspace roots and do basic file operations
- Click common terminal choices instead of relying only on arrow keys
- Enforce goal-guarded auto-resume before a task is allowed to stop
- Expose health checks and config schema for deployment and extension

## Current Status

TouchMux is currently a self-hosted, single-user MVP. The main workflow is working end-to-end, but it is not yet a production-grade remote development platform.

## Not Yet Implemented

- Multi-user accounts, roles, and permission isolation are not implemented yet.
- Full in-browser file editing, upload, and download are not implemented yet.
- Choice clicking is still heuristic-based, not a full TUI semantic parser.
- Goal guard is rule-based, not a true semantic task-completion judge.
- Automatic recovery after backend restart is partial and still depends on real `tmux` state.
- Docker deployment skeleton is provided, but containerized Codex runtime is not fully turnkey.
- Security hardening is still incomplete: no login rate limiting, no 2FA, no OAuth/SSO, no stronger session management, and no full production security review yet.

## Quick Start

1. Copy the environment template.

```bash
cp .env.example .env
```

2. Install dependencies.

```bash
npm install
```

3. Start the backend and frontend.

```bash
npm run dev:backend
npm run dev:frontend
```

4. Open the frontend and log in.

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`

## Requirements

- Node.js 24+
- `tmux`
- `codex` CLI
- Linux first; macOS may work but is not fully validated yet

## Production Deployment

- Backend can run as a single service process
- Frontend builds to static assets
- Cloudflare Tunnel or a reverse proxy is recommended
- See [docs/01_technical_overview.md](./docs/01_technical_overview.md)

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
