interface SystemPanelProps {
  capabilities: {
    platform: string;
    nodeVersion: string;
    tmuxAvailable: boolean;
    codexExecutable: string;
    features: Record<string, boolean>;
  } | null;
  configSchema: Array<{
    key: string;
    required: boolean;
    defaultValue: string | number | boolean | null;
    example: string;
    description: string;
  }>;
}

export function SystemPanel({ capabilities, configSchema }: SystemPanelProps) {
  return (
    <section className="panel system-panel">
      <div className="panel-header">
        <div>
          <div className="eyebrow">状态</div>
          <h2>运行信息</h2>
        </div>
      </div>
      {capabilities ? (
        <div className="system-summary">
          <div><strong>平台：</strong>{capabilities.platform}</div>
          <div><strong>Node：</strong>{capabilities.nodeVersion}</div>
          <div><strong>tmux：</strong>{capabilities.tmuxAvailable ? "可用" : "不可用"}</div>
          <div><strong>Codex 命令：</strong><code>{capabilities.codexExecutable}</code></div>
        </div>
      ) : (
        <div className="session-meta">尚未读取系统能力。</div>
      )}
      <div className="config-schema-list">
        {configSchema.map((item) => (
          <article key={item.key} className="schema-card">
            <div className="schema-card-top">
              <strong>{item.key}</strong>
              <span className={`status-pill ${item.required ? "" : "status-optional"}`}>
                {item.required ? "required" : "optional"}
              </span>
            </div>
            <div className="session-meta">{item.description}</div>
            <div className="session-preview">
              默认：<code>{String(item.defaultValue)}</code>
            </div>
            <div className="session-preview">
              示例：<code>{item.example}</code>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
