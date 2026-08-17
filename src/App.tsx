import { Check, ChevronRight, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { AutomationScreen } from "./screens/AutomationScreen";
import { ConversationScreen } from "./screens/ConversationScreen";
import { KnowledgeScreen } from "./screens/KnowledgeScreen";
import { TaskBoardScreen } from "./screens/TaskBoardScreen";
import type { Section } from "./types";

function App() {
  const [section, setSection] = useState<Section>("chat");
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileOpen(false);
        setSettingsOpen(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar
        activeSection={section}
        onSectionChange={(nextSection) => { setSection(nextSection); setProfileOpen(false); }}
        profileOpen={profileOpen}
        onProfileToggle={() => setProfileOpen((open) => !open)}
        mobileOpen={mobileOpen}
        onMobileToggle={() => setMobileOpen((open) => !open)}
        onOpenSettings={() => { setProfileOpen(false); setSettingsOpen(true); }}
      />
      {section === "chat" && <ConversationScreen />}
      {section === "knowledge" && <KnowledgeScreen />}
      {section === "automation" && <AutomationScreen />}
      {section === "tasks" && <TaskBoardScreen />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><h1 id="settings-title">系统设置</h1><p>管理模型、知识访问和安全边界。</p></div><button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button></header>
        <div className="settings-dialog__body">
          <nav aria-label="设置分类"><button className="is-active" type="button">常规<ChevronRight size={15} /></button><button type="button">模型接口<ChevronRight size={15} /></button><button type="button">知识与目录<ChevronRight size={15} /></button><button type="button">安全与审查<ChevronRight size={15} /></button></nav>
          <article><h2>常规</h2><div className="setting-row"><div><strong>默认会话模式</strong><p>新会话默认进入聊天模式。</p></div><span className="setting-value">聊天<ChevronRight size={15} /></span></div><div className="setting-row"><div><strong>数据出站确认</strong><p>模型请求前展示上下文摘要。</p></div><span className="setting-enabled"><Check size={14} />已开启</span></div><div className="setting-row"><div><strong>受控工作目录</strong><p>文件操作只允许发生在授权目录内。</p></div><span className="setting-enabled"><ShieldCheck size={15} />已保护</span></div></article>
        </div>
      </section>
    </div>
  );
}

export default App;
