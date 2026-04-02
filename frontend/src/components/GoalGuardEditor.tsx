import { useEffect, useState } from "react";
import { fetchGoalGuardDebug, fetchSessionDetail, updateGoalGuard } from "../lib/api";
import type { GoalGuardConfig, GoalGuardDebugInfo, SessionSummary } from "../types/api";

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
      return "检测到新输出";
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
      return "守卫启用后已检测到新的终端输出，但只有满足首检或空闲阈值后才会自动续跑。";
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
  const [debugLoading, setDebugLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<GoalGuardDebugInfo | null>(null);
  const sessionId = session?.id ?? null;
  const goalConfigFingerprint = session ? JSON.stringify(session.goalConfig) : null;
  const effectiveGoalState = debugInfo?.sessionId === sessionId ? debugInfo.goalState : session?.goalState ?? "disabled";

  useEffect(() => {
    setForm(session?.goalConfig ?? null);
    setDirty(false);
    setError(null);
    setSavedNotice(null);
    setDebugInfo(null);
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

  function formatTimestamp(timestamp: number | null): string {
    if (!timestamp) {
      return "无";
    }
    return new Date(timestamp).toLocaleString("zh-CN", {
      hour12: false,
    });
  }

  function loadDebugInfo(): void {
    if (!session) {
      return;
    }
    setDebugLoading(true);
    setError(null);
    void Promise.all([fetchGoalGuardDebug(token, session.id), fetchSessionDetail(token, session.id)])
      .then(([nextDebugInfo, nextSession]) => {
        setDebugInfo(nextDebugInfo);
        onUpdated(nextSession);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "读取守卫调试信息失败");
      })
      .finally(() => setDebugLoading(false));
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
            当前状态：{goalStateLabel(effectiveGoalState)} · {session.goalConfig.enabled ? "守卫已启动" : "仅保存配置"}
          </div>
        </div>
        <button type="button" className="ghost-button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "展开"}
        </button>
      </div>
      {!expanded ? null : (
        <div className="goal-panel-body">
          <div className="goal-guard-state-card">
            <strong>{goalStateLabel(effectiveGoalState)}</strong>
            <span>{goalStateHint(effectiveGoalState)}</span>
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
          {form.successKeywords.length === 0 && !(form.successCommand ?? "").trim() ? (
            <div className="session-meta">
              当前没有配置完成判定规则。守卫可以继续自动续跑，但不会自动显示“目标已达成”。
            </div>
          ) : null}
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
            <button type="button" className="ghost-button" disabled={debugLoading} onClick={loadDebugInfo}>
              {debugLoading ? "读取中..." : "查看调试快照"}
            </button>
          </div>
          {debugInfo ? (
            <div className="goal-debug-panel">
              <div className="goal-debug-grid">
                <div>守卫启用：{debugInfo.guardEnabled ? "是" : "否"}</div>
                <div>当前状态：{goalStateLabel(debugInfo.goalState)}</div>
                <div>tmux 存在：{debugInfo.hasTmuxSession ? "是" : "否"}</div>
                <div>自动续跑次数：{debugInfo.autoResumeCount}</div>
                <div>最近输出时间：{formatTimestamp(debugInfo.lastOutputAt)}</div>
                <div>最近自动续跑：{formatTimestamp(debugInfo.lastAutoResumeAt)}</div>
                <div>最近视口活动：{formatTimestamp(debugInfo.lastViewerActivityAt)}</div>
                <div>快照是否变化：{debugInfo.snapshotChanged ? "是" : "否"}</div>
                <div>命中 SUCCESS 单行：{debugInfo.matchedStandaloneSuccess ? "是" : "否"}</div>
                <div>命中成功关键词：{debugInfo.matchedSuccessKeyword ?? "无"}</div>
                <div>未完成信号：{debugInfo.matchedIncompleteSignals.join("、") || "无"}</div>
              </div>
              <div className="session-meta">
                下面展示的是守卫启动时记录的基线 pane 快照，以及当前 pane 快照的末尾对比。若这里只改了时间、spinner、状态字，你就能直接看出来。
              </div>
              <label>
                基线快照末尾
                <textarea rows={8} value={debugInfo.baselineTailLines.join("\n")} readOnly />
              </label>
              <label>
                当前快照末尾
                <textarea rows={8} value={debugInfo.currentTailLines.join("\n")} readOnly />
              </label>
              <label>
                差异行
                <textarea
                  rows={8}
                  value={
                    debugInfo.changedTailLines.length > 0
                      ? debugInfo.changedTailLines
                          .map(
                            (entry) =>
                              `#${entry.line}\nBASE: ${entry.baseline || "<empty>"}\nCURR: ${entry.current || "<empty>"}`,
                          )
                          .join("\n\n")
                      : "没有发现末尾行差异"
                  }
                  readOnly
                />
              </label>
              <label>
                守卫判定输出窗口末尾
                <textarea rows={10} value={debugInfo.goalWindowTailLines.join("\n")} readOnly />
              </label>
              <label>
                清洗后的判定窗口末尾
                <textarea rows={10} value={debugInfo.sanitizedGoalWindowTailLines.join("\n")} readOnly />
              </label>
            </div>
          ) : null}
          {dirty ? <div className="session-meta">你有未保存的修改。</div> : null}
          {error ? <div className="error-banner inline-banner">{error}</div> : null}
          {savedNotice ? <div className="success-banner inline-banner">{savedNotice}</div> : null}
        </div>
      )}
    </section>
  );
}
