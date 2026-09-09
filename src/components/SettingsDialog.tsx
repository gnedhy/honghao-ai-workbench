import {
  Check,
  ChevronRight,
  CircleUserRound,
  ClipboardList,
  FolderKanban,
  KeyRound,
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
  createSensitiveField,
  createUser,
  fetchAdminModuleSettings,
  fetchProcurementOverview,
  fetchAuditEvents,
  fetchSensitiveFields,
  fetchUsers,
  updateAdminModuleSetting,
  updateAdminWorkbenchSetting,
  updateSensitiveField,
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
  SensitiveFieldPolicy,
  WorkbenchId,
  WorkbenchStatus,
} from "../types";
import { ProcurementActivationGrants } from "../workbenches/ProcurementDistribution";

type SettingsTab = "general" | "accounts" | "permissions" | "audit";
type FieldScopeKey = "read_scope_ids" | "write_scope_ids";
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
  { id: 2, label: "查看", summary: "可查看授权数据，但不能修改或提交。" },
  { id: 3, label: "编辑", summary: "可新建、修改、导入并提交，但不能让结果正式生效。" },
  { id: 4, label: "管理", summary: "可审核、退回、确认、发布及管理范围内业务，不能审核本人提交的内容。" },
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

const EMPTY_FIELD = {
  area: "采购",
  name: "",
  description: "",
  read_min_level: 2 as const,
  write_min_level: 3 as const,
  read_scope_ids: [] as AccessScope[],
  write_scope_ids: [] as AccessScope[],
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
};

