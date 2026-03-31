import { useEffect, useState } from "react";
import { updateGoalGuard } from "../lib/api";
import type { GoalGuardConfig, SessionSummary } from "../types/api";

interface GoalGuardEditorProps {
  token: string;
  session: SessionSummary | null;
  onUpdated: (session: SessionSummary) => void;
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
            当前状态：{session.goalState} · {form.enabled ? "已启用" : "未启用"}
          </div>
        </div>
        <button type="button" className="ghost-button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "展开"}
        </button>
      </div>
      {!expanded ? null : (
        <div className="goal-panel-body">
          <div className="session-meta">
            这里直接填写目标说明并保存即可开始生效；编辑中的内容不会再被后台自动刷新覆盖。
          </div>
          <label className="toggle-row">
            <span>启用目标守卫</span>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => updateForm({ ...form, enabled: event.target.checked })}
            />
          </label>
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
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              setSavedNotice(null);
              void updateGoalGuard(token, session.nodeId, session.id, form)
                .then((updated) => {
                  onUpdated(updated);
                  setForm(updated.goalConfig);
                  setDirty(false);
                  setSavedNotice("Goal Guard 已保存。");
                })
                .catch((saveError) => {
                  setError(saveError instanceof Error ? saveError.message : "Goal Guard 保存失败");
                })
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "保存中..." : "保存 Goal Guard"}
          </button>
          {dirty ? <div className="session-meta">你有未保存的修改。</div> : null}
          {error ? <div className="error-banner inline-banner">{error}</div> : null}
          {savedNotice ? <div className="success-banner inline-banner">{savedNotice}</div> : null}
        </div>
      )}
    </section>
  );
}
