# TouchMux

面向手机网页的远程工作台。它把 `tmux`、`codex` 和受控文件系统操作整合到一个移动优先的 Web 界面中，支持持久化会话、恢复已有 Codex 对话、可点击选择项，以及“目标未达成不得停止”的 goal guard 自动续跑。

当前仓库提供一个可运行的演示级 MVP：

- 后端：Node.js + TypeScript + Express + WebSocket
- 前端：React + Vite + TypeScript + xterm.js
- 持久化：SQLite（使用 Node 24 内置 `node:sqlite`）
- 终端：`tmux` 会话托管 + WebSocket 终端桥接

## 仓库结构

- `backend/`：会话管理、文件系统 API、goal guard、WebSocket
- `frontend/`：移动优先工作台 UI
- `docs/`：技术与部署文档
- `deploy/`：systemd 服务样例
- `scripts/`：启动与部署脚本

## 主要能力

- 手机网页访问本机 `tmux` / `codex`
- 新建、恢复、fork、关闭 Codex 会话
- 导入 `~/.codex/history.jsonl` 中的已有会话索引
- 受控根目录下的文件夹浏览、新建文件夹、新建文件、重命名、删除
- 常见终端选择项识别与点击操作
- goal guard：未达成目标前，禁止普通停止并可自动续跑
- 健康检查与配置 schema，便于容器编排和二次开发

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

4. 打开前端地址，登录后使用。

- 前端默认：`http://localhost:5173`
- 后端默认：`http://localhost:8787`

## 环境要求

- Node.js 24+
- `tmux`
- `codex` CLI
- Linux 优先；macOS 理论上可运行，但尚未系统验证

## 生产部署

- 后端可直接作为单进程服务运行
- 前端构建后为静态资源
- 建议通过 Cloudflare Tunnel 或反向代理暴露
- 详见 [docs/01_technical_overview.md](/home/kyutou/projects/SSHconnect/docs/01_technical_overview.md)

## Docker

```bash
docker compose up --build
```

默认会把当前仓库挂载到容器内 `/workspace`，并将 `docker-data/` 作为运行数据目录。

注意：

- 如果容器内需要直接运行 `codex`，你需要自己处理容器内的 `codex` CLI 与认证。
- 当前 `docker-compose.yml` 主要用于演示部署骨架，不保证所有宿主机环境下直接即用。

## 开源协作

- 许可证：MIT
- 贡献说明：见 [CONTRIBUTING.md](/home/kyutou/projects/SSHconnect/CONTRIBUTING.md)
- systemd 样例：见 [touchmux.service](/home/kyutou/projects/SSHconnect/deploy/touchmux.service)
