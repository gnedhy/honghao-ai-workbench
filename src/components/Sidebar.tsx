import {
  Bot,
  ChevronDown,
  ChevronRight,
  Columns2,
  FolderClosed,
  FolderKanban,
  LibraryBig,
  LogOut,
  MessageCircle,
  PenLine,
  Pin,
  Search,
  Settings,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import userAvatar from "../assets/avatar-zhang-wei-v1.png";
import { pinnedConversations, projectGroups, recentConversations } from "../data";
import type { Section } from "../types";

type SidebarProps = {
  activeSection: Section;
  selectedConversationTitle: string | null;
  onSectionChange: (section: Section) => void;
  onNewConversation: () => void;
  onConversationOpen: (title: string) => void;
  profileOpen: boolean;
  onProfileToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  onOpenSettings: () => void;
};

const navItems = [
  { id: "chat", label: "新聊天", icon: PenLine },
  { id: "knowledge", label: "知识库", icon: LibraryBig },
  { id: "automation", label: "自动化", icon: WandSparkles },
  { id: "tasks", label: "任务看板", icon: FolderKanban },
] as const;

export function Sidebar({
  activeSection,
  selectedConversationTitle,
  onSectionChange,
  onNewConversation,
  onConversationOpen,
  profileOpen,
  onProfileToggle,
  mobileOpen,
  onMobileClose,
  onOpenSettings,
}: SidebarProps) {
  const [expandedProject, setExpandedProject] = useState(projectGroups[0].title);

  const selectSection = (section: Section) => {
    onSectionChange(section);
    onMobileClose();
  };

  const openConversation = (title: string) => {
    onConversationOpen(title);
    onMobileClose();
  };

  return (
    <>
      {mobileOpen && <button className="sidebar-backdrop" type="button" aria-label="关闭导航" onClick={onMobileClose} />}
      <aside className={mobileOpen ? "sidebar is-mobile-open" : "sidebar"}>
        <div className="sidebar__brand">
          <button className="brand-button" type="button" aria-label="切换工作空间">
            <BrandMark />
            <span className="brand-button__label">宏昊 AI</span>
            <ChevronDown className="brand-button__chevron" size={14} />
          </button>
          <div className="sidebar__brand-actions">
            <button className="icon-button sidebar__search" type="button" aria-label="搜索"><Search size={18} /></button>
            <button className="icon-button sidebar__close" type="button" aria-label="关闭导航" onClick={onMobileClose}><X size={18} /></button>
          </div>
        </div>

        <nav className="primary-nav" aria-label="主要导航">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              className={activeSection === id && id !== "chat" ? "nav-row is-active" : "nav-row"}
              key={id}
              type="button"
              aria-current={activeSection === id && id !== "chat" ? "page" : undefined}
              onClick={() => id === "chat" ? onNewConversation() : selectSection(id)}
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar__scroll">
          <SidebarGroup title="置顶">
            {pinnedConversations.map((title, index) => (
              <button
                className={activeSection === "chat" && selectedConversationTitle === title ? "conversation-row is-active" : "conversation-row"}
                type="button"
                key={title}
                onClick={() => openConversation(title)}
              >
                {index === 0 ? <Bot size={16} /> : <Columns2 size={16} />}
                <span>{title}</span>
                <Pin size={14} />
              </button>
            ))}
          </SidebarGroup>
          <SidebarGroup title="项目">
            {projectGroups.map((project, index) => {
              const expanded = expandedProject === project.title;
              return (
                <div className="project-entry" key={project.title}>
                  <button className={expanded ? "project-row is-expanded" : "project-row"} type="button" aria-expanded={expanded} onClick={() => setExpandedProject(expanded ? "" : project.title)}>
                    <span className={`project-mark project-mark--${index + 1}`}><FolderClosed size={14} /></span>
                    <span>{project.title}</span>
                    <ChevronRight className="project-row__chevron" size={14} />
                  </button>
                  {expanded && (
                    <div className="project-thread-list">
                      {project.conversations.map((title) => (
                        <button className={activeSection === "chat" && selectedConversationTitle === title ? "project-thread is-active" : "project-thread"} type="button" key={title} onClick={() => openConversation(title)}>
                          <span>{title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </SidebarGroup>
          <SidebarGroup title="最近">
            {recentConversations.map((title) => (
              <button className={activeSection === "chat" && selectedConversationTitle === title ? "conversation-row is-active" : "conversation-row"} type="button" key={title} onClick={() => openConversation(title)}>
                <MessageCircle size={16} />
                <span>{title}</span>
              </button>
            ))}
          </SidebarGroup>
        </div>

        <div className="profile-area">
          {profileOpen && (
            <div className="profile-menu" role="menu">
              <button role="menuitem" type="button"><UserRound size={16} /><span>个人资料</span></button>
              <button role="menuitem" type="button"><Columns2 size={16} /><span>使用情况</span></button>
              <button role="menuitem" type="button" onClick={onOpenSettings}><Settings size={16} /><span>系统设置</span><span className="profile-menu__meta">Ctrl+,</span></button>
              <div className="profile-menu__divider" />
              <button className="is-danger" role="menuitem" type="button"><LogOut size={16} /><span>退出登录</span></button>
            </div>
          )}
          <button className="profile-trigger" type="button" onClick={onProfileToggle} aria-expanded={profileOpen}>
            <span className="avatar"><img src={userAvatar} alt="张伟的虚拟头像" /></span>
            <span className="profile-trigger__copy"><strong>张伟</strong><small>AI 项目负责人</small></span>
            <ChevronDown size={15} />
          </button>
        </div>
      </aside>
    </>
  );
}

function BrandMark() {
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

function SidebarGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sidebar-group">
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  );
}