export function SettingsDialog({ currentUser, onUserChanged, serviceConnection, moduleStatuses, moduleRegistryState, workbenchStatuses, workbenchRegistryState, uiFontSize, onUiFontSizeChange, onClose }: SettingsDialogProps) {
  const isAdmin = currentUser.is_system_admin;
  const [tab, setTab] = useState<SettingsTab>("general");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [fields, setFields] = useState<SensitiveFieldPolicy[]>([]);
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
  const [newUser, setNewUser] = useState({ username: "", display_name: "", department: "", password: "", is_system_admin: false, scope_levels: {} as Partial<Record<AccessScope, AccessLevel>> });
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userAdminDraft, setUserAdminDraft] = useState(false);
  const [userScopeDraft, setUserScopeDraft] = useState<Partial<Record<AccessScope, AccessLevel>>>({});
  const [selectedFieldId, setSelectedFieldId] = useState("");
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const [newField, setNewField] = useState({ ...EMPTY_FIELD });

  useEffect(() => {
    if (!isAdmin) return;
    setLoadState("loading");
    Promise.all([fetchUsers(), fetchSensitiveFields(), fetchAuditEvents(), fetchAdminModuleSettings()])
      .then(([loadedUsers, loadedFields, loadedEvents, loadedModuleSettings]) => {
        setUsers(loadedUsers);
        setFields(loadedFields);
        setAuditEvents(loadedEvents);
        setAdminModuleSettings(loadedModuleSettings);
        setSelectedUserId(loadedUsers[0]?.id ?? "");
        setSelectedFieldId(loadedFields[0]?.id ?? "");
        setLoadState("ready");
      })
      .catch(() => setLoadState("error"));
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin || tab !== "audit" || loadState !== "ready") return;
    void fetchAuditEvents().then(setAuditEvents).catch(() => showNotice("审计日志刷新失败"));
  }, [isAdmin, loadState, tab]);

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? null;

  useEffect(() => {
    setUserAdminDraft(selectedUser?.is_system_admin ?? false);
    setUserScopeDraft(selectedUser?.scope_levels ?? {});
  }, [selectedUserId]);

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

  const submitUser = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const created = await createUser({ ...newUser, department: newUser.department.trim() || null, scope_levels: newUser.is_system_admin ? {} : newUser.scope_levels });
      setUsers((current) => [...current, created]);
      setNewUser({ username: "", display_name: "", department: "", password: "", is_system_admin: false, scope_levels: {} });
      setNewUserOpen(false);
      setSelectedUserId(created.id);
      showNotice("账号已创建");
    } catch {
      showNotice("账号信息有误或账号名已存在");
    }
  };

  const saveUserAccess = async () => {
    if (!selectedUser) return;
    try {
      const updated = await updateUser(selectedUser.id, { is_system_admin: userAdminDraft, scope_levels: userAdminDraft ? {} : userScopeDraft });
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      showNotice("授权范围与权限已更新，原登录会话已失效");
    } catch {
      showNotice(selectedUser.id === currentUser.id ? "不能移除当前管理员自己的系统权限" : "账号授权更新失败");
    }
  };

  const toggleUserActive = async () => {
    if (!selectedUser || selectedUser.id === currentUser.id) return;
    try {
      const updated = await updateUser(selectedUser.id, { is_active: !selectedUser.is_active });
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      showNotice(updated.is_active ? "账号已启用" : "账号已停用");
    } catch {
      showNotice("账号状态更新失败");
    }
  };

  const toggleFieldScope = (kind: FieldScopeKey, scopeId: AccessScope) => {
    if (!selectedField) return;
    setFields((current) => current.map((field) => field.id === selectedField.id ? { ...field, [kind]: toggleId(field[kind], scopeId) } : field));
  };

  const saveField = async () => {
    if (!selectedField) return;
    try {
      const updated = await updateSensitiveField(selectedField.id, {
        read_min_level: selectedField.read_min_level,
        write_min_level: selectedField.write_min_level,
        read_scope_ids: selectedField.read_scope_ids,
        write_scope_ids: selectedField.write_scope_ids,
      });
      setFields((current) => current.map((field) => field.id === updated.id ? updated : field));
      showNotice("敏感字段策略已生效");
    } catch {
      showNotice("敏感字段策略保存失败");
    }
  };

  const submitField = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newField.name.trim() || !newField.description.trim()) return;
    try {
      const created = await createSensitiveField({ ...newField, name: newField.name.trim(), description: newField.description.trim() });
      setFields((current) => [...current, created]);
      setSelectedFieldId(created.id);
      setNewField({ ...EMPTY_FIELD, read_scope_ids: [], write_scope_ids: [] });
      setNewFieldOpen(false);
      showNotice("敏感字段已新增");
    } catch {
      showNotice("字段名称已存在或暂时无法新增");
    }
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
      { id: "permissions" as const, label: "权限管理", icon: KeyRound },
      { id: "audit" as const, label: "审计日志", icon: ClipboardList },
    ] : []),
  ];

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog settings-dialog--admin" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><h1 id="settings-title">系统设置</h1><p>{isAdmin ? "管理账号、访问边界和安全记录。" : "查看当前系统运行状态。"}</p></div><button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button></header>
        <div className="settings-dialog__body">
          <nav aria-label="设置分类">{navItems.map(({ id, label, icon: Icon }) => <button className={tab === id ? "is-active" : ""} key={id} type="button" onClick={() => setTab(id)}><span><Icon size={15} />{label}</span><ChevronRight size={15} /></button>)}</nav>
          <article>
            {notice && <div className="settings-notice" role="status"><Check size={14} />{notice}</div>}
            {tab === "general" && <><FontSizeSetting value={uiFontSize} onChange={onUiFontSizeChange} /><GeneralSettings serviceCopy={serviceCopy} environment={runtimeEnvironment} moduleStatuses={moduleStatuses} moduleRegistryState={moduleRegistryState} workbenchStatuses={workbenchStatuses} workbenchRegistryState={workbenchRegistryState} isAdmin={isAdmin} adminModuleSettings={adminModuleSettings} onModeChange={saveModuleMode} onWorkbenchModeChange={saveWorkbenchMode} canManageGrants={canManageGrants} onGrantsChanged={() => showNotice("授权已更新")} /></>}
            {tab !== "general" && loadState === "loading" && <SettingsState copy="正在读取管理数据…" />}
            {tab !== "general" && loadState === "error" && <SettingsState copy="管理数据暂时无法读取，请稍后重试。" error />}
            {tab === "accounts" && loadState === "ready" && <section className="admin-settings-section">
              <div className="admin-section-heading"><div><h2>用户管理</h2><p>权限由“能进哪里”和“能做到哪一步”组成；每个授权范围可以独立设置。</p></div><button className="secondary-button" type="button" onClick={() => setNewUserOpen((open) => !open)}><Plus size={14} />新建账号</button></div>
              {newUserOpen && <form className="admin-create-form" onSubmit={submitUser}><div className="admin-form-grid"><label>姓名<input required maxLength={100} value={newUser.display_name} onChange={(event) => setNewUser({ ...newUser, display_name: event.target.value })} /></label><label>账号名<input required maxLength={100} pattern="[A-Za-z0-9._-]+" autoComplete="off" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} /></label><label>部门<input maxLength={100} value={newUser.department} onChange={(event) => setNewUser({ ...newUser, department: event.target.value })} /></label><label>初始密码<input required minLength={12} maxLength={1000} type="password" autoComplete="new-password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} /></label></div><AccountAccessEditor isSystemAdmin={newUser.is_system_admin} scopeLevels={newUser.scope_levels} onAdminChange={(is_system_admin) => setNewUser({ ...newUser, is_system_admin, scope_levels: is_system_admin ? {} : newUser.scope_levels })} onScopeLevelChange={(scopeId, level) => setNewUser({ ...newUser, scope_levels: setScopeLevel(newUser.scope_levels, scopeId, level) })} /><AccessPreview isSystemAdmin={newUser.is_system_admin} scopeLevels={newUser.scope_levels} /><div className="admin-form-actions"><button type="button" className="secondary-button" onClick={() => setNewUserOpen(false)}>取消</button><button type="submit" className="primary-button">创建账号</button></div></form>}
              <div className="admin-split"><div className="admin-list-panel"><p className="admin-list-label">账号 · {users.length}</p>{users.map((user) => <button className={selectedUserId === user.id ? "admin-list-row is-active" : "admin-list-row"} type="button" key={user.id} onClick={() => setSelectedUserId(user.id)}><span className="admin-user-mark">{user.display_name.slice(0, 1)}</span><span><strong>{user.display_name}</strong><small>{user.department || user.username}</small></span><i data-active={user.is_active}>{user.is_system_admin ? "系统" : Object.keys(user.scope_levels).length > 0 ? `${Object.keys(user.scope_levels).length} 项授权` : "未授权"}</i></button>)}</div><div className="admin-detail-panel">{selectedUser ? <><div className="admin-detail-heading"><div><h3>{selectedUser.display_name}</h3><p>@{selectedUser.username} · {selectedUser.department || "未填写部门"}</p></div><span className="status-chip" data-active={selectedUser.is_active}>{selectedUser.is_active ? "使用中" : "已停用"}</span></div><UserProfileEditor key={selectedUser.id} user={selectedUser} onSaved={(updated) => { setUsers((current) => current.map((user) => user.id === updated.id ? updated : user)); if (updated.id === currentUser.id) onUserChanged(updated); showNotice("资料已保存"); }} /><AccountAccessEditor isSystemAdmin={userAdminDraft} scopeLevels={userScopeDraft} onAdminChange={(isSystemAdmin) => { setUserAdminDraft(isSystemAdmin); if (isSystemAdmin) setUserScopeDraft({}); }} onScopeLevelChange={(scopeId, level) => setUserScopeDraft((current) => setScopeLevel(current, scopeId, level))} disabledAdmin={selectedUser.id === currentUser.id} /><AccessPreview isSystemAdmin={userAdminDraft} scopeLevels={userScopeDraft} /><div className="admin-form-actions"><button className="secondary-button" type="button" disabled={selectedUser.id === currentUser.id} onClick={toggleUserActive}>{selectedUser.is_active ? "停用账号" : "启用账号"}</button><button className="primary-button" type="button" disabled={selectedUser.id === currentUser.id} onClick={saveUserAccess}>保存授权</button></div></> : <SettingsState copy="请选择一个账号。" />}</div></div>
            </section>}
            {tab === "permissions" && loadState === "ready" && <section className="admin-settings-section"><div className="admin-section-heading"><div><h2>权限管理</h2><p>为重要数据指定谁能查看、谁能编辑；未开放时仅系统管理员可以访问。</p></div><button className="secondary-button" type="button" onClick={() => setNewFieldOpen(true)}><Plus size={14} />新增字段</button></div><div className="admin-split"><div className="admin-list-panel"><p className="admin-list-label">字段目录 · {fields.length}</p>{fields.map((field) => <button className={selectedFieldId === field.id ? "admin-list-row is-active" : "admin-list-row"} type="button" key={field.id} onClick={() => { setSelectedFieldId(field.id); setNewFieldOpen(false); }}><span className="admin-user-mark"><KeyRound size={14} /></span><span><strong>{field.name}</strong><small>{field.area}</small></span><i>{field.read_scope_ids.length > 0 ? `${field.read_scope_ids.length} 个范围` : "仅系统"}</i></button>)}</div><div className="admin-detail-panel">{newFieldOpen ? <FieldEditor field={newField} heading="新增敏感字段" onChange={setNewField} onSubmit={submitField} onCancel={() => setNewFieldOpen(false)} /> : selectedField ? <><div className="admin-detail-heading"><div><h3>{selectedField.name}</h3><p>{selectedField.description}</p></div><span className="status-chip">{selectedField.area}</span></div><FieldPolicyControls field={selectedField} onLevelChange={(key, value) => setFields((current) => current.map((field) => field.id === selectedField.id ? { ...field, [key]: value } : field))} onScopeToggle={toggleFieldScope} /><div className="admin-form-actions"><button className="primary-button" type="button" onClick={saveField}>保存设置</button></div></> : <SettingsState copy="请选择一个字段。" />}</div></div></section>}
            {tab === "audit" && loadState === "ready" && <section className="admin-settings-section"><div className="admin-section-heading"><div><h2>审计日志</h2><p>仅记录操作主体、对象和时间，不保存正文及字段值。</p></div><span className="admin-count">最近 {auditEvents.length} 条</span></div><div className="audit-list">{auditEvents.length === 0 ? <SettingsState copy="暂无审计日志。" /> : auditEvents.map((event) => <div className="audit-row" key={event.id}><span className="audit-row__icon"><ClipboardList size={14} /></span><div><strong>{AUDIT_LABELS[event.action] ?? event.action}</strong><p>{event.actor_name ?? "未知账号"} · {event.target_type}</p></div><time dateTime={event.created_at}>{formatDate(event.created_at)}</time></div>)}</div></section>}
          </article>
        </div>
      </section>
    </div>
  );
}

