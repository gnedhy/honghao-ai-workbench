import { ArrowRight, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { BrandMark } from "../components/Sidebar";
import type { RuntimeEnvironment } from "../types";

type LoginScreenProps = {
  environment: RuntimeEnvironment | null;
  onLogin: (username: string, password: string) => Promise<boolean>;
};

export function LoginScreen({ environment, onLogin }: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (environment === null || !username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(false);
    const succeeded = await onLogin(username.trim(), password);
    setSubmitting(false);
    if (!succeeded) setError(true);
  };

  return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand"><BrandMark /><strong>宏昊化工</strong>{environment === "test" && <span className="environment-badge">测试</span>}</div>
        <div className="login-heading">
          <span className="login-heading__icon"><LockKeyhole size={18} /></span>
          <div><h1 id="login-title">登录工作台</h1><p>{environment === null ? "本地服务尚未就绪。" : "使用企业内部账号继续。"}</p></div>
        </div>
        <form onSubmit={submit}>
          <label><span>用户名</span><input name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={environment === null} autoFocus /></label>
          <label><span>密码</span><input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={environment === null} /></label>
          {environment === null ? <p className="login-error" role="alert">请检查服务启动状态后刷新页面。</p> : error && <p className="login-error" role="alert">用户名或密码不正确，或账号已停用。</p>}
          <button type="submit" disabled={environment === null || !username.trim() || !password || submitting}><span>{environment === null ? "服务未就绪" : submitting ? "正在登录" : "登录"}</span><ArrowRight size={16} /></button>
        </form>
        <p className="login-help">账号由系统管理员创建，不支持自助注册。</p>
      </section>
    </main>
  );
}
