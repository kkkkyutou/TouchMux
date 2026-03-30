# API 与事件

## HTTP

- `GET /api/nodes`
- `POST /api/auth/login`
- `GET /api/system/capabilities`
- `GET /api/session/list`
- `POST /api/session/create`
- `POST /api/session/:id/close`
- `GET /api/session/:id/detail`
- `GET /api/codex/history`
- `GET /api/workspace/roots`
- `GET /api/fs/list`
- `GET /api/fs/file`
- `POST /api/fs/folder`
- `POST /api/fs/file`
- `POST /api/fs/rename`
- `POST /api/fs/delete`
- `GET /api/goal-guard/:sessionId`
- `PUT /api/goal-guard/:sessionId`
- `POST /api/goal-guard/:sessionId/override-stop`

当运行在 `hub` 模式时，以下公开接口需要携带 `nodeId`：

- 会话创建、关闭、Goal Guard 更新
- 文件浏览、读取、编辑、上传、下载、重命名、删除
- `GET /api/codex/history`
- `GET /api/workspace/roots`

## Node 内部接口

当运行在 `node` 模式时，TouchMux 还会额外暴露一组内部接口，供 Hub 使用。当前内部通道分为两类：

- `/api/node/*` HTTP 接口
- `/ws/node/terminal` 终端 WebSocket

它们都需要以下头部参与鉴权：

- `x-touchmux-node-secret`
- `x-touchmux-node-ts`
- `x-touchmux-node-signature`

其中 `x-touchmux-node-signature` 是基于共享密钥、请求方法、路径、时间戳和请求体计算的 HMAC 签名。

### Node 内部 HTTP

- `GET /api/node/system/capabilities`
- `GET /api/node/session/list`
- `POST /api/node/session/create`
- `POST /api/node/session/:id/close`
- `GET /api/node/codex/history`
- `GET /api/node/fs/list`
- `GET /api/node/fs/file`
- `PUT /api/node/fs/file`
- `POST /api/node/fs/upload`
- `GET /api/node/fs/download`
- `POST /api/node/fs/folder`
- `POST /api/node/fs/file`
- `POST /api/node/fs/rename`
- `POST /api/node/fs/delete`
- `PUT /api/node/goal-guard/:sessionId`
- `POST /api/node/goal-guard/:sessionId/override-stop`

## WebSocket

- `/ws/events`
  - `single / node` 模式下推送本机会话快照与更新
  - `hub` 模式下推送聚合后的多节点会话快照
- `/ws/terminal`
  - 对前端公开的终端数据流
  - `single / node` 模式下直接附着本机 `tmux`
  - `hub` 模式下代理到目标 Node
- `/ws/node/terminal`
  - 仅供 Hub 连接的节点终端桥接 WebSocket
  - 需要 `x-touchmux-node-secret`、`x-touchmux-node-ts`、`x-touchmux-node-signature`

## 会话创建模式

- `new`
  - 新建 Codex 会话
- `resume`
  - 从现有 Codex session id 恢复到新的 tmux
- `fork`
  - 从现有 Codex session id fork 到新的 tmux
