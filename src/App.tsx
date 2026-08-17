import { Check, ChevronRight, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ContextSidebar } from "./components/ContextSidebar";
import { Sidebar } from "./components/Sidebar";
import { knowledgeItems, skills, tasks } from "./data";
import { AutomationScreen } from "./screens/AutomationScreen";
import { ConversationScreen } from "./screens/ConversationScreen";
import { KnowledgeScreen } from "./screens/KnowledgeScreen";
import { TaskBoardScreen } from "./screens/TaskBoardScreen";
import type { ConversationView, Section } from "./types";

function App() {
  const [section, setSection] = useState<Section>("chat");
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [conversationView, setConversationView] = useState<ConversationView>("new");
  const [conversationTitle, setConversationTitle] = useState("跨部门 AI 需求诊断");
  const [conversationMode, setConversationMode] = useState<"聊天" | "工作">("工作");
  const [selectedKnowledgeTitle, setSelectedKnowledgeTitle] = useState(knowledgeItems[0].title);
  const [selectedSkill, setSelectedSkill] = useState(skills[0]);
  const [selectedTask, setSelectedTask] = useState(tasks[0]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileOpen(false);
        setSettingsOpen(false);
        setMobileOpen(false);
        setContextOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  const openNavigation = () => {
    setContextOpen(false);
    setMobileOpen(true);
  };

  const toggleContext = () => {
    setMobileOpen(false);
    setContextOpen((open) => !open);
  };

  const screenChrome = {
    contextOpen,
    onOpenNavigation: openNavigation,
    onToggleContext: toggleContext,
  };

  return (
    <div className={contextOpen ? "app-shell has-context" : "app-shell"}>
      <Sidebar
        activeSection={section}
        selectedConversationTitle={conversationView === "existing" ? conversationTitle : null}
        onSectionChange={(nextSection) => { setSection(nextSection); setProfileOpen(false); setMobileOpen(false); setContextOpen(false); }}
        onNewConversation={() => { setSection("chat"); setConversationView("new"); setProfileOpen(false); setMobileOpen(false); setContextOpen(false); }}
        onConversationOpen={(title) => { setSection("chat"); setConversationView("existing"); setConversationTitle(title); setProfileOpen(false); setMobileOpen(false); setContextOpen(false); }}
        profileOpen={profileOpen}
        onProfileToggle={() => setProfileOpen((open) => !open)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onOpenSettings={() => { setProfileOpen(false); setSettingsOpen(true); }}
      />
      {section === "chat" && <ConversationScreen key={`${conversationView}-${conversationTitle}`} {...screenChrome} view={conversationView} conversationTitle={conversationTitle} mode={conversationMode} onModeChange={setConversationMode} />}
      {section === "knowledge" && <KnowledgeScreen {...screenChrome} selectedTitle={selectedKnowledgeTitle} onSelectedTitleChange={setSelectedKnowledgeTitle} />}
      {section === "automation" && <AutomationScreen {...screenChrome} selectedSkill={selectedSkill} onSelectedSkillChange={setSelectedSkill} />}
      {section === "tasks" && <TaskBoardScreen {...screenChrome} selectedTask={selectedTask} onSelectedTaskChange={setSelectedTask} />}
      <ContextSidebar
        section={section}
        conversationTitle={conversationView === "new" ? (conversationMode === "聊天" ? "新聊天" : "新工作") : conversationTitle}
        conversationMode={conversationMode}
        conversationView={conversationView}
        open={contextOpen}
        onClose={() => setContextOpen(false)}
        onReturnChat={() => { setSection("chat"); setConversationView("existing"); setMobileOpen(false); }}
        knowledgeItem={knowledgeItems.find((item) => item.title === selectedKnowledgeTitle) ?? knowledgeItems[0]}
        skill={selectedSkill}
        task={selectedTask}
      />
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
          <article><h2>常规</h2><div className="setting-row"><div><strong>默认会话模式</strong><p>新会话默认进入工作空状态。</p></div><span className="setting-value">工作<ChevronRight size={15} /></span></div><div className="setting-row"><div><strong>数据出站确认</strong><p>模型请求前展示上下文摘要。</p></div><span className="setting-enabled"><Check size={14} />已开启</span></div><div className="setting-row"><div><strong>受控工作目录</strong><p>文件操作只允许发生在授权目录内。</p></div><span className="setting-enabled"><ShieldCheck size={15} />已保护</span></div></article>
        </div>
      </section>
    </div>
  );
}

export default App;
