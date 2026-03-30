# 部署说明

## 环境要求

- Node.js 24+
- tmux 3.2+
- codex CLI

## 推荐部署方式

### 单机版 `single`

1. 服务器运行 backend，`TOUCHMUX_RUNTIME_MODE=single`。
2. 前端构建为静态资源。
3. 通过 Cloudflare Tunnel、Nginx 或其他反向代理暴露。
4. 为 `/ws/events` 与 `/ws/terminal` 打开 WebSocket 转发。
5. 公开部署时建议显式设置 `TOUCHMUX_ALLOWED_ORIGINS`。

### 多节点版 `hub + node`

1. 每台工作机器运行一个 `node` 服务。
2. 统一入口服务器运行一个 `hub` 服务。
3. 前端只需要暴露 Hub。
4. Hub 与各 Node 之间的 HTTP 和终端 WebSocket 握手都通过 `TOUCHMUX_NODE_SHARED_SECRET`、`x-touchmux-node-ts`、`x-touchmux-node-signature` 通信。
5. Node 可放在内网，或通过受控反向代理暴露给 Hub。

## 本地开发

- 直接运行 `npm run dev` 可同时启动前端和后端，默认是 `single` 模式。
- `npm run dev:single` / `npm run dev:hub` / `npm run dev:node` 可切换运行角色。
- 若只调试单侧，仍可使用 `npm run dev:backend` 或 `npm run dev:frontend`。

## 健康检查

- `GET /api/system/health`
  - 无需登录
  - 只返回最小探针信息：`ok`、`runtimeMode`、`timestamp`
  - 可作为反向代理或容器探针基础
- `GET /api/system/health/detail`
  - 需要登录
  - 返回依赖探针、节点状态和安全告警
  - 适合运维排障，不建议公开给匿名访问

## 配置描述

- `GET /api/system/config-schema`
  - 登录后可读取
  - 返回所有环境变量的默认值、示例和说明
  - 适合未来做设置页或自动化部署表单

## Docker

```bash
docker compose up --build
```

当前 compose 方案主要解决以下问题：

- 后端服务默认监听 `8787`
- 数据目录与工作区目录通过 volume 映射
- 预留 `~/.codex` 只读挂载位

注意：容器内能否直接运行 `codex` 取决于你是否在容器中安装并认证了 Codex CLI。

当前仓库里的 Docker 仍以单机自托管为主。`hub + node` 的容器化部署还需要你根据目标拓扑补充节点配置、反向代理和安全策略。

## systemd

仓库已提供 [touchmux.service](../deploy/touchmux.service) 示例。

推荐流程：

1. 将仓库放到固定路径，例如 `/opt/touchmux`
2. 执行 `npm install && npm run build`
3. 准备 `.env`
4. 拷贝服务文件到 `/etc/systemd/system/`
5. `systemctl daemon-reload && systemctl enable --now touchmux`

## Cloudflare / 反向代理注意点

- 保持 WebSocket Upgrade 头透传
- 提高空闲超时，避免终端被代理过早断开
- HTTPS 场景下前端会自动使用 `wss://`

## 关键环境变量

- `TOUCHMUX_RUNTIME_MODE`
- `TOUCHMUX_PASSWORD`
- `TOUCHMUX_JWT_SECRET`
- `TOUCHMUX_PORT`
- `TOUCHMUX_FRONTEND_PORT`
- `TOUCHMUX_BACKEND_ORIGIN`
- `TOUCHMUX_BACKEND_WS_ORIGIN`
- `TOUCHMUX_ALLOWED_ORIGINS`
- `TOUCHMUX_WORKSPACE_ROOTS`
- `TOUCHMUX_NODE_ID`
- `TOUCHMUX_NODE_LABEL`
- `TOUCHMUX_NODE_PUBLIC_BASE_URL`
- `TOUCHMUX_NODE_SHARED_SECRET`
- `TOUCHMUX_NODE_REQUEST_TIMEOUT_MS`
- `TOUCHMUX_NODE_REQUEST_MAX_SKEW_MS`
- `TOUCHMUX_HUB_NODES_JSON`
- `TOUCHMUX_HUB_NODES_FILE`
- `TOUCHMUX_DATA_DIR`
- `TOUCHMUX_TOKEN_TTL_SEC`
- `TOUCHMUX_MAX_UPLOAD_BYTES`
- `TOUCHMUX_ALLOW_INSECURE_DEFAULTS`
- `TOUCHMUX_CODEX_COMMAND`
- `TOUCHMUX_DEFAULT_SHELL`
- `TOUCHMUX_GOAL_GUARD_INTERVAL_MS`
- `TOUCHMUX_IDLE_TIMEOUT_SEC`
- `TOUCHMUX_LOGIN_WINDOW_MS`
- `TOUCHMUX_LOGIN_MAX_ATTEMPTS`

## 开源与迁移

- SQLite 数据位于 `TOUCHMUX_DATA_DIR`
- 审计日志默认写入 `TOUCHMUX_DATA_DIR/audit.jsonl`
- 修改 `TOUCHMUX_WORKSPACE_ROOTS` 后即可迁移到新的目录布局
- 更推荐显式配置 `/home/your-user`、共享项目目录等允许根目录，而不是直接开放整个 `/`
- Codex 历史导入依赖 `~/.codex/history.jsonl`
- `single` 模式适合一台机器直接自托管
- `hub + node` 适合“一个网址聚合多台机器”，但当前仍是静态节点配置的第一版
- 部署时建议只公开 Hub，把 Node 放在可信内网、Tailscale、ZeroTier 或严格受控的反向代理之后；Node 不应直接裸露公网
- `hub` 和 `node` 模式默认不允许继续使用默认登录口令和默认 JWT 密钥；如需本地调试，必须显式设置 `TOUCHMUX_ALLOW_INSECURE_DEFAULTS=true`
