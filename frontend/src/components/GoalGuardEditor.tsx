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
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setForm(session?.goalConfig ?? null);
  }, [session]);

  useEffect(() => {
    setExpanded(false);
  }, [session?.id]);

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
          <div className="session-meta">当前状态：{session.goalState}</div>
        </div>
        <button type="button" className="ghost-button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起配置" : "展开配置"}
        </button>
      </div>
      {!expanded ? null : (
        <div className="goal-panel-body">
          <label className="toggle-row">
            <span>启用目标守卫</span>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
          </label>
          <label>
            目标说明
            <textarea
              rows={3}
              value={form.goalText}
              onChange={(event) => setForm({ ...form, goalText: event.target.value })}
              placeholder="描述 Codex 本次必须完成的目标"
            />
          </label>
          <label>
            成功关键词
            <input
              value={form.successKeywords.join(",")}
              onChange={(event) =>
                setForm({
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
                setForm({
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
                  setForm({
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
                  setForm({
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
                setForm({
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
              void updateGoalGuard(token, session.id, form)
                .then((updated) => onUpdated(updated))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "保存中..." : "保存 Goal Guard"}
          </button>
        </div>
      )}
    </section>
  );
}
