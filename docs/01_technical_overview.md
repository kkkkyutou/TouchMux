# 技术总览

TouchMux 是一个移动优先的远程工作台，目标是通过网页操作 `tmux`、`codex` 和受控文件区。当前仓库已经从“单机直连”扩展为“双模式”架构：

- `single`
  - 单机直连模式
  - 后端直接管理本机 `tmux`、`codex`、文件系统和 goal guard
  - 适合一台机器自托管，部署最简单，也是保留的备份版和低复杂度版本
- `hub`
  - 多节点统一入口
  - 用户只登录 Hub 的一个网址
  - Hub 负责聚合节点、代理 HTTP / WebSocket、汇总会话列表
- `node`
  - 被 Hub 管理的工作节点
  - 管理本机 `tmux`、`codex`、文件系统和 goal guard
  - 通过共享密钥 + 时间戳 + HMAC 签名向 Hub 暴露内部接口

## 当前架构

- `backend/`
  - Express HTTP API
  - WebSocket 终端流
  - `single / hub / node` 三种运行角色
  - `tmux` 会话托管
  - `codex` 历史导入
  - goal guard 自动续跑
  - SQLite 持久化
- `frontend/`
  - React + Vite
  - xterm.js 终端视图
  - 节点感知的会话侧栏
  - 文件浏览器
  - goal guard 配置面板
- `docs/`
  - 技术、API、UI 和部署说明

## 运行模型

### Single / Node

1. 后端新建一个 `tmux` session。
2. 在对应 pane 中启动 `codex` 命令。
3. 前端通过 WebSocket 附着到该 `tmux` session。
4. 输出缓冲被后端用于：
   - 最近输出预览
   - 选择项识别
   - terminal fallback 调试与兼容判定
5. Goal Guard 的正式主判定已切到结构化事实链：
   - `CLI rollout -> CodexObserver`
   - `app-server thread/read + notification -> CodexAppServerObserver`
   - `reducer -> verificationReceipt -> satisfied / failed`

当前这条链路在代码里应被明确理解为：

- `executionChannel = tmux_local_tui`

它表示：

- TouchMux 当前正式主链路是“tmux 内启动本地 Codex TUI”
- 当前所有通过 rollout / terminal 观察到的 session id，都应被理解为这条本地 TUI 链路的派生信号

未来如果切到 app-server-backed 模式，应单独引入另一条链路：

- `executionChannel = app_server_remote_tui`

在那条链路落地前，不应把 `app-server thread/start` 返回的 thread id 直接当成当前 tmux 会话的真实 id。

不过就 Goal Guard 而言，`app_server_remote_tui` 相关的结构化事实层已经提前落地为后台观测能力，而不是正式执行主链。这一层当前已经包含：

- `CodexAppServerThreadManager`
  - 周期维护 `thread/read(includeTurns=true)` snapshot
- `CodexAppServerNotificationManager`
  - 在存在活跃 app-server 线程时保持最小后台常驻连接
- `CodexAppServerObserver`
  - 统一合并 thread snapshot、notification cache 与失败态冲突
- `appServerDebugSummary`
  - 统一展示最终状态、状态来源、fatalError 和后台健康

### Hub

1. Hub 读取静态节点列表。
2. 前端先从 Hub 获取节点和聚合后的会话列表。
3. 创建、关闭、文件操作等请求由 Hub 转发到目标 Node。
4. 终端 WebSocket 由前端连到 Hub，再由 Hub 桥接到目标 Node。
5. 会话快照由 Hub 轮询各 Node 后统一推送给前端。

## 当前安全边界

- 浏览器侧 CORS 现在支持 `TOUCHMUX_ALLOWED_ORIGINS` 白名单；不配置时仍保持开发友好的全开放模式。
- `GET /api/system/health` 现在只暴露最小探针信息，详细运行信息改到登录后的 `GET /api/system/health/detail`。
- Hub -> Node 的 HTTP 内部接口已升级为“共享密钥 + 时间戳 + nonce + HMAC 签名”。
- Hub -> Node 的终端 WebSocket 握手现在也纳入同一套签名和防重放校验。
- Node 仍更适合放在内网、Tailscale、ZeroTier 或受控代理之后，而不是直接裸露公网。

## 当前边界

- 这是可演示、可自用的 MVP，不是生产级远程开发平台。
- 单用户口令登录已实现。
- 受控工作区文件访问已实现。
- 现在已支持“Hub + 多 Node 的统一入口”第一版，但仍是单用户优先设计。
- 节点注册目前是静态配置，不支持自动注册和网页内节点管理。
- goal guard 当前已经不是“纯文本规则猜测成功/失败”。
- 当前正式语义是“结构化事实 + verifier receipt”。
- 但它仍然不能被表述成“100% 绝对准确”。
  - 当前 notification manager 仍是最小后台常驻版
  - 还没有做到 per-thread 长周期健康统计与强一致恢复
- 多用户、多权限、细粒度节点授权和完整安全加固仍未实现。
