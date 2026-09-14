import { confirmWorkbenchLeave as allowProcurementLeave } from "./components/interactionNavigation";
import { FolderClosed, FolderKanban, LibraryBig, MessageCircle, PanelsTopLeft, Search, WandSparkles, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createConversationSubmission, createProject, fetchConversations, fetchMessages, fetchModules, fetchProjects, fetchServiceHealth, fetchTasks, fetchWorkbenches, setConversationProject, submitConversation, type ServiceConnection } from "./api";
import { ContextSidebar } from "./components/ContextSidebar";
import { SettingsDialog, type UiFontSize } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { FeedbackDialog, emptyFeedbackDraft } from "./components/FeedbackDialog";
import { ProfileDialog } from "./components/ProfileDialog";
import { knowledgeItems, skills, workflows } from "./data";
import { AutomationScreen } from "./screens/AutomationScreen";
import { ConversationScreen } from "./screens/ConversationScreen";
import { KnowledgeScreen } from "./screens/KnowledgeScreen";
import { TaskBoardScreen } from "./screens/TaskBoardScreen";
import { workbenches, WorkbenchScreen } from "./screens/WorkbenchScreen";
import type { Conversation, ConversationMessage, ConversationView, CurrentUser, ModuleStatus, ModuleVisibility, ResearchPage, ProcurementPage, Project, Section, TaskItem, WorkbenchId, WorkbenchStatus } from "./types";
import { PROCUREMENT_PAGE_LABELS } from "./types";

type AppProps = {
  currentUser: CurrentUser;
  onLogout: () => Promise<void>;
  onUserChanged: (user: CurrentUser) => void;
  onPasswordChanged: (message: string) => void;
};

type SearchScope = "全部" | "会话" | "项目" | "知识" | "自动化" | "工作台" | "任务";
type SearchResultKind = "conversation" | "project" | "knowledge" | "skill" | "workflow" | "workbench" | "task";
type GlobalSearchResult = {
  id: string;
  sourceId: string;
  kind: SearchResultKind;
  scope: Exclude<SearchScope, "全部">;
  title: string;
  meta: string;
  keywords: string;
};

const MODULE_IDS: Section[] = ["chat", "knowledge", "automation", "workbench", "tasks"];
const UI_FONT_SIZE_KEY = "honghao-ui-font-size";

function loadUiFontSize(): UiFontSize {
  try {
    const stored = window.localStorage.getItem(UI_FONT_SIZE_KEY);
    if (stored === "1" || stored === "2" || stored === "3" || stored === "4" || stored === "5") return Number(stored) as UiFontSize;
    if (stored === "small") return 1;
    if (stored === "standard") return 2;
    return 3;
  } catch { return 3; }
}

