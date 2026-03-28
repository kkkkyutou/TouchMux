# 技术总览

TouchMux 是一个移动优先的远程工作台，目标是通过网页操作本机的 `tmux`、`codex` 和受控文件区。

## 当前架构

- `backend/`
  - Express HTTP API
  - WebSocket 终端流
  - `tmux` 会话托管
  - `codex` 历史导入
  - goal guard 自动续跑
  - SQLite 持久化
- `frontend/`
  - React + Vite
  - xterm.js 终端视图
  - 会话侧栏
  - 文件浏览器
  - goal guard 配置面板
- `docs/`
  - 技术、API、UI 和部署说明

## 运行模型

1. 后端新建一个 `tmux` session。
2. 在对应 pane 中启动 `codex` 命令。
3. 前端通过 WebSocket 附着到该 `tmux` session。
4. 输出缓冲被后端用于：
   - 最近输出预览
   - 选择项识别
   - goal guard 成功判定

## 当前边界

- 这是可演示、可自用的 MVP。
- 单用户口令登录已实现。
- 受控工作区文件访问已实现。
- 多用户、多权限、多机统一编排尚未实现。
- goal guard 目前基于规则，不是智能理解型判定。
