import {sectionNavigation,workbenchPages,procurementNavigationPage} from "../workbenchRegistry";
import { Archive, Pencil, Pin, PinOff, ArrowLeft, ChevronDown, ChevronUp, CircleHelp, ListFilter, LogOut, MessageCircle, MoreHorizontal, Plus, Search, Settings, SquarePen, UserRound, X,  } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HelpDialog } from "./HelpDialog";
import {WorkbenchOptionMenu} from './WorkbenchMenus';
import {useUnsavedChanges} from './Interaction';
import {Drawer} from './Drawer';
import type {ConversationUpdate} from '../types';
import {ProjectMark} from './ProjectMark';
import { PROCUREMENT_PAGE_LABELS, RESEARCH_PAGE_LABELS, SALES_PAGE_LABELS, type ResearchPage, type SalesPage, type Conversation, type CurrentUser, type ModuleVisibility, type ProcurementPage, type Project, type RuntimeEnvironment, type Section, type WorkbenchId } from "../types";

type SidebarProps = {
  currentUser: CurrentUser;
  activeSection: Section;
  selectedConversationId: string | null;
  currentProjectId: string | null;
  projects: Project[];
  projectSummaries: Record<string,{conversationCount:number|null;taskCount:number|null;runningCount:number|null}>;
  conversations: Conversation[];
  dataState: "loading" | "ready" | "error";
  enabledModules: ModuleVisibility;
  environment: RuntimeEnvironment | null;
  openedWorkbenchId: WorkbenchId | null;
  salesPage: SalesPage;
  onSalesPageChange: (page: SalesPage) => void;
  researchPage: ResearchPage;
  onResearchPageChange: (page: ResearchPage) => void;
  procurementPage: ProcurementPage;
  onProcurementPageChange: (page: ProcurementPage) => void;
  onSectionChange: (section: Section) => void;
  onNewConversation: () => void;
  onConversationOpen: (conversationId: string) => void;
  onConversationUpdate:(row:Conversation,changes:ConversationUpdate)=>Promise<boolean>;
  onProjectCreate: () => void;
  onProjectOpen: (id:string) => void;
  onProjectNewConversation: (id:string) => void;
  onDataRetry:()=>void;
  onSearchOpen: () => void;
  onFeedbackOpen: () => void;
  feedbackUnread: number | null;
  profileOpen: boolean;
  onProfileToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  onOpenSettings: () => void;
  onOpenArchived: () => void;
  onOpenProfile: () => void;
  onLogout: () => Promise<void>;
};

const navItems=sectionNavigation;
const procurementPages=workbenchPages.procurement;