function UserProfileEditor({ user, onSaved }: { user: ManagedUser; onSaved: (user: ManagedUser) => void }) {
  const [name, setName] = useState(user.display_name);
  const [department, setDepartment] = useState(user.department || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  return <form className="admin-profile-form" onSubmit={async (event) => {
    event.preventDefault();
    if (busy.current) return;
    if (!name.trim()) { setError("姓名不能为空。"); return; }
    busy.current = true; setSaving(true); setError("");
    try {
      const updated = await updateUserProfile(user.id, { display_name: name.trim(), department: department.trim() || null });
      setName(updated.display_name); setDepartment(updated.department || ""); onSaved(updated);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "资料保存失败，请重试。"); }
    finally { busy.current = false; setSaving(false); }
  }}><div className="admin-form-grid"><label>姓名<input required maxLength={100} disabled={saving} value={name} onChange={(event) => setName(event.target.value)} /></label><label>部门<input maxLength={100} disabled={saving} value={department} onChange={(event) => setDepartment(event.target.value)} /></label></div>
    <p className="personal-profile__hint">仅修改基本资料，不影响账号、权限和历史姓名快照。</p>
    {error && <p className="login-error" role="alert">{error}</p>}
    <div className="admin-form-actions"><button className="secondary-button" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存资料"}</button></div>
  </form>;
}

