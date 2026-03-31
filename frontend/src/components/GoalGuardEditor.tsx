import { useEffect, useState } from "react";
import { updateGoalGuard } from "../lib/api";
import type { GoalGuardConfig, SessionSummary } from "../types/api";

interface GoalGuardEditorProps {
  token: string;
  session: SessionSummary | null;
  onUpdated: (session: SessionSummary) => void;
}

function goalStateLabel(goalState: SessionSummary["goalState"]): string {
  switch (goalState) {
    case "disabled":
      return "未启动";
    case "idle_waiting":
      return "等待守卫中";
    case "running":
      return "检测到输出";
    case "auto_resuming":
      return "自动续跑中";
    case "goal_satisfied":
      return "目标已达成";
    case "manual_override_stopped":
      return "已手动停止";
    case "failed_check":
      return "校验未通过";
    default:
      return goalState;
  }
}

function goalStateHint(goalState: SessionSummary["goalState"]): string {
  switch (goalState) {
    case "disabled":
      return "当前只保存规则，不会自动向终端发送任何内容。";
    case "idle_waiting":
      return "守卫已启动，但还在等待空闲阈值或新的终端输出。";
    case "running":
      return "后台已经从 tmux 捕获到新的终端输出，说明会话正在推进。";
    case "auto_resuming":
      return "守卫刚刚向终端发送了续跑提示，等待 Codex 继续执行。";
    case "goal_satisfied":
      return "成功条件已经命中，当前守卫不再续跑。";
    case "manual_override_stopped":
      return "守卫或会话已经被手动强制停止。";
    case "failed_check":
      return "命中了成功关键词，但命令校验没有通过。";
    default:
      return "当前状态未知，请重新刷新页面确认。";
  }
}

export function GoalGuardEditor({ token, session, onUpdated }: GoalGuardEditorProps) {
  const [form, setForm] = useState<GoalGuardConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const sessionId = session?.id ?? null;
  const goalConfigFingerprint = session ? JSON.stringify(session.goalConfig) : null;

  useEffect(() => {
    setForm(session?.goalConfig ?? null);
    setDirty(false);
    setError(null);
    setSavedNotice(null);
    setExpanded(true);
  }, [sessionId]);

  useEffect(() => {
    if (!dirty) {
      setForm(session?.goalConfig ?? null);
    }
  }, [goalConfigFingerprint, dirty, session]);

  function updateForm(next: GoalGuardConfig): void {
    setForm(next);
    setDirty(true);
    setSavedNotice(null);
  }

  function submitGoalGuard(nextEnabled: boolean | null, successMessage: string): void {
    if (!session || !form) {
      return;
    }
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    void updateGoalGuard(token, session.nodeId, session.id, {
      ...form,
      enabled: nextEnabled ?? session.goalConfig.enabled,
    })
      .then((updated) => {
        onUpdated(updated);
        setForm(updated.goalConfig);
        setDirty(false);
        setSavedNotice(successMessage);
      })
      .catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : "Goal Guard 操作失败");
      })
      .finally(() => setSaving(false));
  }

  if (!session || !form) {
    return (
      <section className="panel goal-panel goal-panel-empty">
        <div className="drawer-section-header">
          <div>
            <div className="eyebrow">Goal Guard</div>
            <h2>目标守卫</h2>
          </div>
        </div>
        <div className="session-meta">先选择一个终端，随后才能设置自动续跑和完成判定规则。</div>
      </section>
    );
  }

  return (
    <section className="panel goal-panel">
      <div className="drawer-section-header">
        <div>
          <div className="eyebrow">Goal Guard</div>
          <h2>目标守卫</h2>
          <div className="session-meta">
            当前状态：{goalStateLabel(session.goalState)} · {session.goalConfig.enabled ? "守卫已启动" : "仅保存配置"}
          </div>
        </div>
        <button type="button" className="ghost-button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "展开"}
        </button>
      </div>
      {!expanded ? null : (
        <div className="goal-panel-body">
          <div className="goal-guard-state-card">
            <strong>{goalStateLabel(session.goalState)}</strong>
            <span>{goalStateHint(session.goalState)}</span>
          </div>
          <div className="session-meta">
            保存配置不会自动启动守卫。只有点击“启动守卫”后，后台才会开始监控空闲并自动续跑。
          </div>
          <label>
            目标说明
            <textarea
              rows={3}
              value={form.goalText}
              onChange={(event) => updateForm({ ...form, goalText: event.target.value })}
              placeholder="描述 Codex 本次必须完成的目标"
            />
          </label>
          <label>
            成功关键词
            <input
              value={form.successKeywords.join(",")}
              onChange={(event) =>
                updateForm({
                  ...form,
                  successKeywords: event.target.value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
              placeholder="SUCCESS, done, fixed"
            />
          </label>
          <label>
            命令校验
            <input
              value={form.successCommand ?? ""}
              onChange={(event) =>
                updateForm({
                  ...form,
                  successCommand: event.target.value || null,
                })
              }
              placeholder="比如：npm run build"
            />
          </label>
          <div className="inline-grid">
            <label>
              空闲阈值（秒）
              <input
                type="number"
                min={15}
                value={form.idleTimeoutSec}
                onChange={(event) =>
                  updateForm({
                    ...form,
                    idleTimeoutSec: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="toggle-row">
              <span>达标后允许普通停止</span>
              <input
                type="checkbox"
                checked={form.allowManualStopAfterSuccess}
                onChange={(event) =>
                  updateForm({
                    ...form,
                    allowManualStopAfterSuccess: event.target.checked,
                  })
                }
              />
            </label>
          </div>
          <label>
            自动续跑提示
            <textarea
              rows={4}
              value={form.resumePromptTemplate}
              onChange={(event) =>
                updateForm({
                  ...form,
                  resumePromptTemplate: event.target.value,
                })
              }
            />
          </label>
          <div className="goal-guard-actions">
            <button type="button" disabled={saving} onClick={() => submitGoalGuard(null, "Goal Guard 配置已保存。")}>
              {saving ? "处理中..." : "保存配置"}
            </button>
            <button
              type="button"
              disabled={saving || session.goalConfig.enabled}
              onClick={() => submitGoalGuard(true, "Goal Guard 已启动，接下来会按空闲阈值接管续跑。")}
            >
              启动守卫
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={saving || !session.goalConfig.enabled}
              onClick={() => submitGoalGuard(false, "Goal Guard 已停止，当前只保留配置不再自动续跑。")}
            >
              停止守卫
            </button>
          </div>
          {dirty ? <div className="session-meta">你有未保存的修改。</div> : null}
          {error ? <div className="error-banner inline-banner">{error}</div> : null}
          {savedNotice ? <div className="success-banner inline-banner">{savedNotice}</div> : null}
        </div>
      )}
    </section>
  );
}
