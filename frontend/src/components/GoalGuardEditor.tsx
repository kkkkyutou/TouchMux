import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteGoalGuardTemplate,
  fetchGoalGuardDebug,
  fetchGoalGuardTemplates,
  fetchSessionDetail,
  saveGoalGuardTemplate,
  setDefaultGoalGuardTemplate,
  updateGoalGuard,
} from "../lib/api";
import type {
  GoalGuardConfig,
  GoalGuardDebugInfo,
  GoalGuardProgressSignal,
  GoalGuardStructuredFactSource,
  GoalGuardTemplate,
  GuardDecisionState,
  SessionSummary,
} from "../types/api";

interface GoalGuardEditorProps {
  token: string;
  session: SessionSummary | null;
  onUpdated: (session: SessionSummary) => void;
}

const RESUME_PROMPT_TEMPLATE_STORAGE_KEY = "touchmux-goal-guard-resume-templates-v1";

const defaultResumePromptTemplates: GoalGuardTemplate[] = [
  {
    id: "default-guard-continue",
    name: "标准续跑",
    content: "当前目标：{{goal_text}}\n继续执行既定目标，未完成前不要停止。完成后输出以下成功信号之一：{{success_signal}}。",
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-guard-brief",
    name: "简洁推进",
    content: "继续推进当前目标，不要停在分析或说明。真正完成后输出以下成功信号之一：{{success_signal}}。",
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

function loadResumePromptTemplates(): GoalGuardTemplate[] {
  if (typeof window === "undefined") {
    return defaultResumePromptTemplates;
  }
  try {
    const raw = window.localStorage.getItem(RESUME_PROMPT_TEMPLATE_STORAGE_KEY);
    if (!raw) {
      return defaultResumePromptTemplates;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return defaultResumePromptTemplates;
    }
    const restored = parsed
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : null;
        const name = typeof record.name === "string" ? record.name : null;
        const content = typeof record.content === "string" ? record.content : null;
        if (!id || !name || !content) {
          return null;
        }
        return {
          id,
          name,
          content,
          isDefault: record.isDefault === true,
          createdAt: 0,
          updatedAt: 0,
        } satisfies GoalGuardTemplate;
      })
      .filter((item): item is GoalGuardTemplate => Boolean(item));
    if (restored.length === 0) {
      return defaultResumePromptTemplates;
    }
    return restored;
  } catch {
    return defaultResumePromptTemplates;
  }
}

