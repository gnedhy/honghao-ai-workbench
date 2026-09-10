import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { fetchCurrentUser, fetchServiceHealth, login, logout } from "./api";
import { LoginScreen } from "./screens/LoginScreen";
import "./styles.css";
import type { CurrentUser, RuntimeEnvironment } from "./types";

function Root() {
  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => { root.dataset.inputModality = "pointer"; };
    const keyboard = (event: KeyboardEvent) => {
      if (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", " "].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const typing = event.target instanceof HTMLElement && (event.target.matches("input,textarea") || event.target.isContentEditable);
        if (event.key === "Tab" || !typing) root.dataset.inputModality = "keyboard";
      }
    };
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", keyboard, true);
      delete root.dataset.inputModality;
    };
  }, []);
  const [user, setUser] = useState<CurrentUser | null>();
  const [loginNotice, setLoginNotice] = useState("");
  const [environment, setEnvironment] = useState<RuntimeEnvironment | null>();

  useEffect(() => {
    const controller = new AbortController();
    void fetchCurrentUser(controller.signal).then(setUser).catch(() => setUser(null));
    void fetchServiceHealth(controller.signal).then((health) => setEnvironment(health.environment)).catch(() => setEnvironment(null));
    return () => controller.abort();
  }, []);

  if (user === undefined || environment === undefined) return <main className="auth-loading" aria-label="正在验证登录状态"><span /></main>;
  if (user === null) {
    return <LoginScreen environment={environment} notice={loginNotice} onLogin={async (username, password) => {
      try {
        setUser(await login(username, password));
        setLoginNotice("");
        return true;
      } catch {
        return false;
      }
    }} />;
  }
  return <App currentUser={user} onUserChanged={setUser} onPasswordChanged={(message) => { setLoginNotice(message); setUser(null); }} onLogout={async () => { try { await logout(); } finally { setUser(null); } }} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
