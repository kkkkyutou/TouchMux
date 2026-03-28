import { useState } from "react";

interface LoginScreenProps {
  onLogin: (password: string) => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function LoginScreen({ onLogin, loading, error }: LoginScreenProps) {
  const [password, setPassword] = useState("");

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="eyebrow">TouchMux</div>
        <h1>手机远程工作台</h1>
        <p>
          连接本机的 <code>tmux</code>、<code>codex</code> 和受控文件区，在移动端保持稳定终端体验。
        </p>
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onLogin(password);
          }}
        >
          <label>
            登录口令
            <input
              type="password"
              autoComplete="current-password"
              placeholder="输入 TouchMux 密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? <div className="error-banner">{error}</div> : null}
          <button type="submit" disabled={loading || !password.trim()}>
            {loading ? "登录中..." : "进入工作台"}
          </button>
        </form>
      </section>
    </main>
  );
}