function persistResumePromptTemplates(templates: GoalGuardTemplate[]): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(RESUME_PROMPT_TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function createTemplateId(): string {
  return `template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderResumePromptTemplate(template: string, form: GoalGuardConfig): string {
  const successKeyword = form.successKeywords[0]?.trim() || "SUCCESS";
  const successKeywords = form.successKeywords.join(", ");
  const goalText = form.goalText.trim();
  return template
    .replaceAll("{{success_signal}}", successKeywords)
    .replaceAll("{{success_keyword}}", successKeyword)
    .replaceAll("{{success_keywords}}", successKeywords)
    .replaceAll("{{goal_text}}", goalText);
}

const resumePromptVariables = [
  { token: "{{success_signal}}", label: "成功信号" },
  { token: "{{goal_text}}", label: "目标说明" },
];

function guardDecisionStateLabel(guardDecisionState: GuardDecisionState): string {
  switch (guardDecisionState) {
    case "disabled":
      return "未启动";
    case "waiting_for_idle":
      return "等待守卫中";
    case "observing_output":
      return "检测到新输出";
    case "observing_codex_turn":
      return "Codex 正在执行";
    case "verifying":
      return "正在验收";
    case "resuming":
      return "自动续跑中";
    case "satisfied":
      return "目标已达成";
    case "manually_overridden":
      return "已手动停止";
    case "verification_failed":
      return "校验未通过，继续等待";
    case "blocked_by_missing_verifier":
      return "缺少严格验收";
    case "blocked_by_fatal_error":
      return "检测到阻塞错误";
    default:
      return guardDecisionState;
  }
}

function guardDecisionStateHint(guardDecisionState: GuardDecisionState): string {
  switch (guardDecisionState) {
    case "disabled":
      return "当前只保存规则，不会自动向终端发送任何内容。";
    case "waiting_for_idle":
      return "守卫已启动，但还在等待空闲阈值或新的终端输出。";
    case "observing_output":
      return "守卫已经观测到 checkpoint 之后的新输出，但这不等于已经完成目标。";
    case "observing_codex_turn":
      return "守卫从 Codex 结构化事件确认当前 turn 仍在执行，因此不会过早自动续跑。";
    case "verifying":
      return "守卫已检测到候选完成信号，正在执行 verifier，并等待结构化回执。";
    case "resuming":
      return "守卫刚刚向终端发送了续跑提示，等待 Codex 继续执行。";
    case "satisfied":
      return "成功证据已经确认，当前守卫不再续跑，也不会再回退成等待态。";
    case "manually_overridden":
      return "守卫或会话已经被手动强制停止。";
    case "verification_failed":
      return "守卫曾检测到候选成功信号，但命令校验未通过，当前会继续等待后续输出。";
    case "blocked_by_missing_verifier":
      return "守卫已经看到候选完成信号，但由于没有配置严格 verifier，系统拒绝自动确认成功。";
    case "blocked_by_fatal_error":
      return "守卫检测到了明确的阻塞错误，当前不会继续自动续跑。";
    default:
      return "当前状态未知，请重新刷新页面确认。";
  }
}

function progressSignalLabel(signal: GoalGuardProgressSignal): string {
  switch (signal) {
    case "structured_codex":
      return "结构化 Codex 事件";
    case "terminal_fallback":
      return "终端 fallback 信号";
    case "none":
      return "暂无明确进展信号";
    default:
      return signal;
  }
}

function progressSignalHint(signal: GoalGuardProgressSignal, terminalSignalsAllowed: boolean): string {
  switch (signal) {
    case "structured_codex":
      return "当前以结构化 Codex 事件为主依据，terminal 文本只作为辅助线索。";
    case "terminal_fallback":
      return terminalSignalsAllowed
        ? "当前结构化观测不可用，守卫退回到 terminal fallback 信号。"
        : "当前没有启用 terminal 主判定，terminal 文本不会推动主状态机。";
    case "none":
      return "当前没有检测到明确进展信号，系统会继续等待或按空闲策略续跑。";
    default:
      return "当前进展信号来源未知。";
  }
}

function structuredFactSourceLabel(source: GoalGuardStructuredFactSource): string {
  switch (source) {
    case "rollout_observer":
      return "CLI rollout observer";
    case "app_server_thread_read":
      return "app-server thread/read";
    case "app_server_notification_cache":
      return "app-server notification cache";
    case "none":
      return "暂无结构化事实源";
    default:
      return source;
  }
}

function appServerTurnStateSourceLabel(source: string | null): string {
  switch (source) {
    case "notification_cache":
      return "notification cache";
    case "thread_read":
      return "thread/read";
    case "failed_conflict":
      return "失败态冲突收口";
    case null:
      return "无";
    default:
      return source;
  }
}

function managerSyncLabel(lastSyncOk: boolean, lastSyncedAt: number | null): string {
  if (lastSyncedAt === null) {
    return "尚未同步";
  }
  return lastSyncOk ? "最近同步成功" : "最近同步失败";
}

export function GoalGuardEditor({ token, session, onUpdated }: GoalGuardEditorProps) {
  const [form, setForm] = useState<GoalGuardConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<GoalGuardDebugInfo | null>(null);
  const [resumePromptDraft, setResumePromptDraft] = useState("");
  const [resumePromptTemplates, setResumePromptTemplates] = useState<GoalGuardTemplate[]>(() => loadResumePromptTemplates());
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const [templatePanelExpanded, setTemplatePanelExpanded] = useState(false);
  const resumePromptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionId = session?.id ?? null;
  const goalConfigFingerprint = session ? JSON.stringify(session.goalConfig) : null;
  const effectiveGuardDecisionState =
    debugInfo?.sessionId === sessionId ? debugInfo.guardDecisionState : session?.guardDecisionState ?? "disabled";
  const effectiveGuardDecisionReason =
    debugInfo?.sessionId === sessionId ? debugInfo.guardDecisionReason : session?.guardDecisionReason ?? null;
  const renderedResumePrompt = useMemo(
    () => (form ? renderResumePromptTemplate(resumePromptDraft, form) : ""),
    [form, resumePromptDraft],
  );
  const defaultTemplate = useMemo(
    () => resumePromptTemplates.find((template) => template.isDefault) ?? null,
    [resumePromptTemplates],
  );
  const filteredTemplates = useMemo(() => {
    const keyword = templateSearch.trim().toLowerCase();
    if (!keyword) {
      return resumePromptTemplates;
    }
    return resumePromptTemplates.filter((template) =>
      template.name.toLowerCase().includes(keyword) || template.content.toLowerCase().includes(keyword),
    );
  }, [resumePromptTemplates, templateSearch]);

  useEffect(() => {
    setForm(session?.goalConfig ?? null);
    setResumePromptDraft(session?.goalConfig.resumePromptTemplate ?? "");
    setDirty(false);
    setError(null);
    setSavedNotice(null);
    setDebugInfo(null);
    setExpanded(true);
    setSelectedTemplateId("");
    setTemplateNameDraft("");
    setTemplateSearch("");
    setTemplatePanelExpanded(false);
  }, [sessionId]);

  useEffect(() => {
    if (!dirty) {
      setForm(session?.goalConfig ?? null);
    }
  }, [goalConfigFingerprint, dirty, session]);

  useEffect(() => {
    if (dirty || !defaultTemplate) {
      return;
    }
    setResumePromptDraft((current) => {
      if (current.trim().length > 0) {
        return current;
      }
      return defaultTemplate.content;
    });
  }, [defaultTemplate, dirty]);

  useEffect(() => {
    if (!token || !session?.nodeId) {
      return;
    }
    let cancelled = false;
    setTemplateLoading(true);
    void fetchGoalGuardTemplates(token, session.nodeId)
      .then(async (serverTemplates) => {
        if (cancelled) {
          return;
        }
        const localTemplates = loadResumePromptTemplates();
        if (serverTemplates.length === 0 && localTemplates.length > 0) {
          const uploaded: GoalGuardTemplate[] = [];
          for (const template of localTemplates) {
            const saved = await saveGoalGuardTemplate(token, session.nodeId, {
              id: template.id,
              name: template.name,
              content: template.content,
            });
            uploaded.push(saved);
          }
          if (!cancelled) {
            setResumePromptTemplates(uploaded);
            persistResumePromptTemplates(uploaded);
          }
          return;
        }
        setResumePromptTemplates(serverTemplates.length > 0 ? serverTemplates : localTemplates);
        persistResumePromptTemplates(serverTemplates.length > 0 ? serverTemplates : localTemplates);
      })
      .catch(() => {
        if (!cancelled) {
          setResumePromptTemplates(loadResumePromptTemplates());
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTemplateLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, session?.nodeId]);

  function updateForm(next: GoalGuardConfig): void {
    setForm(next);
    setDirty(true);
    setSavedNotice(null);
  }

  function saveCurrentDraftAsTemplate(): void {
    persistCurrentDraftAsTemplate("upsert_by_name");
  }

  function saveCurrentDraftAsNewTemplate(): void {
    persistCurrentDraftAsTemplate("always_create");
  }

  function updateSelectedTemplate(): void {
    if (!selectedTemplateId) {
      setError("请先选择一个模板。");
      return;
    }
    persistCurrentDraftAsTemplate("update_selected");
  }

  function persistCurrentDraftAsTemplate(mode: "upsert_by_name" | "always_create" | "update_selected"): void {
    const name = templateNameDraft.trim();
    const content = resumePromptDraft.trim();
    if (!name) {
      setError("请先输入模板名称。");
      return;
    }
    if (!content) {
      setError("当前模板内容为空，无法保存。");
      return;
    }
    const existing = resumePromptTemplates.find((template) => template.name === name);
    if (!session) {
      return;
    }
    const selectedTemplate = selectedTemplateId
      ? resumePromptTemplates.find((template) => template.id === selectedTemplateId) ?? null
      : null;
    void saveGoalGuardTemplate(token, session.nodeId, {
      id:
        mode === "update_selected"
          ? (selectedTemplate?.id ?? null)
          : mode === "always_create"
            ? createTemplateId()
            : (existing?.id ?? createTemplateId()),
      name,
      content,
    })
      .then((saved) => {
        const hasExistingId = resumePromptTemplates.some((template) => template.id === saved.id);
        const nextTemplates = hasExistingId
          ? resumePromptTemplates.map((template) => (template.id === saved.id ? saved : template))
          : [saved, ...resumePromptTemplates];
        setResumePromptTemplates(nextTemplates);
        persistResumePromptTemplates(nextTemplates);
        setSelectedTemplateId(saved.id);
        setSavedNotice(
          mode === "update_selected"
            ? "当前模板已更新。"
            : hasExistingId
              ? "模板已覆盖保存。"
              : "模板已保存。",
        );
        setError(null);
      })
      .catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : "模板保存失败");
      });
  }

  function applySelectedTemplate(templateId: string): void {
    const selectedTemplate = resumePromptTemplates.find((template) => template.id === templateId);
    if (!selectedTemplate) {
      return;
    }
    setSelectedTemplateId(templateId);
    setTemplateNameDraft(selectedTemplate.name);
    setResumePromptDraft(selectedTemplate.content);
    setDirty(true);
    setSavedNotice(null);
    setError(null);
  }

  function deleteSelectedTemplate(): void {
    if (!selectedTemplateId || !session) {
      setError("请先选择一个模板。");
      return;
    }
    void deleteGoalGuardTemplate(token, session.nodeId, selectedTemplateId)
      .then(() => {
        const nextTemplates = resumePromptTemplates.filter((template) => template.id !== selectedTemplateId);
        setResumePromptTemplates(nextTemplates);
        persistResumePromptTemplates(nextTemplates);
        setSelectedTemplateId("");
        setTemplateNameDraft("");
        setSavedNotice("模板已删除。");
        setError(null);
      })
      .catch((deleteError) => {
        setError(deleteError instanceof Error ? deleteError.message : "模板删除失败");
      });
  }

  function setSelectedTemplateAsDefault(): void {
    if (!selectedTemplateId || !session) {
      setError("请先选择一个模板。");
      return;
    }
    void setDefaultGoalGuardTemplate(token, session.nodeId, selectedTemplateId)
      .then((updatedTemplate) => {
        const nextTemplates = resumePromptTemplates.map((template) => ({
          ...template,
          isDefault: template.id === updatedTemplate.id,
          updatedAt: template.id === updatedTemplate.id ? updatedTemplate.updatedAt : template.updatedAt,
        }));
        setResumePromptTemplates(nextTemplates);
        persistResumePromptTemplates(nextTemplates);
        setSavedNotice("默认模板已更新。");
        setError(null);
      })
      .catch((updateError) => {
        setError(updateError instanceof Error ? updateError.message : "默认模板设置失败");
      });
  }

  function appendTemplateVariable(tokenText: string): void {
    const textarea = resumePromptTextareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart ?? resumePromptDraft.length;
      const end = textarea.selectionEnd ?? resumePromptDraft.length;
      const nextValue = `${resumePromptDraft.slice(0, start)}${tokenText}${resumePromptDraft.slice(end)}`;
      setResumePromptDraft(nextValue);
      window.requestAnimationFrame(() => {
        const cursor = start + tokenText.length;
        textarea.focus();
        textarea.setSelectionRange(cursor, cursor);
      });
    } else {
      setResumePromptDraft((current) => {
        const suffix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
        return `${current}${suffix}${tokenText}`;
      });
    }
    setDirty(true);
    setSavedNotice(null);
    setError(null);
  }

  function restoreBuiltInTemplates(): void {
    if (!session) {
      return;
    }
    setTemplateLoading(true);
    void Promise.all(
      defaultResumePromptTemplates.map((template) =>
        saveGoalGuardTemplate(token, session.nodeId, {
          id: template.id,
          name: template.name,
          content: template.content,
        }),
      ),
    )
      .then(async (savedTemplates) => {
        const defaultSaved = savedTemplates.find((template) => template.id === defaultResumePromptTemplates[0].id) ?? savedTemplates[0] ?? null;
        const normalizedTemplates = resumePromptTemplates.filter(
          (template) => !defaultResumePromptTemplates.some((builtin) => builtin.id === template.id),
        );
        const nextTemplates = [...savedTemplates, ...normalizedTemplates];
        if (defaultSaved) {
          const updatedDefault = await setDefaultGoalGuardTemplate(token, session.nodeId, defaultSaved.id);
          const finalTemplates = nextTemplates.map((template) => ({
            ...template,
            isDefault: template.id === updatedDefault.id,
            updatedAt: template.id === updatedDefault.id ? updatedDefault.updatedAt : template.updatedAt,
          }));
          setResumePromptTemplates(finalTemplates);
          persistResumePromptTemplates(finalTemplates);
        } else {
          setResumePromptTemplates(nextTemplates);
          persistResumePromptTemplates(nextTemplates);
        }
        setSelectedTemplateId(defaultResumePromptTemplates[0].id);
        setTemplateNameDraft(defaultResumePromptTemplates[0].name);
        setSavedNotice("官方默认模板已恢复。");
        setError(null);
      })
      .catch((restoreError) => {
        setError(restoreError instanceof Error ? restoreError.message : "恢复官方默认模板失败");
      })
      .finally(() => {
        setTemplateLoading(false);
      });
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
      resumePromptTemplate: renderedResumePrompt,
      enabled: nextEnabled ?? session.goalConfig.enabled,
    })
      .then((updated) => {
        onUpdated(updated);
        setForm(updated.goalConfig);
        setResumePromptDraft((current) => current || updated.goalConfig.resumePromptTemplate);
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

  const goalWarmupRemainingSec =
    debugInfo?.goalActivatedAt
      ? Math.max(0, Math.ceil((7000 - (Date.now() - debugInfo.goalActivatedAt)) / 1000))
      : 0;

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
            当前状态：{guardDecisionStateLabel(effectiveGuardDecisionState)} · {session.goalConfig.enabled ? "守卫已启动" : "仅保存配置"}
          </div>
        </div>
        <button type="button" className="ghost-button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "展开"}
        </button>
      </div>
      {!expanded ? null : (
        <div className="goal-panel-body">
          <div className="goal-guard-state-card">
            <strong>{guardDecisionStateLabel(effectiveGuardDecisionState)}</strong>
            <span>{guardDecisionStateHint(effectiveGuardDecisionState)}</span>
          </div>
          {effectiveGuardDecisionReason ? (
            <div className="session-meta">当前判断依据：{effectiveGuardDecisionReason}</div>
          ) : null}
          {session.currentTaskRunId ? <div className="session-meta">当前 taskRunId：{session.currentTaskRunId}</div> : null}
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
              placeholder={'比如：npm run build / file_exists:dist/app.js / file_contains:log.txt::READY / json_equals:result.json::status::"ok"'}
            />
          </label>
          <div className="session-meta">
            {"支持结构化 verifier 前缀：file_exists:相对路径、file_contains:路径::文本、json_equals:路径::字段.path::JSON值。未使用前缀时仍按 shell 命令执行。"}
          </div>
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
              ref={resumePromptTextareaRef}
              rows={4}
              value={resumePromptDraft}
              onChange={(event) => {
                setResumePromptDraft(event.target.value);
                setDirty(true);
                setSavedNotice(null);
              }}
            />
          </label>
          <div className="session-meta">
            可用模板变量：{"{{success_signal}}"}、{"{{goal_text}}"}。其中 {"{{success_signal}}"} 会展开成当前配置里的全部成功关键词；旧模板里的 {"{{success_keyword}}"} 和 {"{{success_keywords}}"} 仍然继续兼容。
          </div>
          <div className="goal-template-panel">
            <button
              type="button"
              className="goal-template-toggle"
              onClick={() => setTemplatePanelExpanded((current) => !current)}
            >
              <span>模板</span>
              <span className="goal-template-toggle-summary">
                {defaultTemplate ? `默认：${defaultTemplate.name}` : "未设置默认模板"}
              </span>
              <span>{templatePanelExpanded ? "收起" : "展开"}</span>
            </button>
            {!templatePanelExpanded ? null : (
              <>
                <div className="goal-template-variable-bar">
                  {resumePromptVariables.map((item) => (
                    <button
                      key={item.token}
                      type="button"
                      className="ghost-button"
                      onClick={() => appendTemplateVariable(item.token)}
                    >
                      插入{item.label}
                    </button>
                  ))}
                </div>
            <div className="goal-template-row">
              <label>
                搜索模板
                <input
                  value={templateSearch}
                  onChange={(event) => setTemplateSearch(event.target.value)}
                  placeholder="按模板名或内容筛选"
                />
              </label>
              <button type="button" className="ghost-button" onClick={restoreBuiltInTemplates} disabled={templateLoading}>
                恢复官方默认模板
              </button>
            </div>
            <div className="goal-template-row">
              <label>
                已保存模板
                <select
                  value={selectedTemplateId}
                  disabled={templateLoading}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    if (!nextId) {
                      setSelectedTemplateId("");
                      return;
                    }
                    applySelectedTemplate(nextId);
                  }}
                >
                  <option value="">选择一个模板</option>
                  {filteredTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.isDefault ? `${template.name} · 默认` : template.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="ghost-button" onClick={() => applySelectedTemplate(selectedTemplateId)} disabled={!selectedTemplateId}>
                套用模板
              </button>
              <button type="button" className="ghost-button" onClick={updateSelectedTemplate} disabled={!selectedTemplateId}>
                更新当前模板
              </button>
              <button type="button" className="ghost-button" onClick={setSelectedTemplateAsDefault} disabled={!selectedTemplateId}>
                设为默认
              </button>
              <button type="button" className="ghost-button danger" onClick={deleteSelectedTemplate} disabled={!selectedTemplateId}>
                删除模板
              </button>
            </div>
            <div className="goal-template-row">
              <label>
                模板名称
                <input
                  value={templateNameDraft}
                  onChange={(event) => setTemplateNameDraft(event.target.value)}
                  placeholder="例如：标准推进 / 严格收尾"
                />
              </label>
              <button type="button" className="ghost-button" onClick={saveCurrentDraftAsTemplate}>
                保存为模板
              </button>
              <button type="button" className="ghost-button" onClick={saveCurrentDraftAsNewTemplate}>
                另存为新模板
              </button>
            </div>
            <div className="session-meta">
              {templateLoading
                ? "模板同步中..."
                : defaultTemplate
                  ? `当前默认模板：${defaultTemplate.name}。模板已持久化到当前服务端，换浏览器后仍可继续使用。`
                  : "模板已持久化到当前服务端，换浏览器后仍可继续使用。"}
            </div>
            <label>
              实际发送预览
              <textarea rows={4} value={renderedResumePrompt} readOnly />
            </label>
              </>
            )}
          </div>
          {!(form.successCommand ?? "").trim() ? (
            <div className="session-meta">
              当前没有配置严格 verifier。系统仍可观测候选完成信号，但不会自动确认最终成功。
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
              <div className="session-meta">
                以下调试信息按优先级展示：先看结构化事实，再看 terminal fallback，最后再看 tmux pane 差异。
              </div>
              <div className="goal-debug-grid">
                <div>守卫启用：{debugInfo.guardEnabled ? "是" : "否"}</div>
                <div>当前状态：{guardDecisionStateLabel(debugInfo.guardDecisionState)}</div>
                {debugInfo.guardDecisionReason ? <div>当前判断依据：{debugInfo.guardDecisionReason}</div> : null}
                <div>当前主要依据：{progressSignalLabel(debugInfo.progressSignal)}</div>
                <div>{progressSignalHint(debugInfo.progressSignal, debugInfo.terminalSignalsAllowed)}</div>
                <div>结构化事实来源：{structuredFactSourceLabel(debugInfo.structuredFactSource)}</div>
                <div>当前 taskRunId：{debugInfo.currentTaskRunId ?? "无"}</div>
                <div>已确认成功证据：{debugInfo.successEvidence ? debugInfo.successEvidence.kind : "无"}</div>
                <div>成功确认时间：{debugInfo.successEvidence ? formatTimestamp(debugInfo.successEvidence.confirmedAt) : "无"}</div>
                <div>成功证据事件 seq：{debugInfo.successEvidence?.eventSeq ?? "无"}</div>
                <div>goalSpec：{debugInfo.goalSpec?.kind ?? "无"}</div>
                <div>verificationSpec：{debugInfo.verificationSpec?.kind ?? "无"}</div>
                <div>最近 receipt：{debugInfo.verificationReceipt?.status ?? "无"}</div>
                <div>receipt 时间：{debugInfo.verificationReceipt ? formatTimestamp(debugInfo.verificationReceipt.createdAt) : "无"}</div>
                <div>tmux 存在：{debugInfo.hasTmuxSession ? "是" : "否"}</div>
                <div>自动续跑次数：{debugInfo.autoResumeCount}</div>
                <div>守卫启用时间：{formatTimestamp(debugInfo.goalActivatedAt)}</div>
                <div>最近输出时间：{formatTimestamp(debugInfo.lastOutputAt)}</div>
                <div>结构化最近事件：{formatTimestamp(debugInfo.structuredLastEventAt)}</div>
                <div>综合活动时间：{formatTimestamp(debugInfo.observedActivityAt)}</div>
                <div>允许 terminal 主判定：{debugInfo.terminalSignalsAllowed ? "是" : "否"}</div>
                <div>app-server 统一摘要已启用：{debugInfo.appServerDebugSummary.enabled ? "是" : "否"}</div>
                <div>app-server 结构化健康：{debugInfo.appServerDebugSummary.healthLabel}</div>
                <div>app-server 匹配 thread：{debugInfo.appServerDebugSummary.matchedThreadId ?? "无"}</div>
                <div>app-server 最终状态：{debugInfo.appServerDebugSummary.finalTurnState}</div>
                <div>app-server 最终状态来源：{appServerTurnStateSourceLabel(debugInfo.appServerDebugSummary.finalTurnStateSource)}</div>
                <div>app-server 致命错误：{debugInfo.appServerDebugSummary.fatalError ?? "无"}</div>
                <div>最近自动续跑：{formatTimestamp(debugInfo.lastAutoResumeAt)}</div>
                <div>最近视口活动：{formatTimestamp(debugInfo.lastViewerActivityAt)}</div>
                <div>观察窗口剩余：{goalWarmupRemainingSec > 0 ? `${goalWarmupRemainingSec}s` : "已进入监控"}</div>
                <div>Codex 观察可用：{debugInfo.codexObservation.available ? "是" : "否"}</div>
                <div>执行链路：{session.executionChannel}</div>
                <div>已绑定当前 Codex session：{session.currentCodexSessionId ?? "无"}</div>
                <div>Codex 匹配会话：{debugInfo.codexObservation.matchedSessionId ?? "无"}</div>
                <div>Codex 匹配方式：{debugInfo.codexObservation.matchedBy ?? "无"}</div>
                <div>Codex turn 状态：{debugInfo.codexObservation.turnState}</div>
                <div>Codex 最近致命错误：{debugInfo.codexObservation.fatalError ?? "无"}</div>
                <div>terminal 命中 SUCCESS 单行：{debugInfo.matchedStandaloneSuccess ? "是" : "否"}</div>
                <div>terminal 命中成功关键词：{debugInfo.matchedSuccessKeyword ?? "无"}</div>
                <div>terminal 未完成信号：{debugInfo.matchedIncompleteSignals.join("、") || "无"}</div>
                <div>pane 快照是否变化：{debugInfo.snapshotChanged ? "是" : "否"}</div>
              </div>
              <div className="session-meta">
                下面先展示结构化 Codex 观察与 app-server 统一摘要，再展示原始辅助摘要和 terminal fallback。若结构化观察可用，应优先依据结构化时间线判断。
              </div>
              <label>
                Codex 最近 assistant 消息
                <textarea
                  rows={10}
                  value={
                    debugInfo.codexObservation.recentAssistantMessages.length > 0
                      ? debugInfo.codexObservation.recentAssistantMessages
                          .map(
                            (message) =>
                              `[${new Date(message.timestamp).toLocaleTimeString("zh-CN", {
                                hour12: false,
                              })}] phase=${message.phase ?? "unknown"}\n${message.text}`,
                          )
                          .join("\n\n")
                      : "暂无可用的 Codex assistant 消息"
                  }
                  readOnly
                />
              </label>
              <label>
                Codex 最近错误
                <textarea
                  rows={5}
                  value={debugInfo.codexObservation.recentErrors.join("\n\n") || "暂无可用的 Codex 错误事件"}
                  readOnly
                />
              </label>
              <label>
                Codex 最近命令
                <textarea
                  rows={5}
                  value={debugInfo.codexObservation.recentCommands.join("\n") || "暂无可用的 Codex 命令事件"}
                  readOnly
                />
              </label>
              <label>
                app-server 统一摘要
                <textarea
                  rows={12}
                  value={JSON.stringify(debugInfo.appServerDebugSummary, null, 2)}
                  readOnly
                />
              </label>
              <div className="session-meta">
                下面三个 app-server 原始摘要主要用于深度排查。日常先看上面的统一摘要即可，只有在需要定位是 notification、后台常驻连接还是 thread snapshot 哪一层异常时，再展开这些原始数据。
              </div>
              <label>
                app-server notification 摘要
                <textarea
                  rows={6}
                  value={JSON.stringify(debugInfo.appServerNotificationSummary, null, 2)}
                  readOnly
                />
              </label>
              <label>
                app-server notification manager 摘要
                <textarea
                  rows={6}
                  value={JSON.stringify(debugInfo.appServerNotificationManagerSummary, null, 2)}
                  readOnly
                />
              </label>
              <label>
                app-server thread manager 摘要
                <textarea
                  rows={8}
                  value={JSON.stringify(debugInfo.appServerThreadManagerSummary, null, 2)}
                  readOnly
                />
              </label>
              <div className="session-meta">
                下面展示 terminal fallback 与 tmux pane 相关信息。这些内容现在主要用于辅助排查，而不是优先主判定。
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
              <label>
                最近守卫事件
                <textarea
                  rows={12}
                  value={
                    debugInfo.recentEvents.length > 0
                      ? debugInfo.recentEvents
                          .map(
                            (event) =>
                              `#${event.seq} [${event.source}] ${new Date(event.createdAt).toLocaleTimeString("zh-CN", {
                                hour12: false,
                              })}\n${event.normalizedText || "<empty>"}`,
                          )
                          .join("\n\n")
                      : "暂无最近事件"
                  }
                  readOnly
                />
              </label>
              <label>
                成功证据详情
                <textarea rows={4} value={debugInfo.successEvidence?.detail ?? "暂无已确认成功证据"} readOnly />
              </label>
              <label>
                最近 verifier receipt
                <textarea
                  rows={8}
                  value={debugInfo.verificationReceipt ? JSON.stringify(debugInfo.verificationReceipt, null, 2) : "暂无 verifier receipt"}
                  readOnly
                />
              </label>
              <label>
                terminal fallback 观察窗口
                <textarea
                  rows={10}
                  value={debugInfo.sanitizedGoalWindowTailLines.join("\n") || "暂无 terminal fallback 观察窗口"}
                  readOnly
                />
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
