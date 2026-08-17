import { Check, ChevronRight, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ContextSidebar } from "./components/ContextSidebar";
import { Sidebar } from "./components/Sidebar";
import { knowledgeItems, skills, tasks, workflows } from "./data";
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
  const [contextLayoutOpen, setContextLayoutOpen] = useState(false);
  const [contextClosing, setContextClosing] = useState(false);
  const contextCloseTimer = useRef<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [conversationView, setConversationView] = useState<ConversationView>("new");
  const [conversationTitle, setConversationTitle] = useState("跨部门 AI 需求诊断");
  const [conversationMode, setConversationMode] = useState<"聊天" | "工作">("工作");
  const [selectedKnowledgeTitle, setSelectedKnowledgeTitle] = useState(knowledgeItems[0].title);
  const [automationTab, setAutomationTab] = useState<"技能" | "工作流">("技能");
  const [selectedSkill, setSelectedSkill] = useState(skills[0]);
  const [selectedWorkflow, setSelectedWorkflow] = useState(workflows[0]);
  const [selectedTask, setSelectedTask] = useState(tasks[0]);

  const closeContext = useCallback(() => {
    if (!contextOpen) return;
    if (contextCloseTimer.current !== null) window.clearTimeout(contextCloseTimer.current);
    setContextClosing(true);
    setContextLayoutOpen(false);
    contextCloseTimer.current = window.setTimeout(() => {
      setContextOpen(false);
      setContextClosing(false);
      contextCloseTimer.current = null;
    }, 220);
  }, [contextOpen]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileOpen(false);
        setSettingsOpen(false);
        setMobileOpen(false);
        closeContext();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeContext]);

  useEffect(() => () => {
    if (contextCloseTimer.current !== null) window.clearTimeout(contextCloseTimer.current);
  }, []);

  const openNavigation = () => {
    closeContext();
    setMobileOpen(true);
  };

  const toggleContext = () => {
    setMobileOpen(false);
    if (contextOpen) {
      closeContext();
      return;
    }
    if (contextCloseTimer.current !== null) window.clearTimeout(contextCloseTimer.current);
    setContextClosing(false);
    setContextLayoutOpen(true);
    setContextOpen(true);
  };

  const screenChrome = {
    contextOpen,
    onOpenNavigation: openNavigation,
    onToggleContext: toggleContext,
  };

  return (
    <div className={contextLayoutOpen ? "app-shell has-context" : "app-shell"}>
      <Sidebar
        activeSection={section}
        selectedConversationTitle={conversationView === "existing" ? conversationTitle : null}
        onSectionChange={(nextSection) => { setSection(nextSection); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        onNewConversation={() => { setSection("chat"); setConversationView("new"); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        onConversationOpen={(title) => { setSection("chat"); setConversationView("existing"); setConversationTitle(title); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        profileOpen={profileOpen}
        onProfileToggle={() => setProfileOpen((open) => !open)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onOpenSettings={() => { setProfileOpen(false); setSettingsOpen(true); }}
      />
      {section === "chat" && <ConversationScreen key={`${conversationView}-${conversationTitle}`} {...screenChrome} view={conversationView} conversationTitle={conversationTitle} mode={conversationMode} onModeChange={setConversationMode} />}
      {section === "knowledge" && <KnowledgeScreen {...screenChrome} selectedTitle={selectedKnowledgeTitle} onSelectedTitleChange={setSelectedKnowledgeTitle} />}
      {section === "automation" && <AutomationScreen {...screenChrome} tab={automationTab} onTabChange={setAutomationTab} selectedSkill={selectedSkill} onSelectedSkillChange={setSelectedSkill} selectedWorkflow={selectedWorkflow} onSelectedWorkflowChange={setSelectedWorkflow} />}
      {section === "tasks" && <TaskBoardScreen {...screenChrome} selectedTask={selectedTask} onSelectedTaskChange={setSelectedTask} />}
      <ContextSidebar
        section={section}
        conversationTitle={conversationView === "new" ? (conversationMode === "聊天" ? "新聊天" : "新工作") : conversationTitle}
        conversationMode={conversationMode}
        conversationView={conversationView}
        automationTab={automationTab}
        open={contextOpen}
        closing={contextClosing}
        onClose={closeContext}
        onReturnChat={() => { setSection("chat"); setConversationView("existing"); setMobileOpen(false); }}
        knowledgeItem={knowledgeItems.find((item) => item.title === selectedKnowledgeTitle) ?? knowledgeItems[0]}
        skill={selectedSkill}
        workflow={selectedWorkflow}
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