function AccountAccessEditor({ isSystemAdmin, scopeLevels, onAdminChange, onScopeLevelChange, disabledAdmin = false }: { isSystemAdmin: boolean; scopeLevels: Partial<Record<AccessScope, AccessLevel>>; onAdminChange: (value: boolean) => void; onScopeLevelChange: (scopeId: AccessScope, level: AccessLevel | null) => void; disabledAdmin?: boolean }) {
  return <fieldset className="scope-access-editor"><legend><span>授权范围与等级<AccessPolicyHelp /></span></legend><p>未授权的范围不可见、不可进入；部门信息不会自动产生权限。</p><label className="system-admin-option" data-selected={isSystemAdmin}><input type="checkbox" checked={isSystemAdmin} disabled={disabledAdmin} onChange={(event) => onAdminChange(event.target.checked)} /><span><strong>系统管理</strong><small>拥有全部范围，并可管理账号、权限、模块配置、敏感字段与审计。</small></span></label><div className="scope-access-list" aria-disabled={isSystemAdmin}>{ACCESS_SCOPES.map((scope) => <div className="scope-access-row" key={scope.id}><strong>{scope.name}</strong><div role="group" aria-label={`${scope.name}业务权限`}><button type="button" disabled={isSystemAdmin} aria-pressed={!isSystemAdmin && !scopeLevels[scope.id]} data-selected={!isSystemAdmin && !scopeLevels[scope.id]} onClick={() => onScopeLevelChange(scope.id, null)}>未授权</button>{ACCESS_LEVELS.map((level) => <button type="button" key={level.id} disabled={isSystemAdmin} aria-pressed={!isSystemAdmin && scopeLevels[scope.id] === level.id} data-selected={!isSystemAdmin && scopeLevels[scope.id] === level.id} onClick={() => onScopeLevelChange(scope.id, level.id)}>{level.label}</button>)}</div></div>)}</div></fieldset>;
}

