# TouchMux

[简体中文](./README_CN.md)

`TouchMux` is a mobile-first web workbench for `tmux` and `Codex`.

It lets you open a phone browser and manage persistent terminal sessions, browse controlled workspaces, edit files, and keep tasks alive with Goal Guard. You can run it on one machine, or use one public Hub URL to aggregate multiple private Nodes.

📱 Touch-friendly terminal workbench  
🧭 Single-machine mode and Hub + Node mode  
📂 Controlled file browser and editor  
🔒 Basic deployment hardening for self-hosted use

## What It Does

- Start, resume, fork, close, and recover persistent `tmux` / `Codex` sessions.
- Stream terminals over WebSocket with a mobile-first UI.
- Browse allowed workspace roots, edit text files, upload files, and download artifacts.
- Import existing Codex history from `~/.codex/history.jsonl`.
- Detect common terminal choice overlays and let users click instead of only pressing arrow keys.
- Use Goal Guard to keep tasks running until stop conditions are explicitly satisfied.
- Aggregate multiple machines behind one Hub entrypoint while keeping Nodes private.
- Persist runtime session state so recent output and resume context survive backend restarts.

## Current Status

TouchMux is a self-hosted, single-user-first MVP. The single-machine workflow is stable, and the first usable `hub + node` path is in place. It is good for personal remote workbenches and internal demos, but it is not yet a production-grade remote development platform.

## What Is Still Missing

- Multi-user accounts, roles, and permission isolation.
- Dynamic node registration and a real node-management UI.
- Rich binary preview and large-file editing strategy.
- Semantic task completion beyond the current rule-based Goal Guard.
- Full production security review, 2FA, OAuth/SSO, and stronger session lifecycle controls.
- Full turnkey containerized Codex runtime.

## Architecture

TouchMux is easier to understand in two dimensions: deployment mode and runtime role.

### Two Deployment Modes

| Mode | Best for | Shape |
| --- | --- | --- |
| `single-machine` | one personal workstation or the simplest self-hosted setup | one TouchMux service directly manages one machine |
| `hub-plus-node` | one public entrypoint for multiple private workstations | one Hub aggregates multiple Nodes and forwards API / terminal traffic |

### Three Runtime Roles

| Role | Used in | Responsibility |
| --- | --- | --- |
| `single` | `single-machine` mode | all-in-one role that owns auth, UI serving, session management, filesystem access, and terminal bridging on one machine |
| `hub` | `hub-plus-node` mode | public gateway that authenticates users, aggregates nodes, proxies API calls, and bridges terminal traffic |
| `node` | `hub-plus-node` mode | private worker that owns local `tmux`, `Codex`, filesystem access, Goal Guard, and session runtime |

### Request Paths

```text
Single-machine mode
Browser
  -> TouchMux(single)
  -> tmux / Codex / Filesystem / Goal Guard

Hub + Node mode
Browser
  -> TouchMux(hub)
  -> signed HTTP + signed WebSocket handshake
  -> TouchMux(node)
  -> tmux / Codex / Filesystem / Goal Guard
```

### Repository Layout

| Path | Responsibility |
| --- | --- |
| `backend/` | Express API, auth, session management, Goal Guard, Hub / Node routing, WebSocket bridge |
| `frontend/` | React UI, terminal viewport, session drawer, file browser, Goal Guard editor |
| `docs/` | technical notes, deployment notes, feature tracking |
| `deploy/` | example `systemd` service |
| `scripts/` | local dev launcher and smoke checks |

## Security Notes

This project is designed for self-hosting. It now includes a first round of practical hardening, but the trust model is still intentionally simple.

- `TOUCHMUX_ALLOWED_ORIGINS` can restrict browser CORS origins. Leave it empty for local development, but set it explicitly for public deployments.
- `GET /api/system/health` is now a minimal unauthenticated probe.
- `GET /api/system/health/detail` requires login and returns dependency probes, node status, and security warnings.
- Hub -> Node internal HTTP traffic now uses `TOUCHMUX_NODE_SHARED_SECRET` plus `x-touchmux-node-ts` and `x-touchmux-node-signature` HMAC headers.
- Hub -> Node terminal WebSocket handshakes now use the same signed headers before the terminal stream is attached.
- Nodes should still stay behind a trusted network, Tailscale, ZeroTier, or a tightly controlled proxy.
- Do not expose `/` as a workspace root. Prefer explicit roots such as `/home/your-user` or shared project directories.

