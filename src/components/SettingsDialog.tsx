import {
  Check,
  ChevronRight,
  ChevronLeft,
  Columns3,
  CircleUserRound,
  ClipboardList,
  FolderKanban,
  LibraryBig,
  Info,
  PanelsTopLeft,
  PenLine,
  Plus,
  ShieldCheck,
  Server,
  WandSparkles,
  X,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createUser,
  fetchAdminModuleSettings,
  fetchProcurementOverview,
  fetchAuditEvents,
  fetchUsers,
  fetchDepartments,
  deleteDepartment,
  updateAdminModuleSetting,
  updateAdminWorkbenchSetting,
  updateUser,
  updateUserProfile,
  type ServiceConnection,
} from "../api";
import type {
  AccessLevel,
  AccessScope,
  ActivationReview,
  AdminModuleSettings,
  AuditEvent,
  CurrentUser,
  ManagedUser,
  ModuleMode,
  ModuleStatus,
  RuntimeEnvironment,
  Section,
  WorkbenchId,
  WorkbenchStatus,
} from "../types";
import { ProcurementActivationGrants } from "../workbenches/ProcurementDistribution";
import procurementStyles from "../workbenches/ProcurementWorkbench.module.css";
import { DepartmentEditor, MembershipFields, OrganizationDirectory, departmentPath } from './OrganizationControls';
import type { OrganizationDepartment, DepartmentMembership } from '../types';

type SettingsTab = "general" | "accounts" | "audit" | "about";
export type UiFontSize = 1 | 2 | 3 | 4 | 5;

const UI_FONT_SIZES: { id: UiFontSize; label: string }[] = [
  { id: 1, label: "小" },
  { id: 2, label: "较小" },
  { id: 3, label: "标准" },
  { id: 4, label: "较大" },
  { id: 5, label: "大" },
];

const MODULE_OPTIONS = [
  { id: "chat", label: "新聊天", description: "对话、工作模式及会话侧栏", icon: PenLine },
  { id: "knowledge", label: "知识库", description: "个人与公共知识内容", icon: LibraryBig },
  { id: "automation", label: "自动化", description: "技能与工作流管理", icon: WandSparkles },
  { id: "workbench", label: "工作台", description: "企业职能业务工具", icon: PanelsTopLeft },
  { id: "tasks", label: "任务看板", description: "任务管理与运行记录", icon: FolderKanban },
] as const;

const WORKBENCH_OPTIONS: { id: WorkbenchId; label: string; description: string }[] = [
  { id: "management", label: "总经办工作台", description: "成本经营分析" },
  { id: "procurement", label: "采购工作台", description: "原料成本管理" },
  { id: "research", label: "研发工作台", description: "产品成本计算" },
  { id: "sales", label: "销售工作台", description: "产品报价管理" },
];

const ACCESS_LEVELS: { id: AccessLevel; label: string; summary: string }[] = [
  { id: 2, label: "查看", summary: "查看授权范围内的数据，不可修改。" },
  { id: 3, label: "编辑", summary: "包含查看权限，可新增和修改数据。" },
  { id: 4, label: "管理", summary: "包含编辑权限，可执行授权范围内的管理操作。" },
];

const ACCESS_SCOPES: { id: AccessScope; name: string }[] = [
  { id: "procurement", name: "采购工作台" },
  { id: "research", name: "研发工作台" },
  { id: "sales", name: "销售工作台" },
  { id: "management", name: "总经办工作台" },
  { id: "knowledge", name: "知识库" },
];

const AUDIT_LABELS: Record<string, string> = {
  "login.succeeded": "登录成功",
  "login.failed": "登录失败",
  "field.policy.updated": "修改敏感字段策略",
  "field.created": "新增敏感字段",
  "user.created": "创建账号",
  "user.updated": "修改账号",
  "user.profile.updated": "修改用户资料",
  "user.departments.updated": "调整人员部门归属",
  "department.created": "新增部门",
  "department.updated": "调整部门",
  "department.deleted": "删除部门",
  "password.reset": "管理员重置初始密码并退出账号会话",
  "password.changed": "本人修改密码并退出全部会话",
  "password.wrong": "修改密码：当前密码校验失败",
  "password.limited": "修改密码：触发尝试限制",
  "password.same": "修改密码：新旧密码相同",
  "module.mode.off": "关闭功能模块",
  "module.mode.prototype": "切换功能模块为原型",
  "module.mode.active": "启用功能模块",
  "workbench.mode.off": "关闭职能工作台",
  "workbench.mode.prototype": "切换职能工作台为原型",
  "workbench.mode.active": "启用职能工作台",
};

type SettingsDialogProps = {
  currentUser: CurrentUser;
  onUserChanged: (user: CurrentUser) => void;
  serviceConnection: ServiceConnection;
  moduleStatuses: ModuleStatus[];
  moduleRegistryState: "loading" | "ready" | "error";
  workbenchStatuses: WorkbenchStatus[];
  workbenchRegistryState: "loading" | "ready" | "error";
  uiFontSize: UiFontSize;
  onUiFontSizeChange: (size: UiFontSize) => void;
  onClose: () => void;
  onOpenProfile: () => void;
};

export function useFadingScrollbars(container: { current: HTMLElement | null }) {
  useEffect(() => {
    const body = container.current;
    if (!body) return;
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const edgeSelector = ".admin-user-scroll,.personal-profile__scroll";
    const updateEdges = () => {
      body.querySelectorAll<HTMLElement>(edgeSelector).forEach(element => {
        element.style.setProperty("--scroll-fade-top", element.scrollTop > 1 ? "14px" : "0px");
        element.style.setProperty("--scroll-fade-bottom", element.scrollHeight - element.clientHeight - element.scrollTop > 1 ? "14px" : "0px");
        element.style.setProperty("--scroll-gutter", `${Math.max(0, element.offsetWidth - element.clientWidth)}px`);
      });
    };
    const observed = new Set<Element>();
    const resize = new ResizeObserver(updateEdges);
    const observeEdges = () => {
      const targets = new Set<Element>();
      body.querySelectorAll(edgeSelector).forEach(element => { targets.add(element); Array.from(element.children).forEach(child => targets.add(child)); });
      observed.forEach(element => { if (!targets.has(element)) { resize.unobserve(element); observed.delete(element); } });
      targets.forEach(element => { if (!observed.has(element)) { resize.observe(element); observed.add(element); } });
      updateEdges();
    };
    const contentChanges = new MutationObserver(observeEdges);
    contentChanges.observe(body, { childList: true, subtree: true, characterData: true });
    observeEdges();
    body.addEventListener("scroll", updateEdges, true);
    const reveal = (event: Event) => {
      let element = event.target instanceof HTMLElement ? event.target : null;
      while (element && element !== body) {
        if (element.scrollHeight > element.clientHeight && /auto|scroll/.test(getComputedStyle(element).overflowY)) {
          clearTimeout(timers.get(element));
          element.dataset.scrolling = "true";
          const target = element;
          timers.set(target, setTimeout(() => { delete target.dataset.scrolling; timers.delete(target); }, 3000));
          break;
        }
        element = element.parentElement;
      }
    };
    body.addEventListener("scroll", reveal, true);
    body.addEventListener("wheel", reveal, { capture: true, passive: true });
    return () => {
      body.removeEventListener("scroll", updateEdges, true);
      resize.disconnect();
      contentChanges.disconnect();
      body.removeEventListener("scroll", reveal, true);
      body.removeEventListener("wheel", reveal, true);
      timers.forEach((timer, element) => { clearTimeout(timer); delete element.dataset.scrolling; });
    };
  }, [container]);
}

