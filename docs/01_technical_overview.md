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
  - 通过共享密钥向 Hub 暴露内部接口

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
   - goal guard 成功判定

### Hub

1. Hub 读取静态节点列表。
2. 前端先从 Hub 获取节点和聚合后的会话列表。
3. 创建、关闭、文件操作等请求由 Hub 转发到目标 Node。
4. 终端 WebSocket 由前端连到 Hub，再由 Hub 桥接到目标 Node。
5. 会话快照由 Hub 轮询各 Node 后统一推送给前端。

## 当前边界

- 这是可演示、可自用的 MVP，不是生产级远程开发平台。
- 单用户口令登录已实现。
- 受控工作区文件访问已实现。
- 现在已支持“Hub + 多 Node 的统一入口”第一版，但仍是单用户优先设计。
- 节点注册目前是静态配置，不支持自动注册和网页内节点管理。
- goal guard 目前基于规则，不是智能理解型判定。
- 多用户、多权限、细粒度节点授权和完整安全加固仍未实现。
