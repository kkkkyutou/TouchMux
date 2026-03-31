# TouchMux

[English README](./README.md)

`TouchMux` 是一个面向手机网页的 `tmux` / `Codex` 远程工作台。

它把手机浏览器变成远程终端控制台，适合管理持久化会话、受控文件区，以及长时间运行的 Codex 任务。

📱 面向触屏的终端界面  
🧭 支持单机版和 Hub + Node 多机版  
📂 自带文件浏览、编辑、上传、下载  
🔒 Hub -> Node 已使用签名链路做基础安全收口

## 核心介绍

- 新建、恢复、fork、重连持久化 `tmux` / `Codex` 会话。
- 通过 WebSocket 把终端推到手机端。
- 浏览允许访问的根目录，并在网页内直接改文件。
- 导入 `~/.codex/history.jsonl` 里的 Codex 历史会话。
- 用 Goal Guard 控制任务是否允许停止。
- 需要时可通过一个 Hub 聚合多台机器。

TouchMux 当前是一个自托管、单用户优先的 MVP。`single` 主链路已经比较稳定，`hub + node` 也已经可用，但还不是生产级多用户平台。

## 系统架构

TouchMux 更适合从两个维度理解。

### 两种部署模式

| 模式 | 适合场景 | 形态 |
| --- | --- | --- |
| `single-machine` | 一台工作机，或者最简单的自托管方式 | 一个 TouchMux 服务管理一台机器 |
| `hub-plus-node` | 一个公网入口接入多台私有机器 | 一个 Hub 聚合多个 Node |

### 三种运行角色

| 角色 | 出现在哪种模式里 | 主要职责 |
| --- | --- | --- |
| `single` | `single-machine` | 单机一体化角色，负责认证、界面托管、会话、文件和终端桥接 |
| `hub` | `hub-plus-node` | 对外统一入口，负责鉴权、节点聚合、API 代理和终端桥接 |
| `node` | `hub-plus-node` | 私有工作节点，负责本机 `tmux`、`Codex`、文件系统和 Goal Guard |

```text
单机模式
浏览器 -> TouchMux(single) -> tmux / Codex / 文件系统 / Goal Guard

Hub + Node 模式
浏览器 -> TouchMux(hub) -> 已签名的 HTTP + 已签名的 WebSocket 握手 -> TouchMux(node)
```

## 快速开始

```bash
cp .env.example .env
npm install
npm run dev
```

最小本地配置：

```env
TOUCHMUX_RUNTIME_MODE=single
TOUCHMUX_PASSWORD=replace-with-a-strong-password
TOUCHMUX_JWT_SECRET=replace-with-a-long-random-secret
TOUCHMUX_PORT=8787
TOUCHMUX_FRONTEND_PORT=5173
TOUCHMUX_BACKEND_ORIGIN=http://127.0.0.1:8787
TOUCHMUX_BACKEND_WS_ORIGIN=ws://127.0.0.1:8787
# 本地开发可留空；公开部署建议设置成真实域名。
# TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com
# TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
# 如果你希望复用某个已登录的 Codex home，可显式指定这个 HOME。
# TOUCHMUX_SESSION_HOME=/home/your-user
```

打开：

- 开发前端：`http://localhost:5173`
- 构建后的单端口应用：`http://localhost:8787`

常用命令：

- `npm run dev`
- `npm run dev:single`
- `npm run dev:hub`
- `npm run dev:node`
- `npm run typecheck`
- `npm run build`
- `npm run smoke:single`
- `npm run smoke:hub-node`

## Hub + Node

Node：

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

Hub：

```env
TOUCHMUX_RUNTIME_MODE=hub
TOUCHMUX_PASSWORD=replace-with-a-strong-password
TOUCHMUX_JWT_SECRET=replace-with-a-long-random-secret
TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com
TOUCHMUX_PORT=8787
TOUCHMUX_HUB_NODES_JSON=[{"id":"workstation-a","label":"Workstation A","baseUrl":"http://127.0.0.1:9787","sharedSecret":"replace-with-a-long-random-secret"}]
```

推荐：

- 只把 Hub 暴露到公网。
- Node 放在局域网、Tailscale、ZeroTier 或受控代理后面。

## 以 Cloudflare Tunnel 为例暴露端口

先在本机跑构建后的应用：

```bash
npm run build
TOUCHMUX_HOST=127.0.0.1 TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com npm run start -w backend
```

创建并运行 Tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel create touchmux
cloudflared tunnel route dns touchmux touchmux.example.com
cloudflared tunnel run touchmux
```

示例 `~/.cloudflared/config.yml`：

```yaml
tunnel: touchmux
credentials-file: /home/your-user/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: touchmux.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

## 安全说明

- 公开部署时建议显式设置 `TOUCHMUX_ALLOWED_ORIGINS`。
- `GET /api/system/health` 只暴露最小匿名探针。
- `GET /api/system/health/detail` 需要登录。
- Codex 登录态、历史导入和 sessions 目录默认跟随 `TOUCHMUX_SESSION_HOME`，未设置时跟随后端进程自己的 HOME。
- Hub -> Node 的 HTTP 和终端 WebSocket 握手现在都使用共享密钥 + 时间戳 + nonce + 签名：
  - `x-touchmux-node-secret`
  - `x-touchmux-node-ts`
  - `x-touchmux-node-nonce`
  - `x-touchmux-node-signature`
- Node 仍然更适合放在可信网络边界后面。
- 不要把 `/` 直接作为工作区根目录。

## 相关文档

- [技术总览](./docs/01_technical_overview.md)
- [API 与事件](./docs/02_api_and_events.md)
- [部署说明](./docs/04_deployment_notes.md)
- [功能状态跟踪](./docs/12_feature_status_tracker.md)

## License

MIT