export function SettingsDialog({ currentUser, onUserChanged, serviceConnection, moduleStatuses, moduleRegistryState, workbenchStatuses, workbenchRegistryState, uiFontSize, onUiFontSizeChange, onClose, onOpenProfile }: SettingsDialogProps) {
  const scrollBody = useRef<HTMLDivElement>(null);
  useFadingScrollbars(scrollBody);
  const isAdmin = currentUser.is_system_admin;
  const [tab, setTab] = useState<SettingsTab>("general");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [adminModuleSettings, setAdminModuleSettings] = useState<AdminModuleSettings | null>(null);
  const [notice, setNotice] = useState("");
  const [canManageGrants, setCanManageGrants] = useState(false);
  const procurementEnabled = moduleRegistryState === "ready" && workbenchRegistryState === "ready"
    && moduleStatuses.some((item) => item.id === "workbench" && item.mode === "active")
    && workbenchStatuses.some((item) => item.id === "procurement" && item.mode === "active");

  useEffect(() => {
    setCanManageGrants(false);
    if (!procurementEnabled) return;
    const controller = new AbortController();
    void fetchProcurementOverview(controller.signal)
      .then((data) => { if (!controller.signal.aborted) setCanManageGrants(Boolean(data.capabilities?.can_manage_grants)); })
      .catch(() => { if (!controller.signal.aborted) setCanManageGrants(false); });
    return () => controller.abort();
  }, [procurementEnabled, currentUser.id]);
  const [newUserOpen, setNewUserOpen] = useState(false);
  const emptyUser = () => ({ username: '', display_name: '', primary_department_id: null as string | null, additional_department_ids: [] as string[], password: '123456', is_system_admin: false, scope_levels: {} as Partial<Record<AccessScope, AccessLevel>> });
  const [newUser, setNewUser] = useState(emptyUser);
  const [departments, setDepartments] = useState<OrganizationDepartment[]>([]);
  const [departmentToDelete, setDepartmentToDelete] = useState<string | null>(null);
  const [departmentError, setDepartmentError] = useState("");
  const [departmentEdit, setDepartmentEdit] = useState<{ id: string | null; parent: string | null } | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [userAdminDraft, setUserAdminDraft] = useState(false);
  const [userScopeDraft, setUserScopeDraft] = useState<Partial<Record<AccessScope, AccessLevel>>>({});

  useEffect(() => {
    if (!isAdmin) return;
    setLoadState("loading");
    Promise.all([fetchUsers(), fetchAuditEvents(), fetchAdminModuleSettings(), fetchDepartments()])
      .then(([loadedUsers, loadedEvents, loadedModuleSettings, loadedDepartments]) => {
        setDepartments(loadedDepartments);
        setUsers(loadedUsers);
        setAuditEvents(loadedEvents);
        setAdminModuleSettings(loadedModuleSettings);
        setSelectedUserId(loadedUsers[0]?.id ?? "");
        setLoadState("ready");
      })
      .catch(() => setLoadState("error"));
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin || tab !== "audit" || loadState !== "ready") return;
    void fetchAuditEvents().then(setAuditEvents).catch(() => showNotice("审计日志刷新失败"));
  }, [isAdmin, loadState, tab]);

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;

  useEffect(() => {
    setUserAdminDraft(selectedUser?.is_system_admin ?? false);
    setUserScopeDraft(selectedUser?.scope_levels ?? {});
  }, [selectedUserId]);

  const accessRuntime = { moduleStatuses, moduleRegistryState, workbenchStatuses, workbenchRegistryState };

  const serviceCopy = serviceConnection.state === "online"
    ? { label: "已连接", detail: `API ${serviceConnection.health.api_version} · 运行状态正常` }
    : serviceConnection.state === "checking"
      ? { label: "连接中", detail: "正在检查本地 API 与数据库。" }
      : { label: "未连接", detail: "请启动本地 API 后刷新页面。" };
  const runtimeEnvironment = adminModuleSettings?.environment ?? (serviceConnection.state === "online" ? serviceConnection.health.environment : null);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2200);
  };

  const accessDirty = Boolean(selectedUser) && (userAdminDraft !== selectedUser!.is_system_admin
    || ACCESS_SCOPES.some(scope => userScopeDraft[scope.id] !== selectedUser!.scope_levels[scope.id]));
  const newUserDirty = newUserOpen && Boolean(newUser.username || newUser.display_name || newUser.primary_department_id || newUser.additional_department_ids.length || newUser.password !== '123456' || newUser.is_system_admin || Object.keys(newUser.scope_levels).length);
  const dirty = profileDirty || accessDirty || newUserDirty;
  const closeProfile = () => { setProfileOpen(false); setProfileDirty(false); setProfileRevision(value => value + 1); };
  const resetDrafts = () => {
    setUserAdminDraft(selectedUser?.is_system_admin ?? false);
    setUserScopeDraft(selectedUser?.scope_levels ?? {});
    closeProfile();
    setNewUser(emptyUser());
    setDepartmentEdit(null);
    setNewUserOpen(false);
  };
  const requestLeave = (action: () => void, changed = dirty, discard = resetDrafts) => {
    if (busy.current) return;
    if (changed) setPendingLeave(() => () => { discard(); action(); });
    else action();
  };
  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => { if (dirty || busy.current) event.preventDefault(); };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  const refreshOrganization = async () => {
    const [loadedDepartments, loadedUsers] = await Promise.all([fetchDepartments(), fetchUsers()]);
    setDepartments(loadedDepartments); setUsers(loadedUsers);
    const me = loadedUsers.find(u => u.id === currentUser.id); if (me) onUserChanged(me);
  };

  const submitUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true; setSaving(true);
    try {
      const created = await createUser({ ...newUser, scope_levels: newUser.is_system_admin ? {} : newUser.scope_levels });
      setUsers((current) => [...current, created]);
      setNewUser(emptyUser());
      setNewUserOpen(false);
      setSelectedUserId(created.id);
      showNotice("账号已创建");
    } catch {
      showNotice("账号信息有误或账号名已存在");
    } finally { busy.current = false; setSaving(false); }
  };

  const saveUserAccess = async () => {
    if (!selectedUser || busy.current || !accessDirty) return;
    busy.current = true; setSaving(true);
    try {
      const updated = await updateUser(selectedUser.id, { is_system_admin: userAdminDraft, scope_levels: userAdminDraft ? {} : userScopeDraft });
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      setUserAdminDraft(updated.is_system_admin); setUserScopeDraft(updated.scope_levels);
      showNotice("工作台与功能权限已更新，原登录会话已失效");
    } catch {
      showNotice(selectedUser.id === currentUser.id ? "不能移除当前管理员自己的系统权限" : "账号授权更新失败");
    } finally { busy.current = false; setSaving(false); }
  };

  const toggleUserActive = async () => {
    if (!selectedUser || selectedUser.id === currentUser.id || busy.current) return;
    busy.current = true; setSaving(true);
    try {
      const updated = await updateUser(selectedUser.id, { is_active: !selectedUser.is_active });
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      showNotice(updated.is_active ? "账号已启用" : "账号已停用");
    } catch {
      showNotice("账号状态更新失败");
    } finally { busy.current = false; setSaving(false); }
  };

  const saveModuleMode = async (moduleId: Section, mode: ModuleMode, reviews: ActivationReview[] = [], issueUrl?: string, pullRequestUrl?: string) => {
    try {
      const updated = await updateAdminModuleSetting(moduleId, mode, reviews, issueUrl, pullRequestUrl);
      setAdminModuleSettings((current) => current ? { ...current, modules: current.modules.map((module) => module.id === updated.id ? updated : module) } : current);
      showNotice(updated.current_mode === updated.pending_mode ? "模块状态未变化" : "已保存，重启服务后生效");
    } catch {
      showNotice("模块状态保存失败");
      throw new Error("Module mode update failed");
    }
  };

  const saveWorkbenchMode = async (workbenchId: WorkbenchId, mode: ModuleMode, reviews: ActivationReview[] = [], issueUrl?: string, pullRequestUrl?: string) => {
    try {
      const updated = await updateAdminWorkbenchSetting(workbenchId, mode, reviews, issueUrl, pullRequestUrl);
      setAdminModuleSettings((current) => current ? { ...current, workbenches: current.workbenches.map((workbench) => workbench.id === updated.id ? updated : workbench) } : current);
      showNotice(updated.current_mode === updated.pending_mode ? "工作台状态未变化" : "已保存，重启服务后生效");
    } catch {
      showNotice("工作台状态保存失败");
      throw new Error("Workbench mode update failed");
    }
  };

  const navItems: { id: SettingsTab; label: string; icon: typeof CircleUserRound }[] = [
    { id: "general", label: "常规设置", icon: PanelsTopLeft },
    ...(isAdmin ? [
      { id: "accounts" as const, label: "用户管理", icon: CircleUserRound },
      { id: "audit" as const, label: "审计日志", icon: ClipboardList },
    ] : []),
    { id: "about", label: "关于系统", icon: Info },
  ];

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) requestLeave(onClose); }}>
      <section className="settings-dialog settings-dialog--admin" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (pendingLeave) setPendingLeave(null); else requestLeave(onClose); } }}>
        <header><div><h1 id="settings-title">系统设置</h1><p>{isAdmin ? "管理账号、访问边界和安全记录。" : "查看当前系统运行状态。"}</p></div><button className="icon-button" type="button" aria-label="关闭设置" disabled={saving} onClick={() => requestLeave(onClose)}><X size={18} /></button></header>
        <div className="settings-dialog__body" ref={scrollBody}>
          <nav aria-label="设置分类">{navItems.map(({ id, label, icon: Icon }) => <button className={tab === id ? "is-active" : ""} key={id} type="button" disabled={saving} onClick={() => { if (id !== tab) requestLeave(() => { resetDrafts(); setTab(id); }); }}><span><Icon size={15} />{label}</span><ChevronRight size={15} /></button>)}</nav>
          <article className={tab === "accounts" ? "settings-accounts-content" : tab === "audit" || tab === "about" ? "settings-log-content" : undefined}>
            {departmentToDelete && <DiscardChangesDialog title="删除部门？" description={<>将删除“{departments.find(d => d.id === departmentToDelete)?.name}”。仅可删除没有人员或子部门的空部门。{departmentError && <span role="alert" className="login-error">{departmentError}</span>}</>} cancelLabel="取消" confirmLabel="删除部门" disabled={saving} onCancel={() => { if (!busy.current) { setDepartmentToDelete(null); setDepartmentError(""); } }} onDiscard={async () => { if (busy.current) return; busy.current = true; setSaving(true); setDepartmentError(""); try { await deleteDepartment(departmentToDelete); setDepartmentToDelete(null); showNotice("部门已删除"); try { await refreshOrganization(); } catch { showNotice("部门已删除，列表刷新失败，请重新打开设置"); } } catch (error) { setDepartmentError(error instanceof Error ? error.message : "删除失败，请重试"); } finally { busy.current = false; setSaving(false); } }} />}
            {pendingLeave && <DiscardChangesDialog onCancel={() => setPendingLeave(null)} onDiscard={() => { const action = pendingLeave; setPendingLeave(null); action(); }} />}
            {notice && <div className="settings-notice" role="status"><Check size={14} />{notice}</div>}
            {tab === "general" && <><FontSizeSetting value={uiFontSize} onChange={onUiFontSizeChange} /><GeneralSettings serviceCopy={serviceCopy} environment={runtimeEnvironment} moduleStatuses={moduleStatuses} moduleRegistryState={moduleRegistryState} workbenchStatuses={workbenchStatuses} workbenchRegistryState={workbenchRegistryState} isAdmin={isAdmin} adminModuleSettings={adminModuleSettings} onModeChange={saveModuleMode} onWorkbenchModeChange={saveWorkbenchMode} canManageGrants={canManageGrants} onGrantsChanged={() => showNotice("授权已更新")} /></>}
            {(tab === "accounts" || tab === "audit") && loadState === "loading" && <SettingsState copy="正在读取管理数据…" />}
            {(tab === "accounts" || tab === "audit") && loadState === "error" && <SettingsState copy="管理数据暂时无法读取，请稍后重试。" error />}
            {tab === "accounts" && loadState === "ready" && <section className="admin-settings-section">
              <div className="admin-section-heading"><div><h2>用户管理</h2><p>在一个入口管理账号资料、工作台访问与操作权限。</p></div><button className="secondary-button" type="button" disabled={saving} onClick={() => requestLeave(() => { resetDrafts(); setNewUserOpen(true); })}><Plus size={14} />新建账号</button></div>
              {newUserOpen && <form className="admin-create-form" onSubmit={submitUser}><fieldset className="admin-edit-fields" disabled={saving}><div className="admin-detail-heading"><h3>新建账号</h3><span className="admin-dirty">{newUserDirty ? "未保存" : "填写账号资料"}</span></div><div className="admin-form-grid"><label>姓名<input required maxLength={100} value={newUser.display_name} onChange={(event) => setNewUser({ ...newUser, display_name: event.target.value })} /></label><label>账号名<input required maxLength={100} pattern="[A-Za-z0-9._-]+" autoComplete="off" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} /></label><label>初始密码（默认 123456）<input required pattern="123456|.{12,1000}" title="使用默认初始密码，或设置至少12个字符的自定义密码" maxLength={1000} type="password" autoComplete="new-password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} /></label></div><MembershipFields departments={departments} value={newUser} onChange={membership => setNewUser({ ...newUser, ...membership })} disabled={saving} /><AccountAccessEditor id="new-user-access" runtime={accessRuntime} dirty={newUserDirty} isSystemAdmin={newUser.is_system_admin} scopeLevels={newUser.scope_levels} onAdminChange={(is_system_admin) => setNewUser({ ...newUser, is_system_admin })} onScopeLevelChange={(scopeId, level) => setNewUser({ ...newUser, scope_levels: setScopeLevel(newUser.scope_levels, scopeId, level) })} /><div className="admin-form-actions"><button type="button" className="secondary-button" onClick={resetDrafts}>取消</button><button type="submit" className="primary-button">{saving ? "正在创建…" : "创建账号"}</button></div></fieldset></form>}
              {!newUserOpen && <div className="admin-split">
                <OrganizationDirectory departments={departments} users={users} selectedId={departmentEdit ? '' : selectedUserId} disabled={saving}
                  onSelect={id => { if (id !== selectedUserId || departmentEdit) requestLeave(() => { resetDrafts(); setSelectedUserId(id); }); }}
                  onDepartment={(id, parent) => requestLeave(() => { resetDrafts(); setDepartmentEdit({ id, parent }); })}
                  onDelete={id => requestLeave(() => { resetDrafts(); setDepartmentToDelete(id); })}
                  renderUser={(user, extra) => <><span className="org-user-name"><strong title={user.display_name}>{user.display_name}</strong>{user.is_system_admin && <span className="org-person-tag" title="系统管理员">管理员</span>}{extra && <span className="org-person-tag">兼属</span>}</span><i data-active={user.is_active}>{user.is_active ? "启用" : "停用"}</i></>} />
                <div className="admin-detail-panel">{departmentEdit ? <DepartmentEditor key={(departmentEdit.id || "new") + ":" + departmentEdit.parent} departments={departments} {...departmentEdit} disabled={saving} onDirty={setProfileDirty} onSaving={value => { busy.current = value; setSaving(value); }} onCancel={resetDrafts} onSaved={async () => { resetDrafts(); showNotice("部门已保存"); try { await refreshOrganization(); } catch { showNotice("部门已保存，列表刷新失败，请重新打开设置"); } }} /> : selectedUser ? <>
                  <div className="admin-detail-heading"><div className="admin-person-identity"><span className="admin-user-mark admin-detail-avatar" aria-hidden="true">{Array.from(selectedUser.display_name)[0]}</span><div><h3 className="admin-person-name">{selectedUser.display_name}{!profileOpen && <button className="admin-edit-pencil" type="button" aria-label="编辑资料与部门" title="编辑资料与部门" disabled={saving} onClick={() => requestLeave(() => { resetDrafts(); setProfileOpen(true); })}><PenLine size={14} /></button>}</h3><p>@{selectedUser.username} · {departmentPath(departments, selectedUser.primary_department_id || null)}</p>{!!selectedUser.additional_department_ids?.length && <p>兼属：{selectedUser.additional_department_ids.map(id => departmentPath(departments, id)).join("、")}</p>}</div></div><div className="admin-detail-heading-actions"><span className="status-chip" data-active={selectedUser.is_active}>{selectedUser.is_active ? "使用中" : "已停用"}</span></div></div>
                  <div className="admin-user-scroll" key={selectedUser.id} tabIndex={0} role="region" aria-label="账号资料与访问权限">
                  {profileOpen && <UserProfileEditor departments={departments} key={selectedUser.id + ":" + profileRevision} user={selectedUser} disabled={saving} onDirty={setProfileDirty} onSaving={value => { busy.current = value; setSaving(value); }} onCancel={closeProfile} onSaved={updated => { setUsers(current => current.map(user => user.id === updated.id ? updated : user)); if (updated.id === currentUser.id) onUserChanged(updated); closeProfile(); showNotice("资料已保存"); }} />}
                  {!profileOpen && <><h3 className="settings-section-label settings-permissions-title" id="account-access-title">访问权限 <AccessPolicyHelp /></h3>
                  <fieldset aria-labelledby="account-access-title" className="admin-edit-fields admin-access-section" disabled={saving}>
                    <AccountAccessEditor key={selectedUser.id} id="user-access" runtime={accessRuntime} dirty={accessDirty} isSystemAdmin={userAdminDraft} scopeLevels={userScopeDraft} onAdminChange={setUserAdminDraft} onScopeLevelChange={(scopeId, level) => setUserScopeDraft(current => setScopeLevel(current, scopeId, level))} disabledAdmin={selectedUser.id === currentUser.id}>
                    {accessDirty && <div className="admin-form-actions account-access-actions"><span className="admin-dirty">授权有未保存修改</span><button className="secondary-button" type="button" onClick={() => { setUserAdminDraft(selectedUser.is_system_admin); setUserScopeDraft({ ...selectedUser.scope_levels }); }}>取消</button><button className="primary-button" type="button" disabled={selectedUser.id === currentUser.id} onClick={saveUserAccess}>保存授权</button></div>}
                    </AccountAccessEditor>
                  </fieldset>
                  <h3 className="settings-section-label" id="account-status-title">账号状态</h3><section aria-labelledby="account-status-title" className="admin-account-status"><div><p>{selectedUser.id === currentUser.id ? "当前登录账号不可停用或修改自身授权。" : selectedUser.is_active ? "停用后无法登录，已有会话立即失效。" : "启用后可使用原有工作台与功能权限。"}</p></div><button className={selectedUser.is_active ? "secondary-button account-disable-button" : "secondary-button"} type="button" disabled={saving || selectedUser.id === currentUser.id} onClick={toggleUserActive}>{selectedUser.is_active ? "停用账号" : "启用账号"}</button></section></>}
                  </div>
                </> : <SettingsState copy="请选择一个账号。" />}</div>
              </div>}
            </section>}
            {tab === "audit" && loadState === "ready" && <AuditLog events={auditEvents} />}
            {tab === "about" && <AboutSystem connection={serviceConnection} />}
          </article>
        </div>
      </section>
    </div>
  );
}

