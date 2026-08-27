import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { fetchCurrentUser, fetchServiceHealth, login, logout } from "./api";
import { LoginScreen } from "./screens/LoginScreen";
import "./styles.css";
import type { CurrentUser, RuntimeEnvironment } from "./types";

function Root() {
  const [user, setUser] = useState<CurrentUser | null>();
  const [environment, setEnvironment] = useState<RuntimeEnvironment | null>();

  useEffect(() => {
    const controller = new AbortController();
    void fetchCurrentUser(controller.signal).then(setUser).catch(() => setUser(null));
    void fetchServiceHealth(controller.signal).then((health) => setEnvironment(health.environment)).catch(() => setEnvironment(null));
    return () => controller.abort();
  }, []);

  if (user === undefined || environment === undefined) return <main className="auth-loading" aria-label="正在验证登录状态"><span /></main>;
  if (user === null) {
    return <LoginScreen environment={environment} onLogin={async (username, password) => {
      try {
        setUser(await login(username, password));
        return true;
      } catch {
        return false;
      }
    }} />;
  }
  return <App currentUser={user} onLogout={async () => { try { await logout(); } finally { setUser(null); } }} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