function AccessPolicyHelp() {
  return <button className="access-policy-help" type="button" aria-label="查看权限说明"><Info size={13} /><span role="tooltip"><strong>查看</strong><small>{ACCESS_LEVELS[0].summary}</small><strong>编辑</strong><small>{ACCESS_LEVELS[1].summary}</small><strong>管理</strong><small>{ACCESS_LEVELS[2].summary}</small><strong>系统</strong><small>管理账号、权限、模块配置、敏感字段与审计。</small></span></button>;
}

function ScopeChecks({ selectedIds, onToggle, emptyCopy }: { selectedIds: AccessScope[]; onToggle: (scopeId: AccessScope) => void; emptyCopy: string }) {
  return <fieldset className="field-policy-scopes"><legend>开放范围</legend><div>{ACCESS_SCOPES.map((scope) => <label key={scope.id}><input type="checkbox" checked={selectedIds.includes(scope.id)} onChange={() => onToggle(scope.id)} /><span>{scope.name}</span></label>)}</div><p data-empty={selectedIds.length === 0}>{selectedIds.length > 0 ? `已开放给 ${selectedIds.length} 个范围。` : emptyCopy}</p></fieldset>;
}

function AccessPreview({ isSystemAdmin, scopeLevels }: { isSystemAdmin: boolean; scopeLevels: Partial<Record<AccessScope, AccessLevel>> }) {
  const grants = ACCESS_SCOPES.filter((scope) => scopeLevels[scope.id]).map((scope) => `${scope.name} ${ACCESS_LEVELS.find((level) => level.id === scopeLevels[scope.id])?.label}`);
  return <div className="access-preview"><strong>权限预览</strong><p>{isSystemAdmin ? "系统管理：拥有全部范围，并可管理账号、权限、模块配置、敏感字段与审计。" : grants.length > 0 ? grants.join("；") : "尚未授权任何范围。"}{(isSystemAdmin || Object.values(scopeLevels).some((level) => level === 4)) && " 任何人都不能审核或发布自己提交的内容。"}</p></div>;
}

