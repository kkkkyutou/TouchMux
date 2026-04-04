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
- `x-touchmux-node-nonce`
- `x-touchmux-node-signature`

其中 `x-touchmux-node-signature` 是基于共享密钥、请求方法、路径、时间戳、nonce 和请求体计算的 HMAC 签名；Node 会缓存最近见过的 nonce 以拒绝重放请求。

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
  - 需要 `x-touchmux-node-secret`、`x-touchmux-node-ts`、`x-touchmux-node-nonce`、`x-touchmux-node-signature`

## 会话创建模式

- `new`
  - 新建 Codex 会话
- `resume`
  - 从现有 Codex session id 恢复到新的 tmux
- `fork`
  - 从现有 Codex session id fork 到新的 tmux

## 当前执行链路语义

当前 TouchMux 的正式执行链路字段为：

- `executionChannel`

目前仅正式使用：

- `tmux_local_tui`

保留给未来 bridge / remote-mode 的值为：

- `app_server_remote_tui`

这两个值不能混用。特别是：

- `tmux_local_tui` 下的 `currentCodexSessionId`
  - 当前仍来自 rollout / observer 对本地 TUI 会话的匹配与绑定
- `app_server_remote_tui` 下的 thread id
  - 未来应来自 app-server 官方协议

在真正切到 remote-mode 之前，不能把 app-server 创建出的 thread id 直接覆盖本地 tmux 会话的 `currentCodexSessionId`。

当前为 bridge 实验额外提供：

- `POST /api/session/:id/app-server-bridge-probe`

该接口的语义是：

- 对当前 `tmux_local_tui` 会话做一次平行的 app-server thread/start 探针
- 返回实验 thread id、thread/read 对照信息
- 明确验证这次实验不会污染当前会话的 `currentCodexSessionId`

它不是正式执行链路，也不代表当前会话已经切到 app-server-backed TUI。

## tmux 会话环境

当前 TouchMux 启动 tmux 本地会话时，环境语义已经收紧为：

- 保留服务进程自己的 `HOME`
- 显式注入 `TOUCHMUX_SESSION_HOME`
- 显式注入 `CODEX_HOME=<TOUCHMUX_SESSION_HOME>/.codex`

这意味着：

- 用户自己的 shell / git / ssh / dotfiles 继续跟随真实 `HOME`
- Codex 的登录态、history、sessions 仍然可以被 TouchMux 单独隔离和扫描
- `TOUCHMUX_SESSION_HOME` 不再等价于“整个 shell 的 HOME”

## Goal Guard V1 协议化结果字段

当前会话详情、会话列表和 Goal Guard debug 输出中，已经开始补充以下字段：

- `currentTaskRunId`
  - 当前守卫任务实例 id
  - 每次重新启用或重置守卫后会生成新的 id
- `goalSpec`
  - 当前守卫如何描述“本轮目标”
  - 当前第一版固定为 `terminal_signal`
- `verificationSpec`
  - 当前守卫如何做最终验收
  - 当前第一版支持：
    - `command_check`
    - `candidate_signal`
    - `file_exists`
    - `file_contains`
    - `json_field_equals`
  - 其中还会额外带 `strict`
    - `true` 表示当前 verifier 可作为严格最终验收
    - `false` 表示当前只是兼容候选信号，不能自动确认最终成功
- `verificationReceipt`
  - 当前守卫最近一次结构化验收回执
  - schema 固定为：
    - `touchmux.goal_guard.result.v1`

其中 `verificationReceipt` 当前至少包含：

- `taskRunId`
- `sessionId`
- `status`
- `verificationKind`
- `passed`
- `detail`
- `exitCode`
- `evidenceEventSeq`
- `createdAt`

当前语义已经收紧为：

- terminal / Codex assistant / standalone `SUCCESS` 只负责触发“候选完成”
- 最终成功与否，必须落成一份结构化 `verificationReceipt`
- 若 `verificationSpec.kind = command_check`
  - 只有命令校验通过，才会进入最终成功
- 若 `verificationSpec.kind = candidate_signal`
  - 当前仍保留兼容模式，用于没有命令校验的旧配置
  - 但它已经不会再自动确认最终成功
  - 当前会进入“缺少严格验收”的阻塞态，要求补充严格 verifier
- 若 `verificationSpec.kind = file_exists`
  - `successCommand` 写法：`file_exists:相对路径`
  - 只有当前会话 cwd 下对应文件存在，才会进入最终成功
- 若 `verificationSpec.kind = file_contains`
  - `successCommand` 写法：`file_contains:路径::文本`
  - 只有目标文件存在且内容包含指定文本，才会进入最终成功
- 若 `verificationSpec.kind = json_field_equals`
  - `successCommand` 写法：`json_equals:路径::字段.path::JSON值`
  - 只有目标 JSON 文件字段值与给定 JSON 值严格相等，才会进入最终成功

## 当前真实数据流边界

最近一轮基于真实 Codex 的 smoke 已确认：

- `codex exec` 产生的真实 rollout 文件
  - 当前已经可以被 `CodexObserver` 命中
  - 也已经能驱动 Goal Guard 的真实 E2E 验收
- `codex app-server` 的真实 live turn
  - 当前已经可以真实发起并完成
  - 当前已经新增 app-server observer，可通过 `thread/read(includeTurns=true)` 驱动 Goal Guard E2E
  - 但这条路径有两个必须写死的边界：
    - 只有 `non-ephemeral thread` 才支持 `includeTurns=true`
    - `thread/read` 的 turn 视图与实时 notification 并不完全等价，尤其在系统错误场景下必须同时参考 `thread.status`

这意味着：

- Goal Guard 现在已经不只是“纯 mock 自测”
- 当前已经同时具备两条真实观测链：
  - `CLI rollout -> CodexObserver`
  - `app-server thread/read(includeTurns=true) -> CodexAppServerObserver`
- 但它仍然不能被表述成“100% 准确”
  - 因为 app-server 的 detached observer 目前无法像 live notification 一样总能拿到完整错误细节
  - 所以后续如果要继续提高失败态精度，仍然建议补长期通知桥接，而不是回到关键词补丁

最近几轮落地后，这段边界需要进一步更新为：

- `app-server thread/read(includeTurns=true)` 现在已经不再只是 detached observer 临时现拉
  - 后台 `CodexAppServerThreadManager` 会周期维护 thread snapshot
- `app-server notification` 也不再只是“谁刚好连接上就收到”
  - 后台 `CodexAppServerNotificationManager` 会在存在活跃 `app_server_remote_tui` 线程时保持常驻连接
- Goal Guard debug 当前已对外暴露：
  - `appServerNotificationManagerSummary`
  - `appServerNotificationSummary`
  - `appServerThreadManagerSummary`
  - `codexObservation.appServerTurnStateSource`
  - `appServerDebugSummary`

其中 `appServerDebugSummary` 当前是 app-server 结构化事实的统一调试摘要，至少包含：

- `enabled`
- `matchedThreadId`
- `finalTurnState`
- `finalTurnStateSource`
- `fatalError`
- `notificationManager`
- `notificationCache`
- `threadManager`

这意味着当前最准确的 API/事件层表述是：

- Goal Guard 主判定已经进入“结构化事实 + verifier receipt”模式
- app-server 路径已经具备后台维护的 snapshot 与 notification 双事实层
- 但它仍然不能被表述成“100% 绝对准确”
  - 当前 notification manager 仍是最小后台常驻版
  - 还未做到 per-thread 级别的完整长期健康追踪