function App({ currentUser, onLogout, onUserChanged, onPasswordChanged }: AppProps) {
  const [moduleStatuses, setModuleStatuses] = useState<ModuleStatus[]>([]);
  const [moduleRegistryState, setModuleRegistryState] = useState<"loading" | "ready" | "error">("loading");
  const enabledModules = useMemo(() => MODULE_IDS.reduce<ModuleVisibility>((visibility, id) => {
    visibility[id] = moduleStatuses.some((module) => module.id === id && module.mode !== "off");
    return visibility;
  }, { chat: false, knowledge: false, automation: false, workbench: false, tasks: false }), [moduleStatuses]);
  const [section, setSection] = useState<Section>("workbench");
  const [profileOpen, setProfileOpen] = useState(false);
  const [personalProfileOpen, setPersonalProfileOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextLayoutOpen, setContextLayoutOpen] = useState(false);
  const [contextClosing, setContextClosing] = useState(false);
  const contextCloseTimer = useRef<number | null>(null);
  const projectUpdatePromise = useRef<Promise<void>>(Promise.resolve());
  const selectedConversationIdRef = useRef<string | null>(null);
  const conversationViewRef = useRef<ConversationView>("new");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uiFontSize, setUiFontSize] = useState<UiFontSize>(loadUiFontSize);
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
  const [workbenchStatuses, setWorkbenchStatuses] = useState<WorkbenchStatus[]>([]);
  const [workbenchRegistryState, setWorkbenchRegistryState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState<WorkbenchId>("management");
  const [openedWorkbenchId, setOpenedWorkbenchId] = useState<WorkbenchId | null>(null);
  const [researchPage, setResearchPage] = useState<ResearchPage>("dashboard");
  const [procurementPage, setProcurementPage] = useState<ProcurementPage>("dashboard");
  const [knowledgeScope, setKnowledgeScope] = useState<"个人" | "公共">("个人");
  const [selectedKnowledgeTitle, setSelectedKnowledgeTitle] = useState(knowledgeItems[0].title);
  const [automationTab, setAutomationTab] = useState<"技能" | "工作流">("技能");
  const [selectedSkill, setSelectedSkill] = useState(skills[0]);
  const [selectedWorkflow, setSelectedWorkflow] = useState(workflows[0]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [serviceConnection, setServiceConnection] = useState<ServiceConnection>({ state: "checking" });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState(emptyFeedbackDraft);
  const [feedbackUnread, setFeedbackUnread] = useState<number | null>(null);
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/feedback/unread", { signal: controller.signal });
        if (!response.ok) throw new Error("Unread unavailable");
        const data = await response.json() as { count: number };
        if (!controller.signal.aborted) setFeedbackUnread(data.count);
      } catch { if (!controller.signal.aborted) setFeedbackUnread(null); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [currentUser.id, feedbackRevision]);

  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const conversationTask = [...tasks].reverse().find((task) => task.conversation_id === selectedConversationId) ?? null;
  const conversationTitle = selectedConversation?.title ?? "新聊天";
  const conversationProjectId = conversationView === "existing" ? selectedConversation?.project_id ?? null : currentProjectId;
  const conversationProjectTitle = projects.find((project) => project.id === conversationProjectId)?.title ?? null;

  useLayoutEffect(() => {
    document.documentElement.dataset.fontSize = String(uiFontSize);
    try { window.localStorage.setItem(UI_FONT_SIZE_KEY, String(uiFontSize)); } catch { /* The preference remains active for this session. */ }
  }, [uiFontSize]);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
    conversationViewRef.current = conversationView;
  }, [conversationView, selectedConversationId]);

  useEffect(() => {
    if (moduleRegistryState !== "ready") return;
    if (!enabledModules[section]) {
      const fallback = MODULE_IDS.find((id) => enabledModules[id]);
      if (fallback) setSection(fallback);
    }
  }, [enabledModules, moduleRegistryState, section]);

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
      if (serviceConnection.state === "offline") setModuleRegistryState("error");
      return;
    }

    const controller = new AbortController();
    setModuleRegistryState("loading");
    fetchModules(controller.signal)
      .then((statuses) => { setModuleStatuses(statuses); setModuleRegistryState("ready"); })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setModuleStatuses([]);
          setModuleRegistryState("error");
        }
      });
    return () => controller.abort();
  }, [serviceConnection.state]);

  useEffect(() => {
    if (!enabledModules.workbench) {
      setWorkbenchStatuses([]);
      setWorkbenchRegistryState("ready");
      return;
    }
    if (serviceConnection.state !== "online") {
      if (serviceConnection.state === "offline") setWorkbenchRegistryState("error");
      return;
    }

    const controller = new AbortController();
    setWorkbenchRegistryState("loading");
    fetchWorkbenches(controller.signal)
      .then((statuses) => { setWorkbenchStatuses(statuses); setWorkbenchRegistryState("ready"); })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setWorkbenchRegistryState("error");
      });
    return () => controller.abort();
  }, [enabledModules.workbench, serviceConnection.state]);

  useEffect(() => {
    if (serviceConnection.state !== "online") {
      if (serviceConnection.state === "offline") setWorkbenchDataState("error");
      return;
    }

    const controller = new AbortController();
    const needsConversationData = enabledModules.chat || enabledModules.tasks;
    if (!needsConversationData) {
      setWorkbenchDataState("ready");
      return () => controller.abort();
    }
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
  }, [enabledModules.chat, enabledModules.tasks, serviceConnection.state]);

  useEffect(() => {
    if (!enabledModules.chat || conversationView !== "existing" || !selectedConversationId || serviceConnection.state !== "online") {
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
  }, [conversationView, enabledModules.chat, selectedConversationId, serviceConnection.state]);

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
        setGlobalSearchOpen(false);
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

  const runtimeEnvironment = serviceConnection.state === "online" ? serviceConnection.health.environment : null;
  const screenChrome = {
    contextOpen,
    onOpenNavigation: openNavigation,
    onToggleContext: toggleContext,
    moduleMode: moduleStatuses.find((module) => module.id === section)?.mode ?? "off" as const,
    environment: runtimeEnvironment,
  };

  const submitMessage = async (content: string, submissionKey: string): Promise<boolean> => {
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
          submissionKey,
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
          submissionKey,
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
        currentUser={currentUser}
        activeSection={section}
        selectedConversationId={conversationView === "existing" ? selectedConversationId : null}
        currentProjectId={currentProjectId}
        projects={projects}
        conversations={conversations}
        dataState={workbenchDataState}
        enabledModules={enabledModules}
        environment={runtimeEnvironment}
        openedWorkbenchId={openedWorkbenchId}
        researchPage={researchPage}
        onResearchPageChange={async (next) => { if (await allowProcurementLeave()) setResearchPage(next); }}
        procurementPage={procurementPage}
        onProcurementPageChange={async (next) => { if (await allowProcurementLeave()) setProcurementPage(next); }}
        onSectionChange={async (nextSection) => { if (!await allowProcurementLeave()) return; setSection(nextSection); setOpenedWorkbenchId(null); setProcurementPage("dashboard"); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        onNewConversation={async () => { if (!await allowProcurementLeave()) return; setSection("chat"); setConversationView("new"); setSelectedConversationId(null); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        onConversationOpen={async (conversationId) => { if (!await allowProcurementLeave()) return; setSection("chat"); setConversationView("existing"); setSelectedConversationId(conversationId); setProfileOpen(false); setMobileOpen(false); closeContext(); }}
        onProjectCreate={(title) => { void createProject(title).then((created) => { setProjects((current) => [...current, created]); setCurrentProjectId(created.id); }).catch(() => setWorkbenchDataState("error")); }}
        onSearchOpen={() => { setProfileOpen(false); setMobileOpen(false); setGlobalSearchOpen(true); }}
        feedbackUnread={feedbackUnread}
        onFeedbackOpen={() => { setProfileOpen(false); setMobileOpen(false); setFeedbackOpen(true); }}
        profileOpen={profileOpen}
        onProfileToggle={() => setProfileOpen((open) => !open)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onOpenSettings={() => { setProfileOpen(false); setSettingsOpen(true); }}
        onOpenProfile={() => { setProfileOpen(false); setPersonalProfileOpen(true); }}
        onLogout={async () => { if (await allowProcurementLeave()) await onLogout(); }}
      />
      {section === "chat" && enabledModules.chat && <ConversationScreen {...screenChrome} view={conversationView} conversationTitle={conversationTitle} mode={conversationMode} onModeChange={setConversationMode} projects={projects} projectId={conversationProjectId} onProjectChange={(projectId) => { if (conversationView === "existing" && selectedConversationId) { const update = projectUpdatePromise.current.catch(() => undefined).then(async () => { const updated = await setConversationProject(selectedConversationId, projectId); setConversations((current) => current.map((conversation) => conversation.id === updated.id ? updated : conversation)); }); projectUpdatePromise.current = update; void update.catch(() => setWorkbenchDataState("error")); } else { setCurrentProjectId(projectId); } }} messages={messages} messagesState={messagesState} onSubmit={submitMessage} />}
      {section === "knowledge" && enabledModules.knowledge && <KnowledgeScreen {...screenChrome} scopeTab={knowledgeScope} onScopeTabChange={setKnowledgeScope} selectedTitle={selectedKnowledgeTitle} onSelectedTitleChange={setSelectedKnowledgeTitle} />}
      {section === "automation" && enabledModules.automation && <AutomationScreen {...screenChrome} tab={automationTab} onTabChange={setAutomationTab} selectedSkill={selectedSkill} onSelectedSkillChange={setSelectedSkill} selectedWorkflow={selectedWorkflow} onSelectedWorkflowChange={setSelectedWorkflow} />}
      {section === "workbench" && enabledModules.workbench && <WorkbenchScreen {...screenChrome} currentUser={currentUser} statuses={workbenchStatuses} dataState={workbenchRegistryState} selectedId={selectedWorkbenchId} onSelectedIdChange={async (id) => { if (!await allowProcurementLeave()) return; setSelectedWorkbenchId(id); setOpenedWorkbenchId(null); setProcurementPage("dashboard"); }} openedWorkbenchId={openedWorkbenchId} onOpenedWorkbenchIdChange={async (next) => { if (await allowProcurementLeave()) setOpenedWorkbenchId(next); }} researchPage={researchPage} onResearchPageChange={async (next) => { if (await allowProcurementLeave()) setResearchPage(next); }} procurementPage={procurementPage} onProcurementPageChange={setProcurementPage} />}
      {section === "tasks" && enabledModules.tasks && <TaskBoardScreen {...screenChrome} tasks={tasks} projects={projects} conversations={conversations} dataState={workbenchDataState} selectedTask={selectedTask} onSelectedTaskChange={(task) => setSelectedTaskId(task.id)} />}
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
      <GlobalSearchDialog
        open={globalSearchOpen}
        enabledModules={enabledModules}
        projects={projects}
        conversations={conversations}
        tasks={tasks}
        workbenchStatuses={workbenchStatuses}
        onClose={() => setGlobalSearchOpen(false)}
        onSelect={async (result) => {
          if (!await allowProcurementLeave()) return;
          setProfileOpen(false);
          setMobileOpen(false);
          closeContext();
          if (result.kind === "conversation") {
            setSection("chat");
            setConversationView("existing");
            setSelectedConversationId(result.sourceId);
          } else if (result.kind === "project") {
            setSection("chat");
            setConversationView("new");
            setSelectedConversationId(null);
            setCurrentProjectId(result.sourceId);
          } else if (result.kind === "knowledge") {
            const item = knowledgeItems.find((knowledgeItem) => knowledgeItem.title === result.sourceId);
            setKnowledgeScope(item?.scope === "公共知识" ? "公共" : "个人");
            setSection("knowledge");
            setSelectedKnowledgeTitle(result.sourceId);
          } else if (result.kind === "skill") {
            const skill = skills.find((item) => item.title === result.sourceId);
            if (skill) setSelectedSkill(skill);
            setAutomationTab("技能");
            setSection("automation");
          } else if (result.kind === "workflow") {
            const workflow = workflows.find((item) => item.title === result.sourceId);
            if (workflow) setSelectedWorkflow(workflow);
            setAutomationTab("工作流");
            setSection("automation");
          } else if (result.kind === "workbench") {
            setSelectedWorkbenchId(result.sourceId as WorkbenchId);
            setSection("workbench");
          } else {
            setSelectedTaskId(result.sourceId);
            setSection("tasks");
          }
        }}
      />
      {settingsOpen && <SettingsDialog currentUser={currentUser} onUserChanged={onUserChanged} serviceConnection={serviceConnection} moduleStatuses={moduleStatuses} moduleRegistryState={moduleRegistryState} workbenchStatuses={workbenchStatuses} workbenchRegistryState={workbenchRegistryState} uiFontSize={uiFontSize} onUiFontSizeChange={setUiFontSize} onClose={() => setSettingsOpen(false)} onOpenProfile={() => { setSettingsOpen(false); setPersonalProfileOpen(true); }} />}
      {feedbackOpen && <FeedbackDialog draft={feedbackDraft} onDraftChange={setFeedbackDraft} currentUser={currentUser} context={openedWorkbenchId ? `${workbenches.find(item => item.id === openedWorkbenchId)?.title ?? "工作台"}${openedWorkbenchId === "procurement" ? ` / ${PROCUREMENT_PAGE_LABELS[procurementPage]}` : ""}` : ({chat:"新聊天",knowledge:"知识库",automation:"自动化",workbench:"工作台",tasks:"任务看板"})[section]} version={serviceConnection.state === "online" ? serviceConnection.health.api_version : "未知"} onClose={() => setFeedbackOpen(false)} onUnreadChanged={() => setFeedbackRevision(value => value + 1)} />}
      {personalProfileOpen && <ProfileDialog onClose={() => setPersonalProfileOpen(false)} onUserChanged={onUserChanged} onPasswordChanged={onPasswordChanged} beforePasswordChange={allowProcurementLeave} />}
    </div>
  );
}

function GlobalSearchDialog({
  open,
  enabledModules,
  projects,
  conversations,
  tasks,
  workbenchStatuses,
  onClose,
  onSelect,
}: {
  open: boolean;
  enabledModules: ModuleVisibility;
  projects: Project[];
  conversations: Conversation[];
  tasks: TaskItem[];
  workbenchStatuses: WorkbenchStatus[];
  onClose: () => void;
  onSelect: (result: GlobalSearchResult) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("全部");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery("");
      setScope("全部");
      dialog.showModal();
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const projectTitle = (projectId: string | null) => projects.find((project) => project.id === projectId)?.title;
  const conversationTitleById = (conversationId: string) => conversations.find((conversation) => conversation.id === conversationId)?.title;
  const results: GlobalSearchResult[] = [
    ...[...conversations].reverse().map((conversation) => ({ id: `conversation:${conversation.id}`, sourceId: conversation.id, kind: "conversation" as const, scope: "会话" as const, title: conversation.title, meta: projectTitle(conversation.project_id) ? `会话 · ${projectTitle(conversation.project_id)}` : "会话 · 未关联项目", keywords: `${conversation.title} ${projectTitle(conversation.project_id) ?? ""}` })),
    ...projects.map((project) => ({ id: `project:${project.id}`, sourceId: project.id, kind: "project" as const, scope: "项目" as const, title: project.title, meta: `项目 · ${conversations.filter((conversation) => conversation.project_id === project.id).length} 个会话`, keywords: project.title })),
    ...knowledgeItems.map((item) => ({ id: `knowledge:${item.title}`, sourceId: item.title, kind: "knowledge" as const, scope: "知识" as const, title: item.title, meta: `${item.scope} · ${item.updated}`, keywords: `${item.title} ${item.scope} ${item.tags.join(" ")} ${item.project ?? ""}` })),
    ...skills.map((item) => ({ id: `skill:${item.title}`, sourceId: item.title, kind: "skill" as const, scope: "自动化" as const, title: item.title, meta: `技能 · ${item.status} · ${item.version}`, keywords: `${item.title} ${item.description} 技能 ${item.status}` })),
    ...workflows.map((item) => ({ id: `workflow:${item.title}`, sourceId: item.title, kind: "workflow" as const, scope: "自动化" as const, title: item.title, meta: `工作流 · ${item.status} · ${item.version}`, keywords: `${item.title} ${item.description} 工作流 ${item.status}` })),
    ...workbenches.filter((item) => workbenchStatuses.some((status) => status.id === item.id && status.mode !== "off")).map((item) => ({ id: `workbench:${item.id}`, sourceId: item.id, kind: "workbench" as const, scope: "工作台" as const, title: item.title, meta: `${item.department} · 职能工作台`, keywords: `${item.department} ${item.title} ${item.summary} ${item.modules.join(" ")} ${item.source} ${item.output}` })),
    ...[...tasks].reverse().map((task) => ({ id: `task:${task.id}`, sourceId: task.id, kind: "task" as const, scope: "任务" as const, title: task.objective, meta: `任务 · ${projectTitle(task.project_id) ?? conversationTitleById(task.conversation_id) ?? "未关联项目"}`, keywords: `${task.objective} ${projectTitle(task.project_id) ?? ""} ${conversationTitleById(task.conversation_id) ?? ""}` })),
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleResults = results.filter((result) => {
    const moduleEnabled = result.scope === "知识"
      ? enabledModules.knowledge
      : result.scope === "自动化"
        ? enabledModules.automation
        : result.scope === "工作台"
          ? enabledModules.workbench
          : result.scope === "任务"
          ? enabledModules.tasks
          : enabledModules.chat;
    const scopeMatches = scope === "全部" || result.scope === scope;
    return moduleEnabled && scopeMatches && (!normalizedQuery || `${result.title} ${result.meta} ${result.keywords}`.toLocaleLowerCase().includes(normalizedQuery));
  }).slice(0, 12);
  const scopes: SearchScope[] = ["全部"];
  if (enabledModules.chat) scopes.push("会话", "项目");
  if (enabledModules.knowledge) scopes.push("知识");
  if (enabledModules.automation) scopes.push("自动化");
  if (enabledModules.workbench) scopes.push("工作台");
  if (enabledModules.tasks) scopes.push("任务");

  const chooseResult = (result: GlobalSearchResult) => {
    onSelect(result);
    onClose();
  };

  return (
    <dialog
      className="global-search-dialog"
      ref={dialogRef}
      aria-labelledby="global-search-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="global-search" aria-label="全局搜索">
        <h1 className="sr-only" id="global-search-title">全局搜索</h1>
        <div className="global-search__input-row">
          <Search size={18} />
          <input
            ref={inputRef}
            aria-label="搜索全部内容"
            placeholder="搜索已启用模块的内容"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && visibleResults[0]) chooseResult(visibleResults[0]); }}
          />
          <button className="icon-button" type="button" aria-label="关闭全局搜索" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="global-search__scope-row">
          <div className="global-search__scopes" role="group" aria-label="搜索范围">
            {scopes.map((item) => <button className={scope === item ? "is-active" : ""} type="button" key={item} aria-pressed={scope === item} onClick={() => { setScope(item); inputRef.current?.focus(); }}>{item}</button>)}
          </div>
          <span>{visibleResults.length} 项</span>
        </div>
        <div className="global-search__results" aria-label="搜索结果">
          {visibleResults.map((result) => (
            <button type="button" key={result.id} onClick={() => chooseResult(result)}>
              <span className="global-search__result-icon"><SearchResultIcon kind={result.kind} /></span>
              <span className="global-search__result-copy"><strong>{result.title}</strong><small>{result.meta}</small></span>
              <span className="global-search__result-scope">{result.scope}</span>
            </button>
          ))}
          {visibleResults.length === 0 && <div className="global-search__empty"><Search size={20} /><strong>没有匹配内容</strong><p>换一个关键词或搜索范围试试。</p></div>}
        </div>
      </section>
    </dialog>
  );
}

function SearchResultIcon({ kind }: { kind: SearchResultKind }) {
  if (kind === "conversation") return <MessageCircle size={16} />;
  if (kind === "project") return <FolderClosed size={16} />;
  if (kind === "knowledge") return <LibraryBig size={16} />;
  if (kind === "skill") return <WandSparkles size={16} />;
  if (kind === "workflow") return <Workflow size={16} />;
  if (kind === "workbench") return <PanelsTopLeft size={16} />;
  if (kind === "task") return <FolderKanban size={16} />;
  return null;
}

export default App;