function FieldPolicyControls({ field, onLevelChange, onScopeToggle }: { field: SensitiveFieldPolicy; onLevelChange: (key: "read_min_level" | "write_min_level", value: AccessLevel) => void; onScopeToggle: (key: FieldScopeKey, scopeId: AccessScope) => void }) {
  return <div className="field-policy-list"><section className="field-policy-rule"><header><strong>谁能查看</strong><p>达到最低权限，并属于任一开放范围的账号可以看到该字段。</p></header><LevelButtons label="最低权限" value={field.read_min_level} levels={ACCESS_LEVELS} onChange={(value) => onLevelChange("read_min_level", value)} /><ScopeChecks selectedIds={field.read_scope_ids} emptyCopy="未开放查看，仅系统管理员可见。" onToggle={(scopeId) => onScopeToggle("read_scope_ids", scopeId)} /></section><section className="field-policy-rule"><header><strong>谁能编辑</strong><p>编辑权限不会自动继承查看范围，需要单独开放。</p></header><LevelButtons label="最低权限" value={field.write_min_level} levels={ACCESS_LEVELS.slice(1)} onChange={(value) => onLevelChange("write_min_level", value)} /><ScopeChecks selectedIds={field.write_scope_ids} emptyCopy="未开放编辑，仅系统管理员可修改。" onToggle={(scopeId) => onScopeToggle("write_scope_ids", scopeId)} /></section></div>;
}

function FieldEditor({ field, heading, onChange, onSubmit, onCancel }: { field: typeof EMPTY_FIELD; heading: string; onChange: (field: typeof EMPTY_FIELD) => void; onSubmit: (event: React.FormEvent) => void; onCancel: () => void }) {
  return <form className="admin-field-form" onSubmit={onSubmit}><div className="admin-detail-heading"><div><h3>{heading}</h3><p>登记字段后，分别设置谁能查看和编辑。</p></div></div><div className="admin-form-grid"><label>字段名称<input required maxLength={100} value={field.name} onChange={(event) => onChange({ ...field, name: event.target.value })} /></label><label>业务区域<select value={field.area} onChange={(event) => onChange({ ...field, area: event.target.value })}>{["采购", "研发", "销售", "总经办", "知识库", "其他"].map((area) => <option key={area} value={area}>{area}</option>)}</select></label><label className="admin-form-grid__wide">字段说明<textarea required maxLength={300} rows={3} value={field.description} onChange={(event) => onChange({ ...field, description: event.target.value })} /></label></div><FieldPolicyControls field={{ ...field, id: "new" }} onLevelChange={(key, value) => onChange({ ...field, [key]: value })} onScopeToggle={(key, scopeId) => onChange({ ...field, [key]: toggleId(field[key], scopeId) })} /><div className="admin-form-actions"><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" type="submit">创建字段</button></div></form>;
}

function LevelButtons({ label, value, levels, onChange }: { label: string; value: AccessLevel; levels: typeof ACCESS_LEVELS; onChange: (value: AccessLevel) => void }) {
  return <fieldset className="field-policy-levels"><legend>{label}</legend><div className="policy-switch">{levels.map((level) => <button className={value === level.id ? "is-active" : ""} type="button" key={level.id} aria-pressed={value === level.id} onClick={() => onChange(level.id)}>{level.label}</button>)}</div></fieldset>;
}

function FontSizeSetting({ value, onChange }: { value: UiFontSize; onChange: (size: UiFontSize) => void }) {
  const selected = UI_FONT_SIZES[value - 1];
  const sliderStyle = { "--ui-font-progress": `${(value - 1) * 25}%` } as CSSProperties;
  return <section className="ui-preferences"><h2>常规设置</h2><div className="ui-font-setting"><div><strong id="ui-font-size-title">界面字号</strong><p>调整导航、正文、表格和表单文字大小。</p></div><div className="ui-font-control"><div className="ui-font-current" aria-live="polite"><span>当前</span><strong>{selected.label}</strong></div><input className="ui-font-range" type="range" min="1" max="5" step="1" value={value} aria-labelledby="ui-font-size-title" aria-valuetext={selected.label} style={sliderStyle} onChange={(event) => onChange(Number(event.currentTarget.value) as UiFontSize)} /><div className="ui-font-ticks" role="group" aria-label="字号档位">{UI_FONT_SIZES.map((option) => <button key={option.id} type="button" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>{option.label}</button>)}</div></div></div></section>;
}

