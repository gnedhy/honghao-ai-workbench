import { confirmWorkbenchLeave } from "./components/interactionNavigation";
import { FolderClosed, FolderKanban, LibraryBig, MessageCircle, PanelsTopLeft, Search, WandSparkles, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fetchModules, fetchServiceHealth, fetchWorkbenches, type ServiceConnection } from "./api";
import { ContextSidebar } from "./components/ContextSidebar";
import { SettingsDialog, type UiFontSize } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { ProfileDialog } from "./components/ProfileDialog";
import { knowledgeItems, skills, workflows } from "./data";
import { AutomationScreen } from "./screens/AutomationScreen";
import { ConversationScreen } from "./screens/ConversationScreen";
import { KnowledgeScreen } from "./screens/KnowledgeScreen";
import { TaskBoardScreen } from "./screens/TaskBoardScreen";
import { WorkbenchScreen } from "./screens/WorkbenchScreen";
import type { Conversation, ConversationMessage, ConversationView, CurrentUser, ModuleStatus, ModuleVisibility, ResearchPage, SalesPage, ProcurementPage, Project, Section, TaskItem, WorkbenchId, WorkbenchStatus } from "./types";
import {sectionNavigation,workbenches,workbenchContext} from "./workbenchRegistry";
import {useChatWorkspace} from "./chat/useChatWorkspace";
import {ProjectDrawer} from "./chat/ProjectDrawer";
import {useAppFeedback} from "./appFeedback";
import { PageState } from "./components/WorkbenchLayout";

