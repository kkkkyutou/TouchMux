# API 与事件

## HTTP

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

## WebSocket

- `/ws/events`
  - 推送会话快照
  - 推送单会话更新
- `/ws/terminal`
  - 终端数据流
  - 输入与 resize

## 会话创建模式

- `new`
  - 新建 Codex 会话
- `resume`
  - 从现有 Codex session id 恢复到新的 tmux
- `fork`
  - 从现有 Codex session id fork 到新的 tmux
