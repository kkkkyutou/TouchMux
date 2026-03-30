# TouchMux

[English README](./README.md)

`TouchMux` 是一个面向手机网页的 `tmux` / `Codex` 远程工作台。

你可以直接用手机浏览器管理持久化终端会话、浏览受控工作区、在线编辑文件，并用 Goal Guard 让任务在真正满足停止条件前继续执行。它既能跑在一台机器上，也能通过一个公开 Hub 统一接入多台私有 Node。

📱 面向触屏的远程终端工作台  
🧭 同时支持单机版和 Hub + Node 多机版  
📂 自带受控文件浏览与编辑  
🔒 针对自托管场景做了第一轮安全加固

## 这是什么

- 在网页里新建、恢复、fork、关闭、重连 `tmux` / `Codex` 会话。
- 通过 WebSocket 把终端实时推到手机端。
- 浏览允许访问的根目录，编辑文本文件，上传文件，下载结果。
- 导入 `~/.codex/history.jsonl` 里的已有 Codex 会话索引。
- 识别常见终端选择项，允许直接点选，而不只靠方向键。
- 用 Goal Guard 控制“任务是不是允许停”，不满足条件时自动续跑。
- 用一个 Hub 入口聚合多台机器，同时尽量把 Node 留在内网。
- 在后端重启后恢复最近输出、choice overlay 和自动续跑上下文。

## 当前状态

TouchMux 目前是一个自托管、单用户优先的 MVP。单机链路已经比较稳定，`hub + node` 的第一版也已经能用，适合个人远程工作台和内部演示，但还不是完整的生产级远程开发平台。

## 还没完成的部分

- 多用户账号、角色和权限隔离。
- 动态节点注册与真正的节点管理界面。
- 更完整的二进制预览与大文件编辑策略。
- 超越当前规则式 Goal Guard 的语义级任务完成判断。
- 更完整的生产安全体系，包括 2FA、OAuth/SSO、会话强化和正式安全审查。
- 容器内开箱即用的 Codex 运行环境。

## 系统架构

TouchMux 目前有三种运行角色：

- `single`
  - 一个 TouchMux 实例管理一台机器。
  - 适合最简单的自托管部署。
- `hub`
  - 对外统一入口。
  - 负责聚合多台机器、代理鉴权 API、桥接终端 WebSocket。
- `node`
  - 被 Hub 管理的工作节点。
  - 负责本机 `tmux`、`Codex`、文件系统和 Goal Guard。

### 请求流

```text
浏览器
  -> 前端（React + xterm.js）
  -> 后端 API / WebSocket（Express + ws）
  -> Session Manager / File Service / Goal Guard / SQLite
  -> 本机 tmux + Codex

Hub 模式：
浏览器
  -> Hub
  -> 已签名的 HTTP 请求 + 终端 WebSocket 转发
  -> Node
  -> 目标机器上的 tmux + Codex
```

### 代码结构

- `backend/`
  - Express API、认证、会话管理、Goal Guard、Hub / Node 路由、WebSocket 桥接
- `frontend/`
  - React 界面、终端视图、会话抽屉、文件浏览器、Goal Guard 编辑器
- `docs/`
  - 技术说明、部署说明、功能状态文档
- `deploy/`
  - `systemd` 服务示例
- `scripts/`
  - 本地开发启动脚本和 smoke 校验脚本

## 安全说明

这个项目面向自托管，安全模型刻意保持简单。当前已经做了一轮比较务实的安全收口，但还远没到“公网生产平台”的程度。

- `TOUCHMUX_ALLOWED_ORIGINS` 可用于限制浏览器 CORS 来源。开发时可以留空，公开部署建议显式填写。
- `GET /api/system/health` 现在只返回最小匿名探针信息。
- `GET /api/system/health/detail` 需要登录后访问，返回依赖探针、节点状态和安全警告。
- Hub -> Node 的内部 HTTP 请求现在使用 `TOUCHMUX_NODE_SHARED_SECRET`，并附带 `x-touchmux-node-ts`、`x-touchmux-node-signature` HMAC 签名。
- Node 终端 WebSocket 目前仍然主要依赖共享密钥，所以 Node 更适合放在内网、Tailscale、ZeroTier 或严格受控的代理后面。
- 不要把 `/` 直接作为工作区根目录开放，推荐显式配置 `/home/your-user` 或共享项目目录。

