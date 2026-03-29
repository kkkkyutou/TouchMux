# TouchMux

[English README](./README.md)

一个面向手机网页的 `tmux` / `Codex` 远程工作台，同时支持单机版和 Hub + Node 多机聚合版。

持久化会话 · 触控友好的终端操作 · 单机备份版 · Hub 多机统一入口 · 受控工作区访问 · 可点击选择项 · 目标守卫自动续跑

TouchMux 用手机浏览器把终端工作流变成可触控的远程操作台。它适合自托管场景：你可以在网页里管理长时间运行的 `tmux` / `Codex` 会话、浏览文件，并让任务在目标真正达成前持续执行。现在它既可以作为单机直连版使用，也可以通过一个 Hub 网址统一访问多台机器上的 Node。

当前仓库提供一个可运行的演示级 MVP：

- 后端：Node.js + TypeScript + Express + WebSocket
- 前端：React + Vite + TypeScript + xterm.js
- 持久化：SQLite（使用 Node 24 内置 `node:sqlite`）
- 终端桥接：`tmux` 会话托管 + WebSocket 终端流

## 运行模式

- `single`
  - 原始单机直连模式
  - 一个 TouchMux 实例管理一台机器
  - 部署最简单，也是当前保留的备份版和低复杂度版本
- `hub`
  - 多台机器统一入口
  - 用户只打开一个网址，Hub 负责转发 API 和终端流
- `node`
  - 被 Hub 管理的工作节点
  - 节点机负责本地 `tmux`、`codex`、文件系统和 goal guard

## 仓库结构

- `backend/`：会话管理、文件系统 API、goal guard、WebSocket
- `frontend/`：移动优先工作台 UI
- `docs/`：技术与部署文档
- `deploy/`：systemd 服务样例
- `scripts/`：启动与部署脚本

## 主要能力

- 手机网页访问本机 `tmux` / `Codex`
- 在简单单机部署和“一个网址管理多台机器”的 Hub 模式之间切换
- 左上角按钮可拉出终端管理抽屉，用来切换、创建、关闭或删除当前终端
- 抽屉内可先选择机器，再查看该机器下的已有终端和允许访问的根目录
- 新建、恢复、fork、关闭持久化 Codex 会话
- 默认控制台保持空白，只有你明确选择某个终端后才会显示对应内容
- 需要先点“新建终端”按钮，再展开填写路径和其它参数
- 创建会话时支持单行地址栏直接输入完整路径，并提供可点击的目录建议
- Goal Guard 在抽屉内以可折叠方式展示，手机窄屏下不会挤占主要会话操作区
- 导入 `~/.codex/history.jsonl` 中的已有 Codex 会话索引
- 默认把真实 Ubuntu 用户主目录作为可访问根目录，并支持配置多个允许的根目录
- 主页面以终端控制台为主；竖屏下文件管理以底部抽屉形式展开
- 浏览受控根目录，支持面包屑导航、返回上一级，并自动同步到当前会话目录
- 直接在网页中编辑并保存文本文件
- 支持网页内上传和下载文件
- 对常见终端选择项提供点击式操作，而不只依赖方向键
- 在任务允许停止前，启用 goal guard 自动续跑
- 前端重模块按需加载，并对终端相关依赖做了独立分包
- 支持配置前端开发端口、后端端口和代理目标
- 开发时可用一条命令同时启动前后端
- 提供基础登录限流，并为关键操作写入本地审计日志
- 提供健康检查和配置 schema，方便部署和二次开发

## 当前状态

TouchMux 目前是一个自托管、单用户优先的 MVP。单机主链路已经比较稳定，`hub + node` 的第一版多机统一入口也已经实现，但它还不是完整的生产级远程开发平台。

## 未完成事项

- 多用户账号、角色权限和权限隔离还没有实现。
- 节点自动注册、节点管理页、网页内维护节点列表还没有实现。
- 二进制预览、更完整的网页编辑体验、大文件处理策略还没有实现。
- 点击选择项目前仍是启发式识别，不是完整的 TUI 语义解析。
- goal guard 目前是规则式，不是真正理解任务完成度的语义判定。
- 后端重启后的自动恢复仍是部分实现，依赖真实 `tmux` 状态。
- 已提供 Docker 部署骨架，但容器内直接运行 Codex 还不是开箱即用。
- 安全加固仍未完成：还没有 2FA、OAuth/SSO、更强会话管理，也还没有经过完整的生产级安全审查。

