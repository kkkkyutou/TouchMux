# TouchMux

[简体中文](./README_CN.md)

A mobile-first web workbench for `tmux` and `Codex`, with both single-machine and hub-plus-node deployment modes.

Persistent sessions · Touch-friendly terminal · Single-node backup mode · Hub + multi-node gateway · Controlled workspace access · Goal-guard auto-resume

TouchMux turns your phone browser into a remote cockpit for terminal work. It is designed for self-hosted use cases where you want to manage long-running `tmux` / `Codex` sessions, browse files, and keep tasks alive until their goals are actually satisfied, either on one machine or across multiple machines behind one Hub URL.

- Backend: Node.js + TypeScript + Express + WebSocket
- Frontend: React + Vite + TypeScript + xterm.js
- Storage: SQLite via Node 24 built-in `node:sqlite`
- Terminal bridge: `tmux` session hosting + WebSocket terminal streaming

## Modes

- `single`
  - The original direct-connect mode
  - One TouchMux instance manages one machine
  - Best for the simplest self-hosted setup and remains the built-in backup mode
- `hub`
  - A single entrypoint that aggregates multiple machines
  - Proxies API and terminal WebSocket traffic to configured nodes
- `node`
  - A worker machine managed by a Hub
  - Owns local `tmux`, `codex`, filesystem access, and goal guard execution

## Repository Layout

- `backend/`: session management, filesystem APIs, goal guard, WebSocket
- `frontend/`: mobile-first workbench UI
- `docs/`: technical and deployment docs
- `deploy/`: systemd service example
- `scripts/`: startup and deployment helpers

## Features

- Manage `tmux` / `Codex` from a phone browser
- Choose between a simple single-machine deployment and a Hub that unifies multiple machines under one URL
- Open a left-side terminal drawer from the top-left button to switch, create, close, or delete active terminals
- Pick a target machine from the drawer and see only that machine's sessions and roots
- Create, resume, fork, and close persistent Codex sessions
- Keep the console empty by default until you explicitly choose which terminal to display
- Click a dedicated "new terminal" action before entering creation parameters
- Enter startup paths directly through a single-line address bar, with clickable directory suggestions
- Keep Goal Guard in a compact collapsible block inside the drawer so the main session controls stay readable on phones
- Import existing Codex conversation indexes from `~/.codex/history.jsonl`
- Use the real Ubuntu working environment as the default root, with support for multiple allowed roots
- Keep the terminal as the main screen, with the file manager presented as a bottom sheet on portrait mobile
- Browse controlled roots, navigate with breadcrumbs, and automatically sync to the active session directory
- Edit and save text files directly in the browser
- Upload and download files from the browser
- Click common terminal choices instead of relying only on arrow keys
- Enforce goal-guarded auto-resume before a task is allowed to stop
- Lazy-load heavy frontend modules and split terminal-related bundles for better first-load behavior
- Configure frontend dev port, backend port, and proxy targets
- Start backend and frontend together with one command during development
- Apply basic login rate limiting and write local audit logs for key actions
- Expose health checks and config schema for deployment and extension

## Current Status

TouchMux is currently a self-hosted, single-user-first MVP. The single-machine workflow is stable, and the first `hub + node` multi-machine version is now implemented, but it is still not a production-grade remote development platform.

## Not Yet Implemented

- Multi-user accounts, roles, and permission isolation are not implemented yet.
- Dynamic node registration, node management UI, and node auto-discovery are not implemented yet.
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

This starts `single` mode by default.

4. Set the key ports and roots in `.env` if needed.

```env
TOUCHMUX_RUNTIME_MODE=single
TOUCHMUX_PORT=8787
TOUCHMUX_FRONTEND_PORT=5173
TOUCHMUX_BACKEND_ORIGIN=http://127.0.0.1:8787
TOUCHMUX_BACKEND_WS_ORIGIN=ws://127.0.0.1:8787
# Optional. If omitted, TouchMux uses the current Linux user's home directory.
# TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
TOUCHMUX_LOGIN_WINDOW_MS=60000
TOUCHMUX_LOGIN_MAX_ATTEMPTS=6
TOUCHMUX_TOKEN_TTL_SEC=604800
TOUCHMUX_MAX_UPLOAD_BYTES=2097152
TOUCHMUX_NODE_REQUEST_TIMEOUT_MS=8000
```

5. Open the frontend and log in.

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`

If you changed the ports above, use your configured values instead.

For focused debugging, `npm run dev:backend` and `npm run dev:frontend` are still available separately.

### Hub + Node Example

Run one machine as a node:

```env
TOUCHMUX_RUNTIME_MODE=node
TOUCHMUX_NODE_ID=workstation-a
TOUCHMUX_NODE_LABEL=Workstation A
TOUCHMUX_NODE_SHARED_SECRET=replace-with-a-long-random-secret
TOUCHMUX_PORT=9787
TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
```

Run the public entrypoint as a hub:

```env
TOUCHMUX_RUNTIME_MODE=hub
TOUCHMUX_PORT=8787
TOUCHMUX_HUB_NODES_JSON=[{"id":"workstation-a","label":"Workstation A","baseUrl":"http://127.0.0.1:9787","sharedSecret":"replace-with-a-long-random-secret"}]
```

Useful dev commands:

- `npm run dev:single`
- `npm run dev:hub`
- `npm run dev:node`

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
- In `hub + node` deployments, expose the Hub publicly and keep Nodes behind a trusted network or tightly controlled proxy when possible
- See [docs/01_technical_overview.md](./docs/01_technical_overview.md)

## Open Source Safety Notes

- `.env`, runtime SQLite files, `**/.data/`, and local autoresearch artifacts are git-ignored by default
- This repository is intended for self-hosted use; review secrets, proxy settings, and allowed workspace roots before deployment
- Runtime audit logs are written under `TOUCHMUX_DATA_DIR` as `audit.jsonl`
- `node` mode requires a strong `TOUCHMUX_NODE_SHARED_SECRET`; do not leave node-to-hub trust on a weak or default secret
- `hub` and `node` modes now refuse to start with default login/JWT secrets unless you explicitly set `TOUCHMUX_ALLOW_INSECURE_DEFAULTS=true` for local debugging
- Upload size is limited by `TOUCHMUX_MAX_UPLOAD_BYTES`, and Hub -> Node calls are bounded by `TOUCHMUX_NODE_REQUEST_TIMEOUT_MS`
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