## 快速开始

### 1. 安装依赖

```bash
cp .env.example .env
npm install
```

### 2. 配置最小环境变量

本地开发示例：

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
# 可选。不设置时默认使用当前 Linux 用户主目录。
# TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
```

### 3. 启动

开发模式：

```bash
npm run dev
```

更接近正式部署的单端口方式：

```bash
npm run build
npm run start -w backend
```

当 `frontend/dist` 存在后，后端会直接把前端静态文件一并托管出来。

### 4. 打开页面

- 开发前端：`http://localhost:5173`
- 后端或构建后的单端口应用：`http://localhost:8787`

## Hub + Node 示例

Node 机器：

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

Hub 机器：

```env
TOUCHMUX_RUNTIME_MODE=hub
TOUCHMUX_PASSWORD=replace-with-a-strong-password
TOUCHMUX_JWT_SECRET=replace-with-a-long-random-secret
TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com
TOUCHMUX_PORT=8787
TOUCHMUX_HUB_NODES_JSON=[{"id":"workstation-a","label":"Workstation A","baseUrl":"http://127.0.0.1:9787","sharedSecret":"replace-with-a-long-random-secret"}]
```

推荐做法：

- 只把 Hub 暴露到公网。
- Node 尽量不要直接公开。
- 更推荐把 Node 放在局域网、Tailscale、ZeroTier 或严格受控的反向代理后面。

## 怎么使用

典型使用流程：

1. 登录网页。
2. 在会话抽屉里选择目标机器。
3. 新建或恢复一个 `tmux` / `Codex` 会话。
4. 以终端作为主工作区继续操作。
5. 需要看文件或改文件时再打开文件浏览器。
6. 如果任务不该轻易停止，就给它配置 Goal Guard。

常用开发命令：

- `npm run dev`
- `npm run dev:single`
- `npm run dev:hub`
- `npm run dev:node`
- `npm run typecheck`
- `npm run build`
- `npm run smoke:single`
- `npm run smoke:hub-node`

## 以 Cloudflare Tunnel 为例暴露端口

一个比较稳妥的公开方式是：

- 先把 TouchMux 跑在本机 `127.0.0.1:8787`
- 再用 Cloudflare Tunnel 暴露这个本地端口
- 如果你在用 `hub + node`，只暴露 Hub，不暴露 Node

### 示例

1. 先在本机启动 TouchMux。

```bash
npm run build
TOUCHMUX_HOST=127.0.0.1 TOUCHMUX_ALLOWED_ORIGINS=https://touchmux.example.com npm run start -w backend
```

2. 创建一个命名 Tunnel。

```bash
cloudflared tunnel login
cloudflared tunnel create touchmux
cloudflared tunnel route dns touchmux touchmux.example.com
```

3. 准备 `~/.cloudflared/config.yml`。

```yaml
tunnel: touchmux
credentials-file: /home/your-user/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: touchmux.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

4. 启动 Tunnel。

```bash
cloudflared tunnel run touchmux
```

注意：

- Cloudflare Tunnel 会正常转发终端 WebSocket，只要本地后端端口可达即可。
- 如果你使用 `hub + node`，建议只有 Hub 绑定公网域名。
- `TOUCHMUX_ALLOWED_ORIGINS` 最好写成你的真实公开域名，例如 `https://touchmux.example.com`。

## 运行要求

- Node.js 24+
- `tmux`
- `codex` CLI
- 优先支持 Linux

## 相关文档

- [技术总览](./docs/01_technical_overview.md)
- [部署说明](./docs/04_deployment_notes.md)
- [功能状态跟踪](./docs/12_feature_status_tracker.md)

## License

MIT