## 快速启动

1. 复制环境变量模板。

```bash
cp .env.example .env
```

2. 安装依赖。

```bash
npm install
```

3. 用一条命令启动整套开发环境。

```bash
npm run dev
```

默认会以 `single` 模式启动。

4. 如有需要，先在 `.env` 中配置端口、代理和允许访问的根目录。

```env
TOUCHMUX_RUNTIME_MODE=single
TOUCHMUX_PORT=8787
TOUCHMUX_FRONTEND_PORT=5173
TOUCHMUX_BACKEND_ORIGIN=http://127.0.0.1:8787
TOUCHMUX_BACKEND_WS_ORIGIN=ws://127.0.0.1:8787
# 可选。不设置时默认使用当前 Linux 用户主目录。
# TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
TOUCHMUX_LOGIN_WINDOW_MS=60000
TOUCHMUX_LOGIN_MAX_ATTEMPTS=6
TOUCHMUX_TOKEN_TTL_SEC=604800
TOUCHMUX_MAX_UPLOAD_BYTES=2097152
TOUCHMUX_NODE_REQUEST_TIMEOUT_MS=8000
```

5. 打开前端地址并登录使用。

- 前端：`http://localhost:5173`
- 后端：`http://localhost:8787`

如果你修改了端口，请使用你自己的配置值访问。

如果只是想单独调试某一侧，仍然可以分别使用 `npm run dev:backend` 和 `npm run dev:frontend`。

### Hub + Node 示例

某台工作机作为 Node：

```env
TOUCHMUX_RUNTIME_MODE=node
TOUCHMUX_NODE_ID=workstation-a
TOUCHMUX_NODE_LABEL=Workstation A
TOUCHMUX_NODE_SHARED_SECRET=replace-with-a-long-random-secret
TOUCHMUX_PORT=9787
TOUCHMUX_WORKSPACE_ROOTS=/home/your-user,/srv/shared
```

统一入口服务器作为 Hub：

```env
TOUCHMUX_RUNTIME_MODE=hub
TOUCHMUX_PORT=8787
TOUCHMUX_HUB_NODES_JSON=[{"id":"workstation-a","label":"Workstation A","baseUrl":"http://127.0.0.1:9787","sharedSecret":"replace-with-a-long-random-secret"}]
```

常用开发命令：

- `npm run dev:single`
- `npm run dev:hub`
- `npm run dev:node`

## 环境要求

- Node.js 24+
- `tmux`
- `codex` CLI
- 优先支持 Linux；macOS 理论可运行，但尚未系统验证

## 生产部署

- 后端可以作为单进程服务运行
- 前端构建后是静态资源
- 建议通过 Cloudflare Tunnel 或反向代理暴露
- 不建议默认直接开放整个 `/`，更推荐显式配置 `/home/your-user` 或共享项目目录
- 如果使用 `hub + node`，建议只公开 Hub，把 Node 放在可信内网或严格受控的代理之后
- 详见 [docs/01_technical_overview.md](./docs/01_technical_overview.md)

## 开源前安全提示

- `.env`、运行期 SQLite、任意层级的 `**/.data/` 目录，以及本地 autoresearch 产物，默认都不会被提交
- 这个仓库面向自托管使用；正式对外部署前，请重新检查密钥、代理配置和允许访问的根目录
- 运行期审计日志会写入 `TOUCHMUX_DATA_DIR/audit.jsonl`
- `node` 模式必须配置足够强的 `TOUCHMUX_NODE_SHARED_SECRET`，不要用弱口令或默认值
- `hub` 和 `node` 模式现在默认拒绝用登录默认口令或默认 JWT 密钥启动；只有本地调试时才应显式设置 `TOUCHMUX_ALLOW_INSECURE_DEFAULTS=true`
- 上传大小由 `TOUCHMUX_MAX_UPLOAD_BYTES` 控制，Hub -> Node 请求超时由 `TOUCHMUX_NODE_REQUEST_TIMEOUT_MS` 控制
- 如果你要公开截图或录屏，注意不要泄露真实路径、shell 历史或 Codex 对话内容

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
