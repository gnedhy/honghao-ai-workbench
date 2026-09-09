import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Columns2,
  Database,
  FolderClosed,
  FolderKanban,
  LibraryBig,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  PanelsTopLeft,
  PenLine,
  Plus,
  PackageCheck,
  Search,
  Settings,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { PROCUREMENT_PAGE_LABELS, type Conversation, type CurrentUser, type ModuleVisibility, type ProcurementPage, type Project, type RuntimeEnvironment, type Section, type WorkbenchId } from "../types";

type SidebarProps = {
  currentUser: CurrentUser;
  activeSection: Section;
  selectedConversationId: string | null;
  currentProjectId: string | null;
  projects: Project[];
  conversations: Conversation[];
  dataState: "loading" | "ready" | "error";
  enabledModules: ModuleVisibility;
  environment: RuntimeEnvironment | null;
  openedWorkbenchId: WorkbenchId | null;
  procurementPage: ProcurementPage;
  onProcurementPageChange: (page: ProcurementPage) => void;
  onSectionChange: (section: Section) => void;
  onNewConversation: () => void;
  onConversationOpen: (conversationId: string) => void;
  onProjectCreate: (title: string) => void;
  onSearchOpen: () => void;
  profileOpen: boolean;
  onProfileToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  onLogout: () => Promise<void>;
};

const navItems = [
  { id: "chat", label: "新聊天", icon: PenLine },
  { id: "knowledge", label: "知识库", icon: LibraryBig },
  { id: "automation", label: "自动化", icon: WandSparkles },
  { id: "workbench", label: "工作台", icon: PanelsTopLeft },
  { id: "tasks", label: "任务看板", icon: FolderKanban },
] as const;

const procurementPages = [
  { id: "dashboard", icon: LayoutDashboard },
  { id: "materials", icon: Database },
  { id: "distribution", icon: Columns2 },
  { id: "batches", icon: PackageCheck },
] as const;

