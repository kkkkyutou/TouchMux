# Goal Guard 说明

Goal Guard 用于限制会话在目标未达成前停止。

## 当前规则

- `enabled`
- `goalText`
- `successKeywords`
- `successCommand`
- `idleTimeoutSec`
- `resumePromptTemplate`
- `allowManualStopAfterSuccess`

## 判定逻辑

1. 先检查最近输出中是否命中成功关键词。
2. 如果配置了命令校验，则在会话目录执行该命令。
3. 只有关键词和命令校验都通过，才记为 `goal_satisfied`。

## 自动续跑

- 会话长时间无输出时，后台定时器会检查目标是否达成。
- 未达成则自动向 tmux 注入续跑提示。
- 前端普通关闭会受 goal guard 限制。
- 仍保留强制停止接口，但会记录审计日志。