const AUDIT_TYPES = [
  ["all", "全部类型"], ["security", "登录与安全"], ["accounts", "账号管理"],
  ["permissions", "权限配置"], ["modules", "模块与工作台"], ["other", "其他"],
] as const;
function AboutSystem({ connection }: { connection: ServiceConnection }) {
  const health = connection.state === "online" ? connection.health : null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const environment = !health ? "环境未知" : health.environment === "test" ? "测试" : local ? "本地" : "服务器";
  return <section className="settings-about">
    <h2>关于系统</h2>
    <div className="settings-about-info">
      <div><strong>宏昊化工 · 工作台</strong></div>
      <div><strong>当前版本</strong><span>{health?.api_version ?? "版本暂不可用"} · {environment}</span></div>
    </div>
    <h3 className="settings-section-label">更新日志</h3>
    <ol className="settings-timeline" tabIndex={0} aria-label="更新日志"><li>
      <div className="changelog-date"><time dateTime="2026-09-10">2026年9月10日</time><time className="changelog-updated" dateTime="2026-09-10T23:44:00+08:00" title="日志整理更新时间（北京时间）">23:44 整理更新</time></div>
      <div className="settings-timeline-content">
        <div><strong>我的账号</strong><p>集中只读展示本人资料，仅列出已授权的功能模块和工作台；姓名和部门统一由管理员在用户管理中维护。</p><p>修改密码时提供安全性和两次输入一致性提示，安全性仅作参考。密码框支持显示／隐藏，眼睛图标随输入淡入、清空后淡出。</p></div>
        <div><strong>使用说明</strong><p>左下角新增帮助入口，可查看开始使用、采购工作台、我的账号和意见反馈说明；章节支持折叠，长内容在窗口内滚动。</p></div>
        <div><strong>账号初始密码</strong><p>新建账号预填统一初始密码，也可设置自定义密码；管理员重置密码后，该账号原有登录会话失效。</p></div>
        <div><strong>部门组织与人员归属</strong><p>用户管理按部门和人员分层展示，支持多级部门维护、主部门及兼属部门调整。</p><p>部门归属仅由管理员维护，与工作台权限独立；保留原账号、业务历史及权限设置。</p></div>
        <div><strong>意见反馈与结果通知</strong><p>搜索旁新增反馈入口，支持提交问题、功能建议和截图，查看自己的反馈与处理结果。</p><p>管理员可集中处理反馈、筛选本人提交的记录；处理完成后通知提交人，未读角标在查看对应内容后清除。</p><p>返回和操作按钮固定显示，未保存修改统一使用确认弹窗，避免误关闭丢失内容。</p></div>
        <div><strong>关于系统</strong><p>集中展示当前版本、运行环境和按日期排列的更新日志。</p></div>
        <div><strong>系统设置与用户管理</strong><p>统一设置窗口尺寸，简化启用确认流程；权限等级平铺展示，人员列表增加管理员及兼属标识。</p><p>审计日志支持类型筛选、分页和连续查看。</p></div>
        <div><strong>采购资讯</strong><p>接入采购资讯，支持按天查看和翻页，统一资讯与排行的展示布局。</p></div>
        <div><strong>采购台账与数据分流</strong><p>分流表点击原料编号直接打开台账的原料详情，关闭后保留当前列表位置；移除重复操作列，统一编号字号、操作按钮及对齐方式。</p></div>
        <div><strong>窗口与滚动体验</strong><p>标题和资料区域固定，长内容在各自区域内滚动；滚动条停止操作 3 秒后渐隐。用户详情、我的账号及使用说明增加上下边缘渐隐，到达首尾时自动取消对应渐隐。</p></div>
        <div><strong>界面一致性</strong><p>统一导航、列表及分段切换的浅灰选中态，保留黑色主按钮和业务状态色；优化分段切换动效、通用权限说明及悬停提示，鼠标点击不显示额外焦点框，键盘操作保留焦点提示。</p></div>
      </div>
    </li></ol>
  </section>;
}

