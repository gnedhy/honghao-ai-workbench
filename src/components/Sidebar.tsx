import {
  Bot,
  ChevronDown,
  Columns2,
  FolderKanban,
  LibraryBig,
  LogOut,
  Menu,
  MessageCircle,
  PenLine,
  Pin,
  Search,
  Settings,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";
import { pinnedConversations, recentConversations } from "../data";
import type { Section } from "../types";

type SidebarProps = {
  activeSection: Section;
  onSectionChange: (section: Section) => void;
  profileOpen: boolean;
  onProfileToggle: () => void;
  mobileOpen: boolean;
  onMobileToggle: () => void;
  onOpenSettings: () => void;
};

const navItems = [
  { id: "chat", label: "新聊天", icon: PenLine },
  { id: "knowledge", label: "知识", icon: LibraryBig },
  { id: "automation", label: "自动化", icon: WandSparkles },
  { id: "tasks", label: "任务看板", icon: FolderKanban },
] as const;

export function Sidebar({
  activeSection,
  onSectionChange,
  profileOpen,
  onProfileToggle,
  mobileOpen,
  onMobileToggle,
  onOpenSettings,
}: SidebarProps) {
  const selectSection = (section: Section) => {
    onSectionChange(section);
    onMobileToggle();
  };

  return (
    <>
      <button className="mobile-menu-button icon-button" type="button" onClick={onMobileToggle} aria-label="打开导航">
        <Menu size={19} />
      </button>
      {mobileOpen && <button className="sidebar-backdrop" type="button" aria-label="关闭导航" onClick={onMobileToggle} />}
      <aside className={mobileOpen ? "sidebar is-mobile-open" : "sidebar"}>
        <div className="sidebar__brand">
          <button className="brand-button" type="button" aria-label="切换工作空间">
            <span className="brand-mark" aria-hidden="true">
              <span /><span /><span /><span />
            </span>
            <span>企业 AI</span>
            <ChevronDown size={14} />
          </button>
          <div className="sidebar__brand-actions">
            <button className="icon-button" type="button" aria-label="搜索"><Search size={18} /></button>
            <button className="icon-button sidebar__close" type="button" aria-label="关闭导航" onClick={onMobileToggle}><X size={18} /></button>
          </div>
        </div>

        <nav className="primary-nav" aria-label="主要导航">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              className={activeSection === id && id !== "chat" ? "nav-row is-active" : "nav-row"}
              key={id}
              type="button"
              aria-current={activeSection === id && id !== "chat" ? "page" : undefined}
              onClick={() => selectSection(id)}
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
                className={activeSection === "chat" && index === 0 ? "conversation-row is-active" : "conversation-row"}
                type="button"
                key={title}
                onClick={() => selectSection("chat")}
              >
                {index === 0 ? <Bot size={16} /> : <Columns2 size={16} />}
                <span>{title}</span>
                <Pin size={14} />
              </button>
            ))}
          </SidebarGroup>
          <SidebarGroup title="最近">
            {recentConversations.map((title) => (
              <button className="conversation-row" type="button" key={title} onClick={() => selectSection("chat")}>
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
              <button role="menuitem" type="button"><Columns2 size={16} /><span>使用情况</span><span className="profile-menu__meta">剩余 67%</span></button>
              <button role="menuitem" type="button" onClick={onOpenSettings}><Settings size={16} /><span>系统设置</span><span className="profile-menu__meta">Ctrl+,</span></button>
              <div className="profile-menu__divider" />
              <button className="is-danger" role="menuitem" type="button"><LogOut size={16} /><span>退出登录</span></button>
            </div>
          )}
          <button className="profile-trigger" type="button" onClick={onProfileToggle} aria-expanded={profileOpen}>
            <span className="avatar">张</span>
            <span className="profile-trigger__copy"><strong>张伟</strong><small>AI 项目负责人</small></span>
            <ChevronDown size={15} />
          </button>
        </div>
      </aside>
    </>
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