## Quick Start

### 1. Install dependencies

```bash
cp .env.example .env
npm install
```

### 2. Set the minimum required configuration

For local development:

```env
TOUCHMUX_RUNTIME_MODE=single
TOUCHMUX_PASSWORD=replace-with-a-strong-password
TOUCHMUX_JWT_SECRET=replace-with-a-long-random-secret
TOUCHMUX_PORT=8787
TOUCHMUX_FRONTEND_PORT=5173
TOUCHMUX_BACKEND_ORIGIN=http://127.0.0.1:8787
TOUCHMUX_BACKEND_WS_ORIGIN=ws://127.0.0.1:8787
# Optional in local dev. Set this in public deployments.
# TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com
# Optional. If omitted, TouchMux uses the current Linux user's home directory.
# TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
```

### 3. Start the app

Development mode:

```bash
npm run dev
```

Production-style single-port mode:

```bash
npm run build
npm run start -w backend
```

After `frontend/dist` exists, the backend serves the built frontend on the same port.

### 4. Open the UI

- Dev frontend: `http://localhost:5173`
- Backend or built single-port app: `http://localhost:8787`

## Hub + Node Example

Node machine:

```env
TOUCHMUX_RUNTIME_MODE=node
TOUCHMUX_NODE_ID=workstation-a
TOUCHMUX_NODE_LABEL=Workstation A
TOUCHMUX_NODE_SHARED_SECRET=replace-with-a-long-random-secret
TOUCHMUX_NODE_REQUEST_MAX_SKEW_MS=60000
TOUCHMUX_PORT=9787
TOUCHMUX_HOST=127.0.0.1
TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
```

Hub machine:

```env
TOUCHMUX_RUNTIME_MODE=hub
TOUCHMUX_PASSWORD=replace-with-a-strong-password
TOUCHMUX_JWT_SECRET=replace-with-a-long-random-secret
TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com
TOUCHMUX_PORT=8787
TOUCHMUX_HUB_NODES_JSON=[{"id":"workstation-a","label":"Workstation A","baseUrl":"http://127.0.0.1:9787","sharedSecret":"replace-with-a-long-random-secret"}]
```

Recommendation:

- Expose only the Hub publicly.
- Keep Nodes private whenever possible.
- Put Nodes behind LAN, Tailscale, ZeroTier, or a tightly scoped reverse proxy.

## How To Use

The normal flow is:

1. Log in on the web UI.
2. Choose a machine from the session drawer.
3. Create or resume a `tmux` / `Codex` session.
4. Use the terminal as the primary workspace.
5. Open the file browser when you need to inspect or edit files.
6. Configure Goal Guard if the task should auto-resume until the stop condition is satisfied.

Useful dev commands:

- `npm run dev`
- `npm run dev:single`
- `npm run dev:hub`
- `npm run dev:node`
- `npm run typecheck`
- `npm run build`
- `npm run smoke:single`
- `npm run smoke:hub-node`

## Expose It With Cloudflare Tunnel

For a public self-hosted deployment, the simplest model is:

- Build TouchMux and run the backend on `127.0.0.1:8787`
- Put Cloudflare Tunnel in front of that local port
- Expose only the Hub if you are using `hub + node`

### Example

1. Run TouchMux locally.

```bash
npm run build
TOUCHMUX_HOST=127.0.0.1 TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com npm run start -w backend
```

2. Create a named tunnel.

```bash
cloudflared tunnel login
cloudflared tunnel create touchmux
cloudflared tunnel route dns touchmux touchmux.example.com
```

3. Create `~/.cloudflared/config.yml`.

```yaml
tunnel: touchmux
credentials-file: /home/your-user/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: touchmux.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

4. Run the tunnel.

```bash
cloudflared tunnel run touchmux
```

Notes:

- WebSocket terminal traffic works through Cloudflare Tunnel as long as the backend is reachable on the configured local port.
- If you use `hub + node`, keep Nodes off the public internet and publish only the Hub hostname.
- Set `TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com` so browser CORS is pinned to your real public origin.

## Requirements

- Node.js 24+
- `tmux`
- `codex` CLI
- Linux-first environment

## Related Docs

- [Technical overview](./docs/01_technical_overview.md)
- [Deployment notes](./docs/04_deployment_notes.md)
- [Feature status tracker](./docs/12_feature_status_tracker.md)

## License

MIT