function auditType(action: string) {
  if (action.startsWith("login.") || action.startsWith("password.")) return "security";
  if (action.startsWith("user.") || action.startsWith("department.")) return "accounts";
  if (action.startsWith("field.")) return "permissions";
  if (action.startsWith("module.") || action.startsWith("workbench.")) return "modules";
  return "other";
}
function AuditLog({ events }: { events: AuditEvent[] }) {
  const [category, setCategory] = useState("all");
  const [view, setView] = useState("paged");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const root = useRef<HTMLElement>(null);
  const filtered = events.filter(event => category === "all" || auditType(event.action) === category);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visible = view === "scroll" ? filtered : filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => { root.current?.querySelector(".audit-list")?.scrollTo({ top: 0 }); }, [category, view, pageSize, currentPage]);
  const goToPage = (next: number) => setPage(next);
  return <section ref={root} className="admin-settings-section">
    <div className="admin-section-heading"><div><h2>审计日志</h2><p>仅记录操作主体、对象和时间，不保存正文及字段值。</p></div><span className="admin-count">最近 {events.length} 条</span></div>
    <div className="audit-toolbar">
      <details className={`${procurementStyles.columnMenu} ${procurementStyles.personMenu}`}><summary aria-label="日志类型">{AUDIT_TYPES.find(([value]) => value === category)?.[1]}<ChevronRight size={14} className="audit-type-chevron" /></summary><div>
        {AUDIT_TYPES.map(([value, label]) => <button type="button" key={value} aria-pressed={category === value} onClick={event => { setCategory(value); setPage(1); const menu = event.currentTarget.closest("details"); menu?.removeAttribute("open"); menu?.querySelector("summary")?.focus(); }}>{label}{category === value && <Check size={14} />}</button>)}
      </div></details>
      <span className="audit-filter-count">{filtered.length} 条记录</span>
      <details className={`${procurementStyles.columnMenu} ${procurementStyles.displayMenu}`}><summary><Columns3 size={14} />显示</summary><div>
        <span className={procurementStyles.menuLabel}>浏览方式</span>
        <div className={procurementStyles.ledgerMode} role="group" aria-label="日志查看模式">{[["scroll", "连续"], ["paged", "分页"]].map(([value, label]) => <button type="button" key={value} aria-pressed={view === value} onClick={() => { setView(value); setPage(1); }}>{label}</button>)}</div>
        {view === "paged" && <><span className={procurementStyles.menuLabel}>每页条数</span><div className={procurementStyles.ledgerMode} role="group" aria-label="日志每页条数">{[25, 50, 100].map(size => <button type="button" key={size} aria-pressed={pageSize === size} onClick={() => { setPageSize(size); setPage(1); }}>{size}</button>)}</div></>}
      </div></details>
    </div>
    <div className="audit-list" tabIndex={0} role="region" aria-label="审计日志记录">{filtered.length === 0 ? <SettingsState copy="该类型暂无日志。" /> : visible.map((event) => <div className="audit-row" key={event.id}><span className="audit-row__icon"><ClipboardList size={14} /></span><div><strong>{AUDIT_LABELS[event.action] ?? event.action}</strong><p>{event.actor_name ?? "未知账号"}</p><small className="audit-target">{({ user: "账号", account: "账号", field: "历史字段策略", session: "登录会话", module: "功能模块", workbench: "职能工作台" } as Record<string, string>)[event.target_type] ?? event.target_type} · {event.target_id}</small></div><time dateTime={event.created_at}><span>{formatDate(event.created_at)}</span><small>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.created_at))}</small></time></div>)}</div>
    <footer className="audit-footer"><span>仅查看最近 200 条日志</span>{view === "paged" && filtered.length > 0 && <div className="audit-pagination" role="group" aria-label="日志分页"><button type="button" className="icon-button" aria-label="日志上一页" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}><ChevronLeft size={16} /></button><span aria-live="polite">{currentPage} / {pages}</span><button type="button" className="icon-button" aria-label="日志下一页" disabled={currentPage === pages} onClick={() => goToPage(currentPage + 1)}><ChevronRight size={16} /></button></div>}</footer>
  </section>;
}

