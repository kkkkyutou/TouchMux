# TouchMux

[English README](./README.md)

一个面向手机网页的 `tmux` / `Codex` 远程工作台。

持久化会话 · 触控友好的终端操作 · 恢复 / Fork Codex 对话 · 受控工作区访问 · 可点击选择项 · 目标守卫自动续跑

TouchMux 用手机浏览器把本机终端工作流变成可触控的远程操作台。它适合自托管场景：你可以在网页里管理长时间运行的 `tmux` / `Codex` 会话、浏览文件，并让任务在目标真正达成前持续执行。

当前仓库提供一个可运行的演示级 MVP：

- 后端：Node.js + TypeScript + Express + WebSocket
- 前端：React + Vite + TypeScript + xterm.js
- 持久化：SQLite（使用 Node 24 内置 `node:sqlite`）
- 终端桥接：`tmux` 会话托管 + WebSocket 终端流

## 仓库结构

- `backend/`：会话管理、文件系统 API、goal guard、WebSocket
- `frontend/`：移动优先工作台 UI
- `docs/`：技术与部署文档
- `deploy/`：systemd 服务样例
- `scripts/`：启动与部署脚本

## 主要能力

- 手机网页访问本机 `tmux` / `Codex`
- 新建、恢复、fork、关闭持久化 Codex 会话
- 导入 `~/.codex/history.jsonl` 中的已有 Codex 会话索引
- 浏览受控工作区根目录，并完成基础文件操作
- 对常见终端选择项提供点击式操作，而不只依赖方向键
- 在任务允许停止前，启用 goal guard 自动续跑
- 提供健康检查和配置 schema，方便部署和二次开发

## 当前状态

TouchMux 目前是一个自托管、单用户优先的 MVP。主链路已经打通，但它还不是完整的生产级远程开发平台。

## 未完成事项

- 多用户账号、角色权限和权限隔离还没有实现。
- 网页内完整文件编辑、上传、下载还没有实现。
- 点击选择项目前仍是启发式识别，不是完整的 TUI 语义解析。
- goal guard 目前是规则式，不是真正理解任务完成度的语义判定。
- 后端重启后的自动恢复仍是部分实现，依赖真实 `tmux` 状态。
- 已提供 Docker 部署骨架，但容器内直接运行 Codex 还不是开箱即用。
- 安全加固仍未完成：还没有登录限流、2FA、OAuth/SSO、更强会话管理，也还没有经过完整的生产级安全审查。

## 快速启动

1. 复制环境变量模板。

```bash
cp .env.example .env
```

2. 安装依赖。

```bash
npm install
```

3. 启动后端和前端。

```bash
npm run dev:backend
npm run dev:frontend
```

4. 打开前端地址并登录使用。

- 前端：`http://localhost:5173`
- 后端：`http://localhost:8787`

## 环境要求

- Node.js 24+
- `tmux`
- `codex` CLI
- 优先支持 Linux；macOS 理论可运行，但尚未系统验证

## 生产部署

- 后端可以作为单进程服务运行
- 前端构建后是静态资源
- 建议通过 Cloudflare Tunnel 或反向代理暴露
- 详见 [docs/01_technical_overview.md](./docs/01_technical_overview.md)

## Docker

```bash
docker compose up --build
```

默认会把当前仓库挂载到容器内 `/workspace`，并将 `docker-data/` 作为运行数据目录。

注意：

- 如果容器内需要直接运行 `codex`，你需要自己处理容器内的 Codex CLI 与认证。
- 当前 `docker-compose.yml` 主要用于演示部署骨架，不保证所有宿主机环境下直接即用。

## 开源协作

- 许可证：MIT
- 贡献说明：见 [CONTRIBUTING.md](./CONTRIBUTING.md)
- systemd 样例：见 [touchmux.service](./deploy/touchmux.service)