type AppProps = {
  currentUser: CurrentUser;
  onLogout: () => Promise<void>;
  onUserChanged: (user: CurrentUser) => void;
  onPasswordChanged: (message: string) => void;
  onSessionInvalid?: () => void;
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

const MODULE_IDS=sectionNavigation.map(item=>item.id);
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

function AppShell({ currentUser, onLogout, onUserChanged, onPasswordChanged, onSessionInvalid }: AppProps) {
  const [moduleStatuses, setModuleStatuses] = useState<ModuleStatus[]>([]);
  const [moduleRegistryState, setModuleRegistryState] = useState<"loading" | "ready" | "error">("loading");
  const [registryRetry, setRegistryRetry] = useState(0);
  const enabledModules = useMemo(() => MODULE_IDS.reduce<ModuleVisibility>((visibility, id) => {
    const allowed = currentUser.is_system_admin || ((id === "chat" || id === "tasks") && Boolean(currentUser.ai_enabled)) || (id === "knowledge" ? (currentUser.scope_levels.knowledge ?? 0) >= 2 : id === "workbench" && workbenches.some(item => (currentUser.scope_levels[item.id] ?? 0) >= 2));
    visibility[id] = id !== 'automation' && allowed && moduleStatuses.some((module) => module.id === id && module.mode !== "off");
    return visibility;
  }, { chat: false, knowledge: false, automation: false, workbench: false, tasks: false }), [moduleStatuses, currentUser]);
  const [section, setSection] = useState<Section>("workbench");
  const [profileOpen, setProfileOpen] = useState(false);
  const [personalProfileOpen, setPersonalProfileOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextLayoutOpen, setContextLayoutOpen] = useState(false);
  const [contextClosing, setContextClosing] = useState(false);
  const contextCloseTimer = useRef<number | null>(null);
  const selectedConversationIdRef = useRef<string | null>(null);
  const conversationViewRef = useRef<ConversationView>("new");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uiFontSize, setUiFontSize] = useState<UiFontSize>(loadUiFontSize);
  const [conversationView, setConversationView] = useState<ConversationView>("new");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationMode, setConversationMode] = useState<"聊天" | "工作">("工作");
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [workbenchStatuses, setWorkbenchStatuses] = useState<WorkbenchStatus[]>([]);
  const [workbenchRegistryState, setWorkbenchRegistryState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState<WorkbenchId>("management");
  const [openedWorkbenchId, setOpenedWorkbenchId] = useState<WorkbenchId | null>(null);
  const [salesPage, setSalesPage] = useState<SalesPage>("dashboard");
  const [researchPage, setResearchPage] = useState<ResearchPage>("dashboard");
  const [procurementPage, setProcurementPage] = useState<ProcurementPage>("dashboard");
  const [knowledgeScope, setKnowledgeScope] = useState<"个人" | "公共">("个人");
  const [selectedKnowledgeTitle, setSelectedKnowledgeTitle] = useState(knowledgeItems[0].title);
  const [automationTab, setAutomationTab] = useState<"技能" | "工作流">("技能");
  const [selectedSkill, setSelectedSkill] = useState(skills[0]);
  const [selectedWorkflow, setSelectedWorkflow] = useState(workflows[0]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [projectDialog, setProjectDialog] = useState<string | null | undefined>(undefined);
  const [serviceConnection, setServiceConnection] = useState<ServiceConnection>({ state: "checking" });
  const workspace = useChatWorkspace(currentUser.id,enabledModules.chat,enabledModules.tasks,serviceConnection.state==='online',conversationView,selectedConversationId,value=>{
    if(value.conversation && conversationViewRef.current==='new' && selectedConversationIdRef.current===null){setSelectedConversationId(value.conversation.id);setConversationView('existing');}
    if(value.task)setSelectedTaskId(value.task.id);
  },()=>onSessionInvalid?.());
  const {projects,conversations,tasks,messages,messagesState,projectAssociation,state:workbenchDataState}=workspace;
  useEffect(()=>{if(!enabledModules.chat){setProjectDialog(undefined);setSelectedConversationId(null);setConversationView('new');setCurrentProjectId(null);}if(!enabledModules.tasks)setSelectedTaskId(null);},[enabledModules.chat,enabledModules.tasks]);
  const permissions = JSON.stringify([currentUser.is_system_admin, currentUser.ai_enabled, currentUser.scope_levels]);
  const visibleWorkbenchStatuses = workbenchStatuses.filter(item => currentUser.is_system_admin || (currentUser.scope_levels[item.id] ?? 0) >= 2);
  const workbenchViewState = workbenchRegistryState === "error" && visibleWorkbenchStatuses.length ? "ready" : workbenchRegistryState;
  const {feedbackOpen,feedbackDraft,feedbackUnread,openFeedback,closeFeedback,setFeedbackDraft,refreshUnread}=useAppFeedback(currentUser.id);

  const activeWorkbenchId = section === "workbench" && openedWorkbenchId === selectedWorkbenchId && workbenchViewState === "ready" && visibleWorkbenchStatuses.some(item => item.id === openedWorkbenchId && item.mode === "active") ? openedWorkbenchId : null;

  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const conversationTasks=tasks.filter(task=>task.conversation_id===selectedConversationId);
  const conversationTask=conversationTasks.find(task=>task.id===selectedTaskId)??(conversationTasks.length===1?conversationTasks[0]:null);
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
        .then((health) => { if (!controller.signal.aborted) setServiceConnection({ state: "online", health }); })
        .catch((error: unknown) => {
          if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
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
    fetchModules(controller.signal)
      .then((statuses) => { if (!controller.signal.aborted) { setModuleStatuses(statuses); setModuleRegistryState("ready"); } })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
          setModuleRegistryState("error");
        }
      });
    return () => controller.abort();
  }, [serviceConnection.state, permissions, registryRetry]);

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
    fetchWorkbenches(controller.signal)
      .then((statuses) => { if (!controller.signal.aborted) { setWorkbenchStatuses(statuses); setWorkbenchRegistryState("ready"); } })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) setWorkbenchRegistryState("error");
      });
    return () => controller.abort();
  }, [enabledModules.workbench, serviceConnection.state, permissions, registryRetry]);

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

  const openConversation=(id:string,taskId?:string)=>{showSection('chat');setConversationView('existing');setSelectedConversationId(id);setSelectedTaskId(taskId??null);if(taskId)setConversationMode('工作');};
  const newConversation=(projectId=currentProjectId)=>{workspace.discardDraft();showSection('chat');setConversationView('new');setSelectedConversationId(null);setSelectedTaskId(null);setCurrentProjectId(projectId);setConversationMode('工作');};
  const openTask=(task:TaskItem)=>openConversation(task.conversation_id,task.id);

  const showSection = (next: Section) => {
    setSection(next);
    setOpenedWorkbenchId(null);
    setProcurementPage("dashboard");
    setProfileOpen(false);
    setMobileOpen(false);
    closeContext();
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
        openedWorkbenchId={activeWorkbenchId}
        salesPage={salesPage}
        onSalesPageChange={async (next) => { if (await confirmWorkbenchLeave()) setSalesPage(next); }}
        researchPage={researchPage}
        onResearchPageChange={async (next) => { if (await confirmWorkbenchLeave()) setResearchPage(next); }}
        procurementPage={procurementPage}
        onProcurementPageChange={async (next) => { if (await confirmWorkbenchLeave()) setProcurementPage(next); }}
        onSectionChange={async (nextSection) => { if (!await confirmWorkbenchLeave()) return; showSection(nextSection); }}
        onNewConversation={async () => { if (await confirmWorkbenchLeave()) newConversation(); }}
        onConversationOpen={async (id) => { if (await confirmWorkbenchLeave()) openConversation(id); }}
        onProjectCreate={async()=>{if(await confirmWorkbenchLeave()){workspace.discardDraft();setProjectDialog(null);}}}
        onProjectOpen={async id=>{if(await confirmWorkbenchLeave()){workspace.discardDraft();setProjectDialog(id);}}}
        onProjectNewConversation={async id=>{if(await confirmWorkbenchLeave())newConversation(id);}}
        onDataRetry={()=>void workspace.reload().catch(()=>{})}
        onSearchOpen={() => { setProfileOpen(false); setMobileOpen(false); setGlobalSearchOpen(true); }}
        feedbackUnread={feedbackUnread}
        onFeedbackOpen={() => { setProfileOpen(false); setMobileOpen(false); openFeedback(); }}
        profileOpen={profileOpen}
        onProfileToggle={() => setProfileOpen((open) => !open)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onOpenSettings={() => { setProfileOpen(false); setSettingsOpen(true); }}
        onOpenProfile={() => { setProfileOpen(false); setPersonalProfileOpen(true); }}
        onLogout={async () => { if (await confirmWorkbenchLeave()) await onLogout(); }}
      />
      {(moduleRegistryState === "loading" || moduleRegistryState === "error" && !moduleStatuses.length) && <main className="app-main"><PageState error={moduleRegistryState === "error"} className="workspace-detail-empty"><strong>{moduleRegistryState === "error" ? "模块状态不可用" : "正在读取模块状态"}</strong><p>{moduleRegistryState === "error" ? "请重新加载页面后重试。" : "正在确认可用入口。"}</p>{moduleRegistryState === "error" && <button className="secondary-button" onClick={() => window.location.reload()}>重新加载页面</button>}</PageState></main>}
      {(moduleRegistryState === "error" && moduleStatuses.length > 0 || workbenchRegistryState === "error" && visibleWorkbenchStatuses.length > 0) && <PageState error className="app-registry-status" onRetry={() => setRegistryRetry(value => value + 1)}>状态刷新失败，当前保留上次确认的入口和未保存输入。</PageState>}
      {(moduleRegistryState === "ready" || moduleRegistryState === "error" && moduleStatuses.length > 0) && !MODULE_IDS.some(id => enabledModules[id]) && <main className="app-main"><PageState className="workspace-detail-empty"><strong>暂无可用模块</strong><p>当前账号没有已启用且可访问的模块，请联系管理员。</p></PageState></main>}
      {section === 'chat' && enabledModules.chat && !workspace.denied && <ConversationScreen {...screenChrome}
        ownerId={currentUser.id} view={conversationView} conversationId={selectedConversationId} conversationTitle={conversationTitle} mode={conversationMode}
        onModeChange={async mode=>{if(await confirmWorkbenchLeave()){workspace.discardDraft();setConversationMode(mode);}}}
        onEntryMode={setConversationMode}
        projects={projects} projectId={conversationProjectId} task={conversationTask} tasks={conversationTasks} tasksEnabled={workspace.tasksAvailable}
        onTaskChange={async id=>{if(await confirmWorkbenchLeave()){workspace.discardDraft();setSelectedTaskId(id);}}}
        workspace={workspace} onProjectChange={async id=>{if(!await confirmWorkbenchLeave())return;workspace.discardDraft();if(conversationView==='existing'&&selectedConversation)projectAssociation.change(selectedConversation,id);else setCurrentProjectId(id);}}
        onAccessLost={()=>{workspace.handleLost({status:401});}} />}
      {section === "knowledge" && enabledModules.knowledge && <KnowledgeScreen {...screenChrome} scopeTab={knowledgeScope} onScopeTabChange={setKnowledgeScope} selectedTitle={selectedKnowledgeTitle} onSelectedTitleChange={setSelectedKnowledgeTitle} />}
      {section === "automation" && enabledModules.automation && <AutomationScreen {...screenChrome} tab={automationTab} onTabChange={setAutomationTab} selectedSkill={selectedSkill} onSelectedSkillChange={setSelectedSkill} selectedWorkflow={selectedWorkflow} onSelectedWorkflowChange={setSelectedWorkflow} />}
      {section === "workbench" && enabledModules.workbench && <WorkbenchScreen {...screenChrome} currentUser={currentUser} statuses={visibleWorkbenchStatuses} dataState={workbenchViewState} selectedId={selectedWorkbenchId} onSelectedIdChange={async (id) => { if (!await confirmWorkbenchLeave()) return; setSelectedWorkbenchId(id); setOpenedWorkbenchId(null); setProcurementPage("dashboard"); }} openedWorkbenchId={openedWorkbenchId} onOpenedWorkbenchIdChange={async (next) => { if (await confirmWorkbenchLeave()) setOpenedWorkbenchId(next); }} salesPage={salesPage} onSalesPageChange={async (next) => { if (await confirmWorkbenchLeave()) setSalesPage(next); }} researchPage={researchPage} onResearchPageChange={async (next) => { if (await confirmWorkbenchLeave()) setResearchPage(next); }} procurementPage={procurementPage} onProcurementPageChange={setProcurementPage} />}
      {section === 'tasks' && enabledModules.tasks && !workspace.denied && <TaskBoardScreen {...screenChrome} ownerId={currentUser.id} tasks={tasks} projects={projects} conversations={conversations} dataState={workspace.taskState} selectedTask={selectedTask}
        chatEnabled={enabledModules.chat} onDataRetry={()=>void workspace.reload().catch(()=>{})} onSelectedTaskChange={task=>setSelectedTaskId(task.id)} onTaskOpen={async task=>{if(await confirmWorkbenchLeave())openTask(task);}} onAccessLost={workspace.handleTaskLost} />}
      {workspace.denied && <PageState error>授权已失效，正在清理当前工作区。</PageState>}
      {projectDialog!==undefined && enabledModules.chat && !workspace.denied && <ProjectDrawer project={projects.find(row=>row.id===projectDialog)??null} owner={currentUser.id} conversations={conversations} tasks={tasks} onSaved={project=>{workspace.projectSaved(project);if(projectDialog===null)setCurrentProjectId(project.id);}} onClose={()=>setProjectDialog(undefined)} onNewConversation={newConversation} onConversation={openConversation} onTask={openTask} onAccessLost={()=>workspace.handleLost({status:401})} /> }
      <ContextSidebar
        section={section}
        conversationTitle={conversationView === "new" ? (conversationMode === "聊天" ? "新聊天" : "新工作") : conversationTitle}
        conversationMode={conversationMode}
        conversationView={conversationView}
        projectTitle={conversationProjectTitle}
        taskProjectTitle={projects.find(row=>row.id===(section==='chat'?conversationTask:selectedTask)?.project_id)?.title??null}
        automationTab={automationTab}
        open={contextOpen}
        closing={contextClosing}
        onClose={closeContext}
        onReturnChat={async () => { if (selectedTask && await confirmWorkbenchLeave()) openTask(selectedTask); }}
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
        workbenchStatuses={visibleWorkbenchStatuses}
        onClose={() => setGlobalSearchOpen(false)}
        onSelect={async (result) => {
          if (!await confirmWorkbenchLeave()) return;
          if (result.kind === "conversation") {
            openConversation(result.sourceId);
          } else if (result.kind === "project") {
            newConversation(result.sourceId);
          } else if (result.kind === "knowledge") {
            const item = knowledgeItems.find((knowledgeItem) => knowledgeItem.title === result.sourceId);
            setKnowledgeScope(item?.scope === "公共知识" ? "公共" : "个人");
            showSection("knowledge");
            setSelectedKnowledgeTitle(result.sourceId);
          } else if (result.kind === "workbench") {
            setSelectedWorkbenchId(result.sourceId as WorkbenchId);
            showSection("workbench");
          } else {
            const task=tasks.find(row=>row.id===result.sourceId);if(task)openTask(task);
          }
        }}
      />
      {settingsOpen && <SettingsDialog currentUser={currentUser} onUserChanged={onUserChanged} serviceConnection={serviceConnection} moduleStatuses={moduleStatuses} moduleRegistryState={moduleRegistryState} workbenchStatuses={workbenchStatuses} workbenchRegistryState={workbenchRegistryState} uiFontSize={uiFontSize} onUiFontSizeChange={setUiFontSize} onClose={() => setSettingsOpen(false)} onOpenProfile={() => { setSettingsOpen(false); setPersonalProfileOpen(true); }} />}
      {feedbackOpen && <FeedbackDialog draft={feedbackDraft} onDraftChange={setFeedbackDraft} currentUser={currentUser} context={activeWorkbenchId ? workbenchContext(activeWorkbenchId,{procurement:procurementPage,research:researchPage,sales:salesPage}) : sectionNavigation.find(item=>item.id===section)?.label??"工作台"} version={serviceConnection.state === "online" ? serviceConnection.health.api_version : "未知"} onClose={closeFeedback} onUnreadChanged={refreshUnread} />}
      {personalProfileOpen && <ProfileDialog onClose={() => setPersonalProfileOpen(false)} onUserChanged={onUserChanged} onPasswordChanged={onPasswordChanged} beforePasswordChange={confirmWorkbenchLeave} />}
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

function App(props:AppProps) { return <AppShell key={props.currentUser.id} {...props}/>; }

export default App;