function UserProfileEditor({ departments, user, onSaved, onDirty, onSaving, onCancel, disabled }: { departments: OrganizationDepartment[]; onCancel: () => void; user: ManagedUser; onSaved: (user: ManagedUser) => void; onDirty: (value: boolean) => void; onSaving: (value: boolean) => void; disabled: boolean }) {
  const [name, setName] = useState(user.display_name);
  const [membership, setMembership] = useState<DepartmentMembership>({ primary_department_id: user.primary_department_id || null, additional_department_ids: user.additional_department_ids || [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const dirty = name !== user.display_name || membership.primary_department_id !== (user.primary_department_id || null) || [...membership.additional_department_ids].sort().join(",") !== [...(user.additional_department_ids || [])].sort().join(",");
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  return <form className="admin-profile-form org-member-editor" onSubmit={async (event) => {
    event.preventDefault();
    if (busy.current || disabled || !dirty) return;
    if (!name.trim()) { setError("姓名不能为空。"); return; }
    busy.current = true; setSaving(true); onSaving(true); setError("");
    try {
      const updated = await updateUserProfile(user.id, { display_name: name.trim(), membership });
      setName(updated.display_name); onSaved(updated);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "资料保存失败，请重试。"); }
    finally { busy.current = false; setSaving(false); onSaving(false); }
  }} aria-label="编辑基本资料"><h3 className="admin-profile-form-title">编辑资料与部门</h3><div className="admin-form-grid"><label>姓名<input required maxLength={100} disabled={disabled} value={name} onChange={(event) => setName(event.target.value)} /></label></div><MembershipFields departments={departments} value={membership} onChange={setMembership} disabled={disabled} />
    <p className="admin-profile-form-note">仅更新姓名与部门，账号、权限及历史记录保持不变。</p>
    {error && <p className="login-error" role="alert">{error}</p>}
    <div className="admin-form-actions"><span className="admin-dirty">{dirty ? "有未保存修改" : ""}</span><button className="secondary-button" type="button" disabled={disabled} onClick={onCancel}>取消</button>{dirty && <button className="primary-button" type="submit" disabled={disabled}>{saving ? "正在保存…" : "保存资料"}</button>}</div>
  </form>;
}

type AccessRuntime = Pick<SettingsDialogProps, "moduleStatuses" | "moduleRegistryState" | "workbenchStatuses" | "workbenchRegistryState">;

function AccountAccessEditor({ id, runtime, dirty, isSystemAdmin, scopeLevels, onAdminChange, onScopeLevelChange, disabledAdmin = false, children }: {
  id: string; runtime: AccessRuntime; dirty: boolean; isSystemAdmin: boolean; scopeLevels: Partial<Record<AccessScope, AccessLevel>>;
  onAdminChange: (value: boolean) => void; onScopeLevelChange: (scopeId: AccessScope, level: AccessLevel | null) => void; disabledAdmin?: boolean; children?: ReactNode;
}) {
  const summary = (scopes: AccessScope[]) => (isSystemAdmin ? "系统管理员" : `已授权 ${scopes.filter(scope => scopeLevels[scope]).length} 个范围`) + (dirty ? " · 未保存" : "");
  const scopeRow = (scope: typeof ACCESS_SCOPES[number]) => {
    const registry = runtime.moduleRegistryState !== "ready" ? runtime.moduleRegistryState : scope.id === "knowledge" ? "ready" : runtime.workbenchRegistryState;
    const parentMode = runtime.moduleStatuses.find(module => module.id === (scope.id === "knowledge" ? "knowledge" : "workbench"))?.mode ?? "off";
    const mode = scope.id === "knowledge" || parentMode !== "active" ? parentMode : runtime.workbenchStatuses.find(workbench => workbench.id === scope.id)?.mode ?? "off";
    const enabled = registry === "ready" && mode === "active";
    const status = registry === "error" ? "状态不可用" : registry === "loading" ? "读取中" : mode === "active" ? "已启用" : mode === "prototype" ? "原型" : "未启用";
    return <div className="scope-access-row" key={scope.id} data-inactive={!enabled}><div className="scope-access-name"><strong>{scope.name}</strong><small data-enabled={enabled}>{status}</small></div>{!isSystemAdmin && <div role="group" aria-label={`${scope.name}业务权限`}>{[{ id: null, label: "未授权" }, ...ACCESS_LEVELS].map(level => { const selected = (scopeLevels[scope.id] || null) === level.id; return <button key={level.id ?? "none"} type="button" disabled={!enabled} aria-pressed={selected} data-selected={selected} onClick={() => onScopeLevelChange(scope.id, level.id)}>{level.label}</button>; })}</div>}</div>;
  };
  return <fieldset className="scope-access-editor" data-admin={isSystemAdmin}>
      <legend className="scope-access-help">访问权限</legend>
      <label className="system-admin-option" data-selected={isSystemAdmin}><input type="checkbox" checked={isSystemAdmin} disabled={disabledAdmin} onChange={event => onAdminChange(event.target.checked)} /><span><strong>系统管理</strong><small>{isSystemAdmin ? "拥有全部范围，无需逐项授权；业务仍按模块启用状态开放。" : "拥有全部范围，并可管理账号、模块配置与审计。"}</small></span></label>
      <SettingsGroup id={id + "-modules"} title="功能模块" description="仅显示已接入人员权限的模块，未启用时保留配置。" summary={summary(["knowledge"])}>
        <div className="scope-access-list" aria-disabled={isSystemAdmin}>{scopeRow({ id: "knowledge", name: "知识库" })}</div>
      </SettingsGroup>
      <SettingsGroup id={id + "-workbenches"} title="职能工作台" description="各工作台独立授权，未运行时保留原有配置。" summary={summary(ACCESS_SCOPES.filter(scope => scope.id !== "knowledge").map(scope => scope.id))}>
        <div className="scope-access-list" aria-disabled={isSystemAdmin}>{ACCESS_SCOPES.filter(scope => scope.id !== "knowledge").map(scopeRow)}</div>
      </SettingsGroup>
      {(runtime.moduleRegistryState !== "ready" || runtime.workbenchRegistryState !== "ready") && <p role="status">模块状态{runtime.moduleRegistryState === "error" || runtime.workbenchRegistryState === "error" ? "读取失败" : "读取中"}，对应范围暂不可修改；已有授权保持不变。</p>}
      {children}
    </fieldset>;
}

function AccessPolicyHelp() {
  return <button className="access-policy-help" type="button" aria-label="查看权限说明"><Info size={13} /><span role="tooltip"><strong>查看</strong><small>{ACCESS_LEVELS[0].summary}</small><strong>编辑</strong><small>{ACCESS_LEVELS[1].summary}</small><strong>管理</strong><small>{ACCESS_LEVELS[2].summary}</small><strong>系统</strong><small>拥有全部访问权限，可管理账号、系统配置和审计日志。</small></span></button>;
}

function FontSizeSetting({ value, onChange }: { value: UiFontSize; onChange: (size: UiFontSize) => void }) {
  const selected = UI_FONT_SIZES[value - 1];
  const sliderStyle = { "--ui-font-progress": `${(value - 1) * 25}%` } as CSSProperties;
  return <section className="ui-preferences"><h2>常规设置</h2><div className="ui-font-setting"><div><strong id="ui-font-size-title">界面字号</strong><p>调整导航、正文、表格和表单文字大小。</p></div><div className="ui-font-control"><div className="ui-font-current" aria-live="polite"><span>当前</span><strong>{selected.label}</strong></div><input className="ui-font-range" type="range" min="1" max="5" step="1" value={value} aria-labelledby="ui-font-size-title" aria-valuetext={selected.label} style={sliderStyle} onChange={(event) => onChange(Number(event.currentTarget.value) as UiFontSize)} /><div className="ui-font-ticks" role="group" aria-label="字号档位">{UI_FONT_SIZES.map((option) => <button key={option.id} type="button" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>{option.label}</button>)}</div></div></div></section>;
}

export function DiscardChangesDialog({ onCancel, onDiscard, title = "放弃未保存的修改？", description = "继续后，本次操作涉及的未保存修改将不会保留。", cancelLabel = "继续编辑", confirmLabel = "放弃修改", disabled = false }: { onCancel: () => void; onDiscard: () => void; title?: string; description?: ReactNode; cancelLabel?: string; confirmLabel?: string; disabled?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="settings-discard-dialog" role="alertdialog" aria-labelledby="settings-discard-title" aria-describedby="settings-discard-description"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <h2 id="settings-discard-title">{title}</h2>
    <p id="settings-discard-description">{description}</p>
    <div className="admin-form-actions"><button autoFocus type="button" className="secondary-button" disabled={disabled} onClick={onCancel}>{cancelLabel}</button><button type="button" className="secondary-button settings-discard-action" disabled={disabled} onClick={onDiscard}>{confirmLabel}</button></div>
  </dialog>;
}

export function SettingsGroup({ id, title, description, summary, children, defaultOpen = false, icon }: { id: string; title: string; description: string; summary: string; children: ReactNode; defaultOpen?: boolean; icon?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const [instant, setInstant] = useState(false);
  const [height, setHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setHeight(content.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return <section className="module-settings settings-group" data-open={open} data-instant={instant} aria-labelledby={id + "-title"}>
    <button type="button" id={id + "-title"} className="module-settings__heading settings-group-trigger" aria-label={title} aria-expanded={open} aria-controls={id + "-content"} onClick={event => { setInstant(event.detail === 0); setOpen(value => !value); }}>
      <span className="settings-group-copy"><strong>{icon && <span className="settings-group-icon" aria-hidden="true">{icon}</span>}{title}</strong><span>{description}</span></span>
      <span className="settings-group-summary">{summary}<ChevronRight size={15} /></span>
    </button>
    <div id={id + "-content"} className="settings-group-collapse" style={{ height: open ? height : 0 }} aria-hidden={!open} inert={!open}>
      <div ref={contentRef}>{children}</div>
    </div>
  </section>;
}

function GeneralSettings({ serviceCopy, environment: serviceEnvironment, moduleStatuses, moduleRegistryState, workbenchStatuses, workbenchRegistryState, isAdmin, adminModuleSettings, onModeChange, onWorkbenchModeChange, canManageGrants, onGrantsChanged }: {
  serviceCopy: { label: string; detail: string };
  environment: RuntimeEnvironment | null;
  moduleStatuses: ModuleStatus[];
  moduleRegistryState: "loading" | "ready" | "error";
  workbenchStatuses: WorkbenchStatus[];
  workbenchRegistryState: "loading" | "ready" | "error";
  isAdmin: boolean;
  adminModuleSettings: AdminModuleSettings | null;
  canManageGrants: boolean;
  onGrantsChanged: () => void;
  onModeChange: (moduleId: Section, mode: ModuleMode, reviews?: ActivationReview[], issueUrl?: string, pullRequestUrl?: string) => Promise<void>;
  onWorkbenchModeChange: (workbenchId: WorkbenchId, mode: ModuleMode, reviews?: ActivationReview[], issueUrl?: string, pullRequestUrl?: string) => Promise<void>;
}) {
  const [activationTarget, setActivationTarget] = useState<{ kind: "module"; id: Section } | { kind: "workbench"; id: WorkbenchId } | null>(null);
  const [reviews, setReviews] = useState<ActivationReview[]>([]);
  const canRestore = !!activationTarget && !!(activationTarget.kind === "module" ? adminModuleSettings?.modules.find(item => item.id === activationTarget.id) : adminModuleSettings?.workbenches.find(item => item.id === activationTarget.id))?.can_reactivate;

  const environment = serviceEnvironment ?? adminModuleSettings?.environment ?? null;
  const pendingCount = adminModuleSettings ? [...adminModuleSettings.modules, ...adminModuleSettings.workbenches].filter((item) => item.current_mode !== item.pending_mode).length : 0;
  const visibleModules = MODULE_OPTIONS.filter((item) => isAdmin || (moduleRegistryState === "ready" && moduleStatuses.some((module) => module.id === item.id && module.mode === "active")));
  const visibleWorkbenches = WORKBENCH_OPTIONS.filter((item) => isAdmin || (workbenchRegistryState === "ready" && visibleModules.some((module) => module.id === "workbench") && workbenchStatuses.some((workbench) => workbench.id === item.id && workbench.mode === "active")));
  const enabledCount = moduleStatuses.filter((module) => isAdmin ? module.mode !== "off" : module.mode === "active").length;
  const [grantsLoaded, setGrantsLoaded] = useState(false);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [grantsInstant, setGrantsInstant] = useState(false);
  const [grantsHeight, setGrantsHeight] = useState(0);
  const grantsContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = grantsContent.current;
    if (!content || !grantsLoaded) return;
    const measure = () => setGrantsHeight(content.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [grantsLoaded, canManageGrants]);
  const grantsEntry = canManageGrants && <div className="settings-grants" data-open={grantsOpen} data-instant={grantsInstant}><button id="settings-grants-entry" type="button" className="settings-grants-entry" aria-expanded={grantsOpen} aria-controls="settings-grants-content" onClick={(event) => { setGrantsInstant(event.detail === 0); setGrantsLoaded(true); setGrantsOpen((open) => !open); }}><ShieldCheck size={15} /><span>价格启用授权</span><ChevronRight className="settings-grants-chevron" size={14} /></button><div id="settings-grants-content" className="settings-grants-collapse" style={{ height: grantsOpen ? grantsHeight : 0 }} aria-hidden={!grantsOpen} inert={!grantsOpen}><div ref={grantsContent} className="settings-activation">{grantsLoaded && <ProcurementActivationGrants admin={isAdmin} onChanged={onGrantsChanged} />}</div></div></div>;
  const modeLabel = (mode: ModuleMode) => mode === "active" ? "启用" : mode === "prototype" ? "原型" : "关闭";
  const clearGate = () => { setActivationTarget(null); setReviews([]); };
  const [changingMode, setChangingMode] = useState(false);
  const modeBusy = useRef(false);
  const chooseMode = (kind: "module" | "workbench", id: Section | WorkbenchId, mode: ModuleMode) => {
    if (modeBusy.current) return;
    if (environment === "production" && mode === "active") { setActivationTarget(kind === "module" ? { kind, id: id as Section } : { kind, id: id as WorkbenchId }); setReviews([]); return; }
    modeBusy.current = true; setChangingMode(true);
    const update = kind === "module" ? onModeChange(id as Section, mode) : onWorkbenchModeChange(id as WorkbenchId, mode);
    void update.catch(() => undefined).finally(() => { modeBusy.current = false; setChangingMode(false); });
  };
  const confirmActivation = () => {
    if (!activationTarget || modeBusy.current || (!canRestore && reviews.length !== 4)) return;
    modeBusy.current = true; setChangingMode(true);
    const update = activationTarget.kind === "module"
      ? onModeChange(activationTarget.id, "active", canRestore ? [] : reviews)
      : onWorkbenchModeChange(activationTarget.id, "active", canRestore ? [] : reviews);
    void update.then(clearGate).catch(() => undefined).finally(() => { modeBusy.current = false; setChangingMode(false); });
  };
  return <section className="admin-settings-section settings-general"><h2>常规设置</h2>{pendingCount > 0 && <p className="settings-availability-note" role="status">{pendingCount} 项设置待重启生效</p>}{isAdmin && <><h3 className="settings-section-label" id="module-panel-title">模块与工作台</h3><section className="settings-module-panel" aria-labelledby="module-panel-title"><SettingsGroup id="module-settings" title="功能模块" description="状态只影响当前服务器；关闭时入口和业务接口同时停用。" summary={moduleRegistryState === "ready" ? `${enabledCount} 个运行中` : moduleRegistryState === "loading" ? "读取中" : "状态不可用"}><div className="module-settings__list">{visibleModules.map((item) => { const Icon = item.icon; const publicMode = moduleStatuses.find((module) => module.id === item.id)?.mode ?? "off"; const managed = adminModuleSettings?.modules.find((module) => module.id === item.id); const currentMode = managed?.current_mode ?? publicMode; const pendingMode = managed?.pending_mode ?? currentMode; const hasPending = currentMode !== pendingMode; return <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><Icon size={16} /></span><div><strong>{item.label}</strong><p>{item.description}{hasPending ? ` · 当前${modeLabel(currentMode)}` : ""}</p></div>{isAdmin && adminModuleSettings ? <div className="settings-mode-control"><span>{hasPending ? `待重启 · ${modeLabel(pendingMode)}` : modeLabel(pendingMode)}</span><button type="button" role="switch" className="settings-mode-switch" aria-label={`${item.label}启用`} aria-checked={pendingMode !== "off"} disabled={changingMode} onClick={() => chooseMode("module", item.id, pendingMode === "off" ? "active" : "off")}><span /></button></div> : <span className="module-mode-label" data-mode={currentMode}>{modeLabel(currentMode)}</span>}</div>; })}</div></SettingsGroup><SettingsGroup id="workbench-settings" title="职能工作台" description="每个工作台独立启用、停用和回退。" summary={workbenchRegistryState === "ready" ? `${visibleWorkbenches.length} 个工作台` : workbenchRegistryState === "loading" ? "读取中" : "状态不可用"}><div className="module-settings__list">{visibleWorkbenches.map((item) => { const managed = adminModuleSettings?.workbenches.find((workbench) => workbench.id === item.id); const currentMode = managed?.current_mode ?? workbenchStatuses.find((workbench) => workbench.id === item.id)?.mode ?? "off"; const pendingMode = managed?.pending_mode ?? currentMode; const hasPending = currentMode !== pendingMode; return <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><PanelsTopLeft size={16} /></span><div><strong>{item.label}</strong><p>{item.description}{hasPending ? ` · 当前${modeLabel(currentMode)}` : ""}</p></div>{isAdmin && adminModuleSettings ? <div className="settings-mode-control"><span>{hasPending ? `待重启 · ${modeLabel(pendingMode)}` : modeLabel(pendingMode)}</span><button type="button" role="switch" className="settings-mode-switch" aria-label={`${item.label}启用`} aria-checked={pendingMode !== "off"} disabled={changingMode} onClick={() => chooseMode("workbench", item.id, pendingMode === "off" ? (item.id === "procurement" || currentMode === "active" ? "active" : "prototype") : "off")}><span /></button></div> : <span className="module-mode-label" data-mode={currentMode}>{modeLabel(currentMode)}</span>}{item.id === "procurement" && grantsEntry}</div>; })}</div></SettingsGroup></section></>}{!isAdmin && <section className="module-settings" aria-labelledby="available-settings-title"><div className="module-settings__heading"><strong id="available-settings-title">可用功能</strong></div><div className="module-settings__list">{visibleModules.filter((item) => item.id !== "workbench").map((item) => { const Icon = item.icon; return <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><Icon size={16} /></span><div><strong>{item.label}</strong><p>{item.description}</p></div><span className="module-mode-label" data-mode="active">已启用</span></div>; })}{visibleWorkbenches.map((item) => <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><PanelsTopLeft size={16} /></span><div><strong>{item.label}</strong><p>{item.description}</p></div><span className="module-mode-label" data-mode="active">已启用</span>{item.id === "procurement" && grantsEntry}</div>)}</div>{(moduleRegistryState !== "ready" || workbenchRegistryState !== "ready") ? <p className="settings-availability-note" role="status">{moduleRegistryState === "error" || workbenchRegistryState === "error" ? "可用功能暂时无法读取，请刷新重试。" : "正在读取可用功能…"}</p> : visibleModules.every((item) => item.id === "workbench") && visibleWorkbenches.length === 0 && <p className="settings-availability-note">暂无可用功能。</p>}</section>}{activationTarget && <div className="production-review-gate"><strong>{canRestore ? "确认恢复启用？" : "启用前，请确认以下事项"}</strong><p>{canRestore ? "沿用已有确认记录。未重启的关闭操作会被撤销，已关闭的模块将在重启后恢复。" : "请按实际情况勾选，系统自动记录确认人和时间，无需填写技术地址。"}</p>{!canRestore && <div>{([ ["business", "业务负责人已确认可以使用"], ["security", "已确认数据和人员访问范围合适"], ["code", "开发或维护人员已完成检查"], ["rollback", "已确认出现问题时可以恢复"] ] as const).map(([id, label]) => <label key={id}><input type="checkbox" checked={reviews.includes(id)} onChange={() => setReviews(toggleId(reviews, id) as ActivationReview[])} />{label}</label>)}</div>}<div className="admin-form-actions"><button className="secondary-button" type="button" onClick={clearGate}>取消</button><button className="primary-button" type="button" disabled={changingMode || (!canRestore && reviews.length !== 4)} onClick={confirmActivation}>{changingMode ? "正在保存…" : canRestore ? "确认恢复" : "确认启用"}</button></div></div>}<h3 id="settings-security-title" className="settings-section-label">运行与安全</h3><section className="settings-security" aria-labelledby="settings-security-title"><div className="settings-security-row"><span className="settings-security-icon"><Server size={19} /></span><div><strong>本地服务</strong><p>{serviceCopy.label === "已连接" ? "工作台与本地服务连接正常" : serviceCopy.label === "连接中" ? "正在检查工作台服务连接" : "服务尚未连接，请启动服务后刷新"}</p></div><span className={`setting-connection setting-connection--${serviceCopy.label === "已连接" ? "online" : serviceCopy.label === "连接中" ? "checking" : "offline"}`}><i />{serviceCopy.label}</span></div><div className="settings-security-row"><span className="settings-security-icon"><ShieldCheck size={19} /></span><div><strong>访问保护</strong><p>按账号权限限制查看和操作</p></div><span className="setting-enabled"><Check size={14} />已启用</span></div></section></section>;
}

function SettingsState({ copy, error = false }: { copy: string; error?: boolean }) { return <div className={error ? "settings-state is-error" : "settings-state"}>{copy}</div>; }
function toggleId<T extends string>(ids: T[], id: T): T[] { return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]; }
function setScopeLevel(levels: Partial<Record<AccessScope, AccessLevel>>, scopeId: AccessScope, level: AccessLevel | null) { const updated = { ...levels }; if (level === null) delete updated[scopeId]; else updated[scopeId] = level; return updated; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