export function Sidebar({
  currentUser,
  activeSection,
  selectedConversationId,
  currentProjectId,
  projects,
  conversations,
  dataState,
  enabledModules,
  environment,
  openedWorkbenchId,
  procurementPage,
  onProcurementPageChange,
  onSectionChange,
  onNewConversation,
  onConversationOpen,
  onProjectCreate,
  onSearchOpen,
  profileOpen,
  onProfileToggle,
  mobileOpen,
  onMobileClose,
  onOpenSettings,
  onOpenProfile,
  onLogout,
}: SidebarProps) {
  const [expandedProjectId, setExpandedProjectId] = useState("");
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");

  useEffect(() => {
    if (currentProjectId) setExpandedProjectId(currentProjectId);
  }, [currentProjectId]);

  const selectSection = (section: Section) => {
    onSectionChange(section);
    onMobileClose();
  };

  const openConversation = (conversationId: string) => {
    onConversationOpen(conversationId);
    onMobileClose();
  };

  const openProcurementPage = (page: ProcurementPage) => {
    onProcurementPageChange(page);
    onMobileClose();
  };

  const recentConversations = [...conversations].reverse();

  const submitProject = () => {
    const title = newProjectTitle.trim();
    if (!title) return;
    onProjectCreate(title);
    setNewProjectTitle("");
    setProjectCreateOpen(false);
  };

  return (
    <>
      {mobileOpen && <button className="sidebar-backdrop" type="button" aria-label="关闭导航" onClick={onMobileClose} />}
      <aside className={mobileOpen ? "sidebar is-mobile-open" : "sidebar"}>
        <div className="sidebar__brand">
          <div className="brand-button">
            <BrandMark />
            <span className="brand-button__label">宏昊化工</span>
            {environment === "test" && <span className="environment-badge">测试</span>}
          </div>
          <div className="sidebar__brand-actions">
            <button className="icon-button sidebar__search" type="button" aria-label="全局搜索" onClick={onSearchOpen}><Search size={18} /></button>
            <button className="icon-button sidebar__close" type="button" aria-label="关闭导航" onClick={onMobileClose}><X size={18} /></button>
          </div>
        </div>

        <nav className="primary-nav" aria-label="主要导航">
          {navItems.filter(({ id }) => enabledModules[id]).map(({ id, label, icon: Icon }) => (
            <button
              className={activeSection === id && id !== "chat" ? "nav-row is-active" : "nav-row"}
              key={id}
              type="button"
              aria-current={activeSection === id && id !== "chat" ? "page" : undefined}
              onClick={() => id === "chat" ? onNewConversation() : selectSection(id)}
            >
              {id === "workbench" && openedWorkbenchId ? <ArrowLeft size={18} strokeWidth={1.7} /> : <Icon size={18} strokeWidth={1.7} />}
              <span>{id === "workbench" && openedWorkbenchId ? "返回工作台" : label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar__scroll">
          {activeSection === "workbench" && openedWorkbenchId === "procurement" && (
            <SidebarGroup title="采购工作台">
              {procurementPages.map(({ id, icon: Icon }) => (
                <button className={(procurementPage === "updates" ? "materials" : procurementPage === "history" ? "batches" : procurementPage) === id ? "workbench-page-row is-active" : "workbench-page-row"} type="button" key={id} aria-current={(procurementPage === "updates" ? "materials" : procurementPage === "history" ? "batches" : procurementPage) === id ? "page" : undefined} onClick={() => openProcurementPage(id)}>
                  <Icon size={15} strokeWidth={1.7} />
                  <span>{PROCUREMENT_PAGE_LABELS[id]}</span>
                </button>
              ))}
            </SidebarGroup>
          )}
          {enabledModules.chat && <>
            <SidebarGroup title="置顶"><p className="sidebar-empty">暂无置顶会话</p></SidebarGroup>
            <SidebarGroup title="项目" action={<button className="sidebar-group__action" type="button" aria-label="新建项目" onClick={() => setProjectCreateOpen((open) => !open)}><Plus size={14} /></button>}>
            {projectCreateOpen && <form className="project-create" onSubmit={(event) => { event.preventDefault(); submitProject(); }}><FolderClosed size={14} /><input autoFocus aria-label="项目名称" placeholder="项目名称" value={newProjectTitle} onChange={(event) => setNewProjectTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setNewProjectTitle(""); setProjectCreateOpen(false); } }} /></form>}
            {dataState === "loading" && <p className="sidebar-empty">正在加载项目…</p>}
            {dataState === "error" && <p className="sidebar-empty sidebar-empty--error">项目暂时无法加载</p>}
            {dataState === "ready" && projects.length === 0 && <p className="sidebar-empty">还没有项目</p>}
            {projects.map((project, index) => {
              const expanded = expandedProjectId === project.id;
              const relatedConversations = conversations.filter((conversation) => conversation.project_id === project.id);
              return (
                <div className="project-entry" key={project.id}>
                  <button className={expanded ? "project-row is-expanded" : "project-row"} type="button" aria-expanded={expanded} onClick={() => setExpandedProjectId(expanded ? "" : project.id)}>
                    <span className={`project-mark project-mark--${(index % 3) + 1}`}><FolderClosed size={14} /></span>
                    <ScrollingTitle>{project.title}</ScrollingTitle>
                    <ChevronRight className="project-row__chevron" size={14} />
                  </button>
                  {expanded && (
                    <div className="project-thread-list">
                      {relatedConversations.length === 0 && <p className="sidebar-empty sidebar-empty--nested">暂无关联会话</p>}
                      {relatedConversations.map((conversation) => (
                        <button className={activeSection === "chat" && selectedConversationId === conversation.id ? "project-thread is-active" : "project-thread"} type="button" key={conversation.id} onClick={() => openConversation(conversation.id)}>
                          <ScrollingTitle>{conversation.title}</ScrollingTitle>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            </SidebarGroup>
            <SidebarGroup title="最近">
            {dataState === "ready" && recentConversations.length === 0 && <p className="sidebar-empty">暂无会话</p>}
            {recentConversations.map((conversation) => (
              <button className={activeSection === "chat" && selectedConversationId === conversation.id ? "conversation-row is-active" : "conversation-row"} type="button" key={conversation.id} onClick={() => openConversation(conversation.id)}>
                <MessageCircle size={16} />
                <ScrollingTitle>{conversation.title}</ScrollingTitle>
              </button>
            ))}
            </SidebarGroup>
          </>}
        </div>

        <div className="profile-area">
          {profileOpen && (
            <div className="profile-menu" role="menu">
              <button role="menuitem" type="button" onClick={onOpenProfile}><UserRound size={16} /><span>个人资料</span></button>
              <button role="menuitem" type="button" onClick={onOpenSettings}><Settings size={16} /><span>系统设置</span><span className="profile-menu__meta">Ctrl+,</span></button>
              <div className="profile-menu__divider" />
              <button className="is-danger" role="menuitem" type="button" onClick={() => void onLogout()}><LogOut size={16} /><span>退出登录</span></button>
            </div>
          )}
          <button className="profile-trigger" type="button" onClick={onProfileToggle} aria-expanded={profileOpen}>
            <span className="avatar" aria-hidden="true">{Array.from(currentUser.display_name)[0]}</span>
            <span className="profile-trigger__copy"><strong>{currentUser.display_name}</strong><small>{currentUser.department ?? (currentUser.is_system_admin ? "系统管理员" : "企业用户")}</small></span>
            <ChevronDown size={15} />
          </button>
        </div>
      </aside>
    </>
  );
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 28 28" role="presentation">
        <rect x="1" y="1" width="26" height="26" rx="8" />
        <path d="M8.5 8.2v11.6M19.5 8.2v11.6M8.5 14h11" />
        <circle cx="14" cy="14" r="2.15" />
      </svg>
    </span>
  );
}

function SidebarGroup({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="sidebar-group">
      <header><h2>{title}</h2>{action}</header>
      <div>{children}</div>
    </section>
  );
}

function ScrollingTitle({ children }: { children: string }) {
  return (
    <span className="sidebar-scrolling-title">
      <span className="sidebar-scrolling-title__text">{children}</span>
    </span>
  );
}