export function Sidebar({
  currentUser,
  activeSection,
  selectedConversationId,
  currentProjectId,
  projects,
  projectSummaries,
  conversations,
  dataState,
  enabledModules,
  environment,
  openedWorkbenchId,
  salesPage,
  onSalesPageChange,
  researchPage,
  onResearchPageChange,
  procurementPage,
  onProcurementPageChange,
  onSectionChange,
  onNewConversation,
  onConversationOpen,
  onConversationUpdate,
  onProjectCreate,
  onProjectOpen,
  onProjectNewConversation,
  onDataRetry,
  onSearchOpen,
  onFeedbackOpen,
  feedbackUnread,
  profileOpen,
  onProfileToggle,
  mobileOpen,
  onMobileClose,
  onOpenSettings,
  onOpenArchived,
  onOpenProfile,
  onLogout,
}: SidebarProps) {
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [fullProjects, setFullProjects] = useState<string[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  const [recentFilter, setRecentFilter] = useState('all');
  const [helpOpen, setHelpOpen] = useState(false);
  const [renaming,setRenaming]=useState<Conversation|null>(null);
  const [name,setName]=useState('');
  const [busy,setBusy]=useState<string|null>(null);
  const [actionError,setActionError]=useState('');
  const navigation=useRef<HTMLElement>(null);
  const navigationFocus=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const node=navigation.current;if(!node)return;
    const media=window.matchMedia('(max-width: 760px)');
    if(mobileOpen&&media.matches)navigationFocus.current=document.activeElement as HTMLElement;
    const update=()=>{
      const focused=node.contains(document.activeElement);
      node.inert=media.matches&&!mobileOpen;
      if(node.inert&&focused){
        const target=navigationFocus.current;
        if(target?.isConnected&&!node.contains(target))target.focus();
        else document.querySelector<HTMLElement>('.mobile-nav-trigger')?.focus();
      }
    };
    update();
    if(mobileOpen&&media.matches)node.querySelector<HTMLElement>('.sidebar__close')?.focus();
    media.addEventListener('change',update);
    return()=>media.removeEventListener('change',update);
  },[mobileOpen]);
  const renameLeave=useUnsavedChanges(Boolean(renaming&&name.trim()!==renaming.title),busy!==null,'关闭后，本次未保存的会话名称将不会保留。');
  const update=async(row:Conversation,changes:ConversationUpdate)=>{
    if(busy)return false;
    setBusy(row.id);setActionError('');
    try{return await onConversationUpdate(row,changes);}
    catch{setActionError('操作结果未确认，已重新读取列表，请核对后重试。');return false;}
    finally{setBusy(null);}
  };

  useEffect(() => {
    if (currentProjectId) setCollapsedProjects(current=>current.filter(id=>id!==currentProjectId));
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

  const recentConversations = [...conversations].reverse().filter(row=>!row.archived);
  const pinnedConversations = recentConversations.filter(row=>row.pinned);
  const filteredRecent = recentConversations.filter(row=>!row.pinned&&(recentFilter==='all'||row.mode===recentFilter));
  const filterMenu=<WorkbenchOptionMenu side="right" label="会话筛选" value={recentFilter} display={<ListFilter size={15}/>} className="ai-project-menu sidebar-header-menu" options={[{value:'all',label:'全部'},{value:'chat',label:'聊天'},{value:'work',label:'工作'}]} onSelect={setRecentFilter}/>;

  const conversationRow=(row:Conversation,project=false)=><div className="sidebar-conversation" key={row.id}>
    <button className={`${project?'project-thread':'conversation-row'}${activeSection==='chat'&&selectedConversationId===row.id?' is-active':''}`} type="button" onClick={()=>openConversation(row.id)}>
      <ScrollingTitle>{row.title}</ScrollingTitle>
    </button>
    {row.owner_id===currentUser.id&&<div className="sidebar-conversation-actions"><WorkbenchOptionMenu side="right" label={`${row.title}会话操作`} value="" display={<MoreHorizontal size={15}/>} className="ai-project-menu sidebar-conversation-menu"
      options={[{value:'rename',label:'重命名',icon:<Pencil size={14}/>,disabled:busy!==null},{value:'pin',label:row.pinned?'取消置顶':'置顶',icon:row.pinned?<PinOff size={14}/>:<Pin size={14}/>,disabled:busy!==null},{value:'archive',label:'归档',icon:<Archive size={14}/>,disabled:busy!==null}]}
      onSelect={value=>{if(value==='rename'){setRenaming(row);setName(row.title);setActionError('');}else void update(row,value==='pin'?{pinned:!row.pinned}:{archived:true});}}/>
      <button className="sidebar-conversation-pin" type="button" aria-label={`${row.pinned?'取消置顶':'置顶'}会话：${row.title}`} title={row.pinned?'取消置顶':'置顶'} aria-pressed={Boolean(row.pinned)} disabled={busy!==null} onClick={()=>void update(row,{pinned:!row.pinned})}>{row.pinned?<PinOff size={14}/>:<Pin size={14}/>}</button>
    </div>}
  </div>;

  return (
    <>
      {mobileOpen && <button className="sidebar-backdrop" type="button" aria-label="关闭导航" onClick={onMobileClose} />}
      <aside ref={navigation} className={mobileOpen ? "sidebar is-mobile-open" : "sidebar"}>
        <div className="sidebar__brand">
          <div className="brand-button">
            <BrandMark />
            <span className="brand-button__label">宏昊化工</span>
            {environment === "test" && <span className="environment-badge">测试</span>}
          </div>
          <div className="sidebar__brand-actions">
            <button className="icon-button sidebar__search" type="button" aria-label="全局搜索" onClick={onSearchOpen}><Search size={18} /></button>
            <button className="icon-button sidebar-feedback" type="button" title={feedbackUnread === null ? "意见反馈 · 未读状态暂不可用" : "意见反馈"} aria-label={`意见反馈${feedbackUnread ? `，${feedbackUnread} 条未读` : ""}`} onClick={onFeedbackOpen}><MessageCircle size={18} />{feedbackUnread !== null && feedbackUnread > 0 && <span className="feedback-badge">{feedbackUnread > 99 ? "99+" : feedbackUnread}</span>}</button>
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
              <span>{id === "workbench" && openedWorkbenchId ? "返回主页" : label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar__scroll">
          {activeSection === "workbench" && openedWorkbenchId === "procurement" && (
            <SidebarGroup title="采购工作台">
              {procurementPages.map(({ id, icon: Icon }) => (
                <button className={procurementNavigationPage(procurementPage) === id ? "workbench-page-row is-active" : "workbench-page-row"} type="button" key={id} aria-current={procurementNavigationPage(procurementPage) === id ? "page" : undefined} onClick={() => openProcurementPage(id)}>
                  <Icon size={15} strokeWidth={1.7} />
                  <span>{PROCUREMENT_PAGE_LABELS[id]}</span>
                </button>
              ))}
            </SidebarGroup>
          )}
          {activeSection === "workbench" && openedWorkbenchId === "research" && <SidebarGroup title="研发工作台">{workbenchPages.research.map(({id,icon:Icon}) => {
            return <button className={`workbench-page-row${researchPage === id ? " is-active" : ""}`} type="button" key={id} aria-current={researchPage === id ? "page" : undefined} onClick={() => { onResearchPageChange(id); onMobileClose(); }}><Icon size={15} strokeWidth={1.7} /><span>{RESEARCH_PAGE_LABELS[id]}</span></button>;
          })}</SidebarGroup>}
          {activeSection === "workbench" && openedWorkbenchId === "sales" && <SidebarGroup title="销售工作台">{workbenchPages.sales.map(({id,icon:Icon}) => { return <button className={`workbench-page-row${salesPage === id ? " is-active" : ""}`} type="button" key={id} aria-current={salesPage === id ? "page" : undefined} onClick={() => { onSalesPageChange(id); onMobileClose(); }}><Icon size={15} aria-hidden="true"/><span>{SALES_PAGE_LABELS[id]}</span></button>; })}</SidebarGroup>}
          {enabledModules.chat && <>
            {pinnedConversations.length>0&&<SidebarGroup title="置顶">{pinnedConversations.map(row=>conversationRow(row))}</SidebarGroup>}
            <SidebarGroup title="项目" expanded={projectsOpen} onToggle={()=>setProjectsOpen(open=>!open)} action={<div className="sidebar-header-actions"><WorkbenchOptionMenu label="项目列表操作" value="" display={<MoreHorizontal size={15}/>} className="ai-project-menu sidebar-header-menu" options={[{value:'expand',label:'展开全部项目'},{value:'collapse',label:'收起全部项目'}]} onSelect={value=>{setProjectsOpen(true);setCollapsedProjects(value==='collapse'?projects.map(project=>project.id):[]);}}/><button className="sidebar-group__action" type="button" aria-label="新建项目" onClick={onProjectCreate}><Plus size={14} /></button></div>}>
            {dataState === "loading" && !projects.length && <p className="sidebar-empty">正在加载项目…</p>}
            {dataState === "error" && <p className="sidebar-empty sidebar-empty--error">项目刷新失败<button type="button" className="secondary-button" onClick={onDataRetry}>重试项目列表</button></p>}
            {dataState === "ready" && projects.length === 0 && <p className="sidebar-empty">暂无项目</p>}
            {projects.map((project) => {
              const expanded = !collapsedProjects.includes(project.id);
              const relatedConversations = recentConversations.filter((conversation) => conversation.project_id === project.id);
              const full=fullProjects.includes(project.id);
              return (
                <div className="project-entry" key={project.id}>
                  <div className="ai-project-nav-row">
                  <button className={expanded ? "project-row is-expanded" : "project-row"} type="button" aria-expanded={expanded} onClick={() => setCollapsedProjects(current=>expanded?[...current,project.id]:current.filter(id=>id!==project.id))}>
                    <ProjectMark icon={project.icon} color={project.color}/>
                    <ScrollingTitle>{project.title}</ScrollingTitle>
                  </button>
                  <div className="ai-project-nav-actions">
                    <WorkbenchOptionMenu label={`${project.title}项目操作`} value="" display={<MoreHorizontal size={16}/>} className="ai-project-menu"
                      header={<div className="ai-project-menu-summary"><strong><ProjectMark icon={project.icon} color={project.color}/>{project.title}</strong>
                        <p>{projectSummaries[project.id]?.conversationCount??'—'} 个会话 · {projectSummaries[project.id]?.taskCount==null?'任务暂不可用':`${projectSummaries[project.id].taskCount} 个任务`}
                          {Boolean(projectSummaries[project.id]?.runningCount)&&` · ${projectSummaries[project.id].runningCount} 个运行中`}</p></div>}
                      options={[{value:'details',label:project.owner_id===currentUser.id?'编辑项目':'项目详情'}]} onSelect={()=>{onProjectOpen(project.id);onMobileClose();}}/>
                    {project.owner_id===currentUser.id&&<button className="sidebar-group__action" type="button" aria-label={`在${project.title}中新建会话`} title="新建会话"
                      onClick={()=>{onProjectNewConversation(project.id);onMobileClose();}}><SquarePen size={15}/></button>}
                  </div>
                  </div>
                  {expanded && (
                    <div className="project-thread-list">
                      {relatedConversations.length === 0 && <p className="sidebar-empty sidebar-empty--nested">暂无关联会话</p>}
                      {(full?relatedConversations:relatedConversations.slice(0,5)).map(row=>conversationRow(row,true))}
                      {relatedConversations.length>5&&<button className="sidebar-show-more" type="button" aria-label={`${full?'收起':'展开显示'}${project.title}会话`} onClick={()=>setFullProjects(current=>full?current.filter(id=>id!==project.id):[...current,project.id])}>{full?'收起显示':'展开显示'}</button>}
                    </div>
                  )}
                </div>
              );
            })}
            </SidebarGroup>
            <SidebarGroup title="最近" expanded={recentOpen} onToggle={()=>setRecentOpen(open=>!open)} action={<div className="sidebar-header-actions"><WorkbenchOptionMenu side="right" label="最近列表操作" value="" display={<MoreHorizontal size={15}/>} className="ai-project-menu sidebar-header-menu" options={[{value:'archived',label:'已归档会话'}]} onSelect={onOpenArchived}/>{filterMenu}<button className="sidebar-group__action" type="button" aria-label="开启新聊天" title="新聊天" onClick={onNewConversation}><SquarePen size={15}/></button></div>}>
            {dataState === "ready" && filteredRecent.length === 0 && <p className="sidebar-empty">{recentFilter==='chat'?'暂无聊天会话':recentFilter==='work'?'暂无工作会话':'暂无会话'}</p>}
            {filteredRecent.map(row=>conversationRow(row))}
            {actionError&&!renaming&&<p role="alert" className="sidebar-empty sidebar-empty--error">{actionError}</p>}
            </SidebarGroup>
          </>}
        </div>

        <div className="profile-area">
          {profileOpen && (
            <div className="profile-menu" role="menu">
              <button role="menuitem" type="button" onClick={onOpenProfile}><UserRound size={16} /><span>我的账号</span></button>
              <button role="menuitem" type="button" onClick={onOpenSettings}><Settings size={16} /><span>系统设置</span><span className="profile-menu__meta">Ctrl+,</span></button>
              <div className="profile-menu__divider" />
              <button className="is-danger" role="menuitem" type="button" onClick={() => void onLogout()}><LogOut size={16} /><span>退出登录</span></button>
            </div>
          )}
          <div className="profile-footer-actions"><button className="profile-trigger" type="button" onClick={onProfileToggle} aria-expanded={profileOpen}>
            <span className="avatar" aria-hidden="true">{Array.from(currentUser.display_name)[0]}</span>
            <span className="profile-trigger__copy"><strong>{currentUser.display_name}</strong><small>{currentUser.department ?? (currentUser.is_system_admin ? "系统管理员" : "企业用户")}</small></span>
            {profileOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </button><button className="icon-button help-trigger" type="button" aria-label="使用说明" title="使用说明" onClick={() => { if (profileOpen) onProfileToggle(); setHelpOpen(true); }}><CircleHelp size={17} /></button></div>
        </div>
      </aside>
      {renaming&&<Drawer title="重命名会话" busy={busy!==null} beforeClose={renameLeave.request} onClose={()=>setRenaming(null)}>
        <form className="sidebar-rename-form" onSubmit={async event=>{event.preventDefault();const current=conversations.find(row=>row.id===renaming.id)??renaming;if(current.revision!==renaming.revision){setRenaming(current);setActionError(`当前名称：${current.title}。名称已更新，提议已保留；请核对后再次保存。`);return;}if(await update(renaming,{title:name.trim()}))setRenaming(null);}}>
          <label>会话名称<input required maxLength={200} value={name} onChange={event=>setName(event.target.value)} disabled={busy!==null}/></label>
          {actionError&&<p role="alert">{actionError}</p>}
          <button className="primary-button" type="submit" disabled={busy!==null||!name.trim()}>{busy?'正在保存…':'保存名称'}</button>
        </form>
      </Drawer>}
      {renameLeave.confirmation}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
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

function SidebarGroup({ title, children, action, expanded=true, onToggle }: { title: string; children: React.ReactNode; action?: React.ReactNode; expanded?:boolean; onToggle?:()=>void }) {
  return (
    <section className="sidebar-group">
      <header><h2>{onToggle?<button className="sidebar-group__toggle" type="button" aria-label={`${expanded?'收起':'展开'}${title}`} aria-expanded={expanded} onClick={onToggle}>{title}<ChevronDown size={13}/></button>:title}</h2>{action}</header>
      <div hidden={!expanded}>{children}</div>
    </section>
  );
}

function ScrollingTitle({ children }: { children: string }) {
  return (
    <span className="sidebar-scrolling-title" title={children} onPointerEnter={event=>{
      const node=event.currentTarget;const distance=Math.max(0,(node.firstElementChild?.scrollWidth??0)-node.clientWidth);
      node.style.setProperty('--title-scroll-duration',`${Math.max(3000,distance/24*1000)}ms`);
    }}>
      <span className="sidebar-scrolling-title__text">{children}</span>
    </span>
  );
}
