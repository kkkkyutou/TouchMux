# 部署说明

## 环境要求

- Node.js 24+
- tmux 3.2+
- codex CLI

## 推荐部署方式

1. 服务器运行 backend。
2. 前端构建为静态资源。
3. 通过 Cloudflare Tunnel、Nginx 或其他反向代理暴露。
4. 为 `/ws/events` 与 `/ws/terminal` 打开 WebSocket 转发。

## 健康检查

- `GET /api/system/health`
  - 无需登录
  - 返回 `tmux` 与 `codex` 可用性
  - 可作为反向代理或容器探针基础

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

- 后端服务固定监听 `8787`
- 数据目录与工作区目录通过 volume 映射
- 预留 `~/.codex` 只读挂载位

注意：容器内能否直接运行 `codex` 取决于你是否在容器中安装并认证了 Codex CLI。

## systemd

仓库已提供 [touchmux.service](/home/kyutou/projects/SSHconnect/deploy/touchmux.service) 示例。

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

- `TOUCHMUX_PASSWORD`
- `TOUCHMUX_JWT_SECRET`
- `TOUCHMUX_PORT`
- `TOUCHMUX_WORKSPACE_ROOTS`
- `TOUCHMUX_DATA_DIR`
- `TOUCHMUX_CODEX_COMMAND`
- `TOUCHMUX_DEFAULT_SHELL`
- `TOUCHMUX_GOAL_GUARD_INTERVAL_MS`
- `TOUCHMUX_IDLE_TIMEOUT_SEC`

## 开源与迁移

- SQLite 数据位于 `TOUCHMUX_DATA_DIR`
- 修改 `TOUCHMUX_WORKSPACE_ROOTS` 后即可迁移到新的目录布局
- Codex 历史导入依赖 `~/.codex/history.jsonl`
