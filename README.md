# TouchMux

[简体中文](./README_CN.md)

`TouchMux` is a mobile-first web workbench for `tmux` and `Codex`.

It turns a phone browser into a remote cockpit for persistent terminal sessions, controlled file access, and long-running Codex tasks.

📱 Touch-friendly terminal  
🧭 Single-machine and Hub + Node deployments  
📂 File browser, editor, upload, download  
🔒 Signed Hub -> Node trust path for self-hosted use

## What Matters

- Create, resume, fork, and reconnect persistent `tmux` / `Codex` sessions.
- Stream terminals over WebSocket with a mobile-first UI.
- Browse allowed workspace roots and edit files in the browser.
- Import Codex history from `~/.codex/history.jsonl`.
- Keep tasks alive with Goal Guard until stop conditions are satisfied.
- Aggregate multiple machines behind one Hub URL when needed.

TouchMux is currently a self-hosted single-user MVP. The `single` path is stable, and `hub + node` is usable, but this is still not a production-grade multi-user platform.

## Architecture

TouchMux is easiest to read in two dimensions.

### Two Deployment Modes

| Mode | Best for | Shape |
| --- | --- | --- |
| `single-machine` | one workstation or the simplest self-hosted setup | one TouchMux service manages one machine |
| `hub-plus-node` | one public entrypoint for multiple private machines | one Hub aggregates multiple Nodes |

### Three Runtime Roles

| Role | Used in | Responsibility |
| --- | --- | --- |
| `single` | `single-machine` | all-in-one role for auth, UI serving, sessions, files, and terminal bridge |
| `hub` | `hub-plus-node` | public gateway for auth, node aggregation, API proxying, and terminal bridging |
| `node` | `hub-plus-node` | private worker that owns local `tmux`, `Codex`, files, and Goal Guard |

```text
Single-machine mode
Browser -> TouchMux(single) -> tmux / Codex / Filesystem / Goal Guard

Hub + Node mode
Browser -> TouchMux(hub) -> signed HTTP + signed WebSocket handshake -> TouchMux(node)
```

## Quick Start

```bash
cp .env.example .env
npm install
npm run dev
```

Minimal local config:

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
# TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
# If you want to reuse an existing logged-in Codex home, set this explicitly.
# TOUCHMUX_SESSION_HOME=/home/your-user
```

Open:

- Dev frontend: `http://localhost:5173`
- Built single-port app: `http://localhost:8787`

Useful commands:

- `npm run dev`
- `npm run dev:single`
- `npm run dev:hub`
- `npm run dev:node`
- `npm run typecheck`
- `npm run build`
- `npm run smoke:single`
- `npm run smoke:hub-node`

## Hub + Node

Node:

```env
TOUCHMUX_RUNTIME_MODE=node
TOUCHMUX_NODE_ID=workstation-a
TOUCHMUX_NODE_LABEL=Workstation A
TOUCHMUX_NODE_SHARED_SECRET=replace-with-a-long-random-secret
TOUCHMUX_NODE_REQUEST_MAX_SKEW_MS=60000
TOUCHMUX_NODE_REQUEST_REPLAY_CACHE_LIMIT=10000
TOUCHMUX_PORT=9787
TOUCHMUX_HOST=127.0.0.1
TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
```

Hub:

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
- Keep Nodes on LAN, Tailscale, ZeroTier, or a tightly controlled proxy.

## Cloudflare Tunnel Example

Run the built app locally:

```bash
npm run build
TOUCHMUX_HOST=127.0.0.1 TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com npm run start -w backend
```

Create and run a tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create touchmux
cloudflared tunnel route dns touchmux touchmux.example.com
cloudflared tunnel run touchmux
```

Example `~/.cloudflared/config.yml`:

```yaml
tunnel: touchmux
credentials-file: /home/your-user/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: touchmux.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

## Security Notes

- `TOUCHMUX_ALLOWED_ORIGINS` should be set for public deployments.
- `GET /api/system/health` is a minimal anonymous probe.
- `GET /api/system/health/detail` requires login.
- Codex auth, history import, and session state follow `TOUCHMUX_SESSION_HOME`; if unset they follow the backend process HOME.
- Hub -> Node HTTP and terminal WebSocket handshakes use shared-secret HMAC headers with timestamp and nonce:
  - `x-touchmux-node-secret`
  - `x-touchmux-node-ts`
  - `x-touchmux-node-nonce`
  - `x-touchmux-node-signature`
- Nodes should still stay behind a trusted network boundary.
- Do not expose `/` as a workspace root.

## Docs

- [Technical overview](./docs/01_technical_overview.md)
- [API and events](./docs/02_api_and_events.md)
- [Deployment notes](./docs/04_deployment_notes.md)
- [Feature status tracker](./docs/12_feature_status_tracker.md)

## License

MIT
