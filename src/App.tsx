import { Check, ChevronRight, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createConversationSubmission, createProject, fetchConversations, fetchMessages, fetchProjects, fetchServiceHealth, fetchTasks, setConversationProject, submitConversation, type ServiceConnection } from "./api";
import { ContextSidebar } from "./components/ContextSidebar";
import { Sidebar } from "./components/Sidebar";
import { knowledgeItems, skills, workflows } from "./data";
import { AutomationScreen } from "./screens/AutomationScreen";
import { ConversationScreen } from "./screens/ConversationScreen";
import { KnowledgeScreen } from "./screens/KnowledgeScreen";
import { TaskBoardScreen } from "./screens/TaskBoardScreen";
import type { Conversation, ConversationMessage, ConversationView, Project, Section, TaskItem } from "./types";

function App() {
  const [section, setSection] = useState<Section>("chat");
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextLayoutOpen, setContextLayoutOpen] = useState(false);
  const [contextClosing, setContextClosing] = useState(false);
  const contextCloseTimer = useRef<number | null>(null);
  const projectUpdatePromise = useRef<Promise<void>>(Promise.resolve());
  const selectedConversationIdRef = useRef<string | null>(null);
  const conversationViewRef = useRef<ConversationView>("new");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [conversationView, setConversationView] = useState<ConversationView>("new");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationMode, setConversationMode] = useState<"聊天" | "工作">("工作");
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [messagesState, setMessagesState] = useState<"loading" | "ready" | "error">("ready");
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [workbenchDataState, setWorkbenchDataState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedKnowledgeTitle, setSelectedKnowledgeTitle] = useState(knowledgeItems[0].title);
  const [automationTab, setAutomationTab] = useState<"技能" | "工作流">("技能");
  const [selectedSkill, setSelectedSkill] = useState(skills[0]);
  const [selectedWorkflow, setSelectedWorkflow] = useState(workflows[0]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [serviceConnection, setServiceConnection] = useState<ServiceConnection>({ state: "checking" });

  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const conversationTask = [...tasks].reverse().find((task) => task.conversation_id === selectedConversationId) ?? null;
  const conversationTitle = selectedConversation?.title ?? "新聊天";
  const conversationProjectId = conversationView === "existing" ? selectedConversation?.project_id ?? null : currentProjectId;
  const conversationProjectTitle = projects.find((project) => project.id === conversationProjectId)?.title ?? null;

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
    conversationViewRef.current = conversationView;
  }, [conversationView, selectedConversationId]);

  useEffect(() => {
    const controller = new AbortController();
    const retryDelays = [0, 300, 900, 1800];
    let retryTimer: number | null = null;

    const checkService = (attempt: number) => {
      fetchServiceHealth(controller.signal)
        .then((health) => setServiceConnection({ state: "online", health }))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          const nextAttempt = attempt + 1;
          if (nextAttempt < retryDelays.length) {
            retryTimer = window.setTimeout(() => checkService(nextAttempt), retryDelays[nextAttempt]);
          } else {
            setServiceConnection({ state: "offline" });
          }
        });
    };

    checkService(0);
    return () => {
      controller.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (serviceConnection.state !== "online") {
      if (serviceConnection.state === "offline") setWorkbenchDataState("error");
      return;
    }

    const controller = new AbortController();
    setWorkbenchDataState("loading");
    Promise.all([fetchProjects(controller.signal), fetchConversations(controller.signal), fetchTasks(controller.signal)])
      .then(([loadedProjects, loadedConversations, loadedTasks]) => {
        setProjects(loadedProjects);
        setConversations(loadedConversations);
        setTasks(loadedTasks);
        setSelectedTaskId((current) => current ?? loadedTasks[0]?.id ?? null);
        setWorkbenchDataState("ready");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setWorkbenchDataState("error");
        }
      });
    return () => controller.abort();
  }, [serviceConnection.state]);

  useEffect(() => {
    if (conversationView !== "existing" || !selectedConversationId || serviceConnection.state !== "online") {
      setMessages([]);
      setMessagesState("ready");
      return;
    }
    const controller = new AbortController();
    setMessagesState("loading");
    fetchMessages(selectedConversationId, controller.signal)
      .then((loadedMessages) => { setMessages(loadedMessages); setMessagesState("ready"); })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setMessagesState("error");
      });
    return () => controller.abort();
  }, [conversationView, selectedConversationId, serviceConnection.state]);

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

  const submitMessage = async (content: string, requestId: string): Promise<boolean> => {
    const creatingConversation = conversationView === "new" || !selectedConversationId;
    const conversationId = selectedConversationId;
    try {
      let result: { message: ConversationMessage; task: TaskItem | null };
      if (creatingConversation) {
        const title = content.length > 28 ? `${content.slice(0, 28)}…` : content;
        const created = await createConversationSubmission(
          title,
          currentProjectId,
          conversationMode === "聊天" ? "chat" : "work",
          content,
          requestId,
        );
        setConversations((current) => [...current, created.conversation]);
        result = created;
        if (conversationViewRef.current === "new" && selectedConversationIdRef.current === null) {
          setSelectedConversationId(created.conversation.id);
          setConversationView("existing");
          setMessages([created.message]);
          setMessagesState("ready");
        }
      } else {
        await projectUpdatePromise.current;
        if (!conversationId) throw new Error("Conversation is unavailable");
        result = await submitConversation(
          conversationId,
          conversationMode === "聊天" ? "chat" : "work",
          content,
          requestId,
        );
        if (selectedConversationIdRef.current === conversationId) {
          setMessages((current) => [...current, result.message]);
          setMessagesState("ready");
        }
      }
      if (result.task) {
        setTasks((current) => [...current, result.task!]);
        setSelectedTaskId(result.task.id);
      }
      return true;
    } catch {
      if (
        (creatingConversation && conversationViewRef.current === "new")
        || (!creatingConversation && selectedConversationIdRef.current === conversationId)
      ) {
        setMessagesState("error");
      }
      return false;
    }
  };

  return (
    <div className={contextLayoutOpen ? "app-shell has-context" : "app-shell"}>
      <Sidebar
        activeSection={section}
        selectedConversationId={conversationView === "existing" ? selectedConversationId : null}
        currentProjectId={currentProjectId}
        projects={projects}
        conversations={conversations}
        dataState={workbenchDataState}
        onSectionChange={(nextSection) => { setSection(nextSection); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        onNewConversation={() => { setSection("chat"); setConversationView("new"); setSelectedConversationId(null); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        onConversationOpen={(conversationId) => { setSection("chat"); setConversationView("existing"); setSelectedConversationId(conversationId); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        onProjectCreate={(title) => { void createProject(title).then((created) => { setProjects((current) => [...current, created]); setCurrentProjectId(created.id); }).catch(() => setWorkbenchDataState("error")); }}
        profileOpen={profileOpen}
        onProfileToggle={() => setProfileOpen((open) => !open)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onOpenSettings={() => { setProfileOpen(false); setSettingsOpen(true); }}
      />
      {section === "chat" && <ConversationScreen {...screenChrome} view={conversationView} conversationTitle={conversationTitle} mode={conversationMode} onModeChange={setConversationMode} projects={projects} projectId={conversationProjectId} onProjectChange={(projectId) => { if (conversationView === "existing" && selectedConversationId) { const update = projectUpdatePromise.current.catch(() => undefined).then(async () => { const updated = await setConversationProject(selectedConversationId, projectId); setConversations((current) => current.map((conversation) => conversation.id === updated.id ? updated : conversation)); }); projectUpdatePromise.current = update; void update.catch(() => setWorkbenchDataState("error")); } else { setCurrentProjectId(projectId); } }} messages={messages} messagesState={messagesState} onSubmit={submitMessage} />}
      {section === "knowledge" && <KnowledgeScreen {...screenChrome} selectedTitle={selectedKnowledgeTitle} onSelectedTitleChange={setSelectedKnowledgeTitle} />}
      {section === "automation" && <AutomationScreen {...screenChrome} tab={automationTab} onTabChange={setAutomationTab} selectedSkill={selectedSkill} onSelectedSkillChange={setSelectedSkill} selectedWorkflow={selectedWorkflow} onSelectedWorkflowChange={setSelectedWorkflow} />}
      {section === "tasks" && <TaskBoardScreen {...screenChrome} tasks={tasks} projects={projects} conversations={conversations} dataState={workbenchDataState} selectedTask={selectedTask} onSelectedTaskChange={(task) => setSelectedTaskId(task.id)} />}
      <ContextSidebar
        section={section}
        conversationTitle={conversationView === "new" ? (conversationMode === "聊天" ? "新聊天" : "新工作") : conversationTitle}
        conversationMode={conversationMode}
        conversationView={conversationView}
        projectTitle={conversationProjectTitle}
        automationTab={automationTab}
        open={contextOpen}
        closing={contextClosing}
        onClose={closeContext}
        onReturnChat={() => { if (selectedTask) setSelectedConversationId(selectedTask.conversation_id); setSection("chat"); setConversationView("existing"); setMobileOpen(false); closeContext(); }}
        knowledgeItem={knowledgeItems.find((item) => item.title === selectedKnowledgeTitle) ?? knowledgeItems[0]}
        skill={selectedSkill}
        workflow={selectedWorkflow}
        task={selectedTask}
        conversationTask={conversationTask}
      />
      {settingsOpen && <SettingsDialog serviceConnection={serviceConnection} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function SettingsDialog({ serviceConnection, onClose }: { serviceConnection: ServiceConnection; onClose: () => void }) {
  const serviceCopy = serviceConnection.state === "online"
    ? { label: "已连接", detail: `API ${serviceConnection.health.api_version} · 数据版本 ${serviceConnection.health.schema_version}` }
    : serviceConnection.state === "checking"
      ? { label: "连接中", detail: "正在检查本地 API 与数据库。" }
      : { label: "未连接", detail: "请启动本地 API 后刷新页面。" };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><h1 id="settings-title">系统设置</h1><p>管理模型、知识访问和安全边界。</p></div><button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button></header>
        <div className="settings-dialog__body">
          <nav aria-label="设置分类"><button className="is-active" type="button">常规<ChevronRight size={15} /></button><button type="button">模型接口<ChevronRight size={15} /></button><button type="button">知识与目录<ChevronRight size={15} /></button><button type="button">安全与审查<ChevronRight size={15} /></button></nav>
          <article><h2>常规</h2><div className="setting-row"><div><strong>本地服务</strong><p>{serviceCopy.detail}</p></div><span className={`setting-connection setting-connection--${serviceConnection.state}`}><i />{serviceCopy.label}</span></div><div className="setting-row"><div><strong>默认会话模式</strong><p>新会话默认进入工作空状态。</p></div><span className="setting-value">工作<ChevronRight size={15} /></span></div><div className="setting-row"><div><strong>数据出站确认</strong><p>模型请求前展示上下文摘要。</p></div><span className="setting-enabled"><Check size={14} />已开启</span></div><div className="setting-row"><div><strong>受控工作目录</strong><p>文件操作只允许发生在授权目录内。</p></div><span className="setting-enabled"><ShieldCheck size={15} />已保护</span></div></article>
        </div>
      </section>
    </div>
  );
}

export default App;