function SettingsGroup({ id, title, description, summary, children }: { id: string; title: string; description: string; summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
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
      <span className="settings-group-copy"><strong>{title}</strong><span>{description}</span></span>
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
  const [issueUrl, setIssueUrl] = useState("");
  const [pullRequestUrl, setPullRequestUrl] = useState("");
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
  const clearGate = () => { setActivationTarget(null); setReviews([]); setIssueUrl(""); setPullRequestUrl(""); };
  const chooseMode = (kind: "module" | "workbench", id: Section | WorkbenchId, mode: ModuleMode) => {
    if (environment === "production" && mode === "active") { setActivationTarget(kind === "module" ? { kind, id: id as Section } : { kind, id: id as WorkbenchId }); setReviews([]); return; }
    const update = kind === "module" ? onModeChange(id as Section, mode) : onWorkbenchModeChange(id as WorkbenchId, mode);
    void update.catch(() => undefined);
  };
  const confirmActivation = () => {
    if (!activationTarget || reviews.length !== 4 || !issueUrl.trim() || !pullRequestUrl.trim()) return;
    const update = activationTarget.kind === "module"
      ? onModeChange(activationTarget.id, "active", reviews, issueUrl.trim(), pullRequestUrl.trim())
      : onWorkbenchModeChange(activationTarget.id, "active", reviews, issueUrl.trim(), pullRequestUrl.trim());
    void update.then(clearGate).catch(() => undefined);
  };
  return <section className="admin-settings-section settings-general"><h2>常规设置</h2><div className="environment-summary" data-environment={environment ?? "unknown"}><div><strong>{environment === "test" ? "测试环境" : environment === "production" ? "正式环境" : "环境状态未知"}</strong><p>{environment === "test" ? "使用独立账号与数据，不影响正式服务。" : environment === "production" ? "仅部署已审核的发布版本。" : "本地服务连接后显示当前环境。"}</p></div>{pendingCount > 0 && <span>{pendingCount} 项待重启</span>}</div>{isAdmin && <SettingsGroup id="module-settings" title="功能模块" description="状态只影响当前服务器；关闭时入口和业务接口同时停用。" summary={moduleRegistryState === "ready" ? `${enabledCount} 个运行中` : moduleRegistryState === "loading" ? "读取中" : "状态不可用"}><div className="module-settings__list">{visibleModules.map((item) => { const Icon = item.icon; const publicMode = moduleStatuses.find((module) => module.id === item.id)?.mode ?? "off"; const managed = adminModuleSettings?.modules.find((module) => module.id === item.id); const currentMode = managed?.current_mode ?? publicMode; const pendingMode = managed?.pending_mode ?? currentMode; const hasPending = currentMode !== pendingMode; return <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><Icon size={16} /></span><div><strong>{item.label}</strong><p>{item.description}{hasPending ? ` · 当前${modeLabel(currentMode)}` : ""}</p></div>{isAdmin && adminModuleSettings ? <select aria-label={`${item.label}状态`} value={pendingMode} data-pending={hasPending} onChange={(event) => chooseMode("module", item.id, event.target.value as ModuleMode)}><option value="off">关闭</option><option value="prototype">原型</option><option value="active">启用</option></select> : <span className="module-mode-label" data-mode={currentMode}>{modeLabel(currentMode)}</span>}</div>; })}</div></SettingsGroup>}{isAdmin && <SettingsGroup id="workbench-settings" title="职能工作台" description="每个工作台独立启用、停用和回退。" summary={workbenchRegistryState === "ready" ? `${visibleWorkbenches.length} 个工作台` : workbenchRegistryState === "loading" ? "读取中" : "状态不可用"}><div className="module-settings__list">{visibleWorkbenches.map((item) => { const managed = adminModuleSettings?.workbenches.find((workbench) => workbench.id === item.id); const currentMode = managed?.current_mode ?? workbenchStatuses.find((workbench) => workbench.id === item.id)?.mode ?? "off"; const pendingMode = managed?.pending_mode ?? currentMode; const hasPending = currentMode !== pendingMode; return <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><PanelsTopLeft size={16} /></span><div><strong>{item.label}</strong><p>{item.description}{hasPending ? ` · 当前${modeLabel(currentMode)}` : ""}</p></div>{isAdmin && adminModuleSettings ? <select aria-label={`${item.label}状态`} value={pendingMode} data-pending={hasPending} onChange={(event) => chooseMode("workbench", item.id, event.target.value as ModuleMode)}><option value="off">关闭</option><option value="prototype">原型</option><option value="active">启用</option></select> : <span className="module-mode-label" data-mode={currentMode}>{modeLabel(currentMode)}</span>}{item.id === "procurement" && grantsEntry}</div>; })}</div></SettingsGroup>}{!isAdmin && <section className="module-settings" aria-labelledby="available-settings-title"><div className="module-settings__heading"><strong id="available-settings-title">可用功能</strong></div><div className="module-settings__list">{visibleModules.filter((item) => item.id !== "workbench").map((item) => { const Icon = item.icon; return <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><Icon size={16} /></span><div><strong>{item.label}</strong><p>{item.description}</p></div><span className="module-mode-label" data-mode="active">已启用</span></div>; })}{visibleWorkbenches.map((item) => <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><PanelsTopLeft size={16} /></span><div><strong>{item.label}</strong><p>{item.description}</p></div><span className="module-mode-label" data-mode="active">已启用</span>{item.id === "procurement" && grantsEntry}</div>)}</div>{(moduleRegistryState !== "ready" || workbenchRegistryState !== "ready") ? <p className="settings-availability-note" role="status">{moduleRegistryState === "error" || workbenchRegistryState === "error" ? "可用功能暂时无法读取，请刷新重试。" : "正在读取可用功能…"}</p> : visibleModules.every((item) => item.id === "workbench") && visibleWorkbenches.length === 0 && <p className="settings-availability-note">暂无可用功能。</p>}</section>}{activationTarget && <div className="production-review-gate"><strong>确认正式启用</strong><p>四项检查与对应开发记录必须已经实际完成。</p><div>{([ ["business", "业务负责人确认"], ["security", "数据安全审查"], ["code", "代码审查"], ["rollback", "回退演练"] ] as const).map(([id, label]) => <label key={id}><input type="checkbox" checked={reviews.includes(id)} onChange={() => setReviews(toggleId(reviews, id) as ActivationReview[])} />{label}</label>)}</div><div className="production-review-evidence"><label>Issue 地址<input type="url" value={issueUrl} placeholder="https://github.com/…/issues/…" onChange={(event) => setIssueUrl(event.target.value)} /></label><label>PR 地址<input type="url" value={pullRequestUrl} placeholder="https://github.com/…/pull/…" onChange={(event) => setPullRequestUrl(event.target.value)} /></label></div><div className="admin-form-actions"><button className="secondary-button" type="button" onClick={clearGate}>取消</button><button className="primary-button" type="button" disabled={reviews.length !== 4 || !issueUrl.trim() || !pullRequestUrl.trim()} onClick={confirmActivation}>保存为待启用</button></div></div>}<section className="settings-security" aria-labelledby="settings-security-title"><h3 id="settings-security-title" className="settings-subheading">运行与安全</h3><div className="settings-security-row"><span className="settings-security-icon"><Server size={19} /></span><div><strong>本地服务</strong><p>{serviceCopy.label === "已连接" ? "工作台与本地服务连接正常" : serviceCopy.label === "连接中" ? "正在检查工作台服务连接" : "服务尚未连接，请启动服务后刷新"}</p></div><span className={`setting-connection setting-connection--${serviceCopy.label === "已连接" ? "online" : serviceCopy.label === "连接中" ? "checking" : "offline"}`}><i />{serviceCopy.label}</span></div><div className="settings-security-row"><span className="settings-security-icon"><ShieldCheck size={19} /></span><div><strong>访问保护</strong><p>按账号权限限制查看和操作</p></div><span className="setting-enabled"><Check size={14} />已启用</span></div></section></section>;
}

function SettingsState({ copy, error = false }: { copy: string; error?: boolean }) { return <div className={error ? "settings-state is-error" : "settings-state"}>{copy}</div>; }
function toggleId<T extends string>(ids: T[], id: T): T[] { return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]; }
function setScopeLevel(levels: Partial<Record<AccessScope, AccessLevel>>, scopeId: AccessScope, level: AccessLevel | null) { const updated = { ...levels }; if (level === null) delete updated[scopeId]; else updated[scopeId] = level; return updated; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
