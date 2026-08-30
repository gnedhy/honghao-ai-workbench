import {
  Check,
  ChevronRight,
  CircleUserRound,
  ClipboardList,
  FolderKanban,
  KeyRound,
  LibraryBig,
  PanelsTopLeft,
  PenLine,
  Plus,
  ShieldCheck,
  UserRoundCog,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createRole,
  createSensitiveField,
  createUser,
  fetchAdminModuleSettings,
  fetchAuditEvents,
  fetchPermissionCatalog,
  fetchRolePermissions,
  fetchRoles,
  fetchSensitiveFields,
  fetchUsers,
  updateRolePermissions,
  updateAdminModuleSetting,
  updateSensitiveField,
  updateUser,
  type ServiceConnection,
} from "../api";
import type {
  ActivationReview,
  AdminModuleSettings,
  AuditEvent,
  CurrentUser,
  ManagedUser,
  ModuleStatus,
  ModuleMode,
  PermissionDefinition,
  RolePermissionPolicy,
  RuntimeEnvironment,
  SensitiveFieldPolicy,
  UserRole,
  Section,
} from "../types";

type SettingsTab = "general" | "accounts" | "permissions" | "audit";
type PolicyView = "modules" | "fields";

const MODULE_OPTIONS = [
  { id: "chat", label: "新聊天", description: "对话、工作模式及会话侧栏", icon: PenLine },
  { id: "knowledge", label: "知识库", description: "个人与公共知识内容", icon: LibraryBig },
  { id: "automation", label: "自动化", description: "技能与工作流管理", icon: WandSparkles },
  { id: "workbench", label: "工作台", description: "企业职能业务工具", icon: PanelsTopLeft },
  { id: "tasks", label: "任务看板", description: "任务管理与运行记录", icon: FolderKanban },
] as const;

const AUDIT_LABELS: Record<string, string> = {
  "login.succeeded": "登录成功",
  "login.failed": "登录失败",
  "role.created": "创建角色",
  "role.permissions.updated": "修改角色权限",
  "field.policy.updated": "修改敏感字段策略",
  "field.created": "新增敏感字段",
  "user.created": "创建账号",
  "user.updated": "修改账号",
  "module.mode.pending": "修改待生效模块状态",
};

type SettingsDialogProps = {
  currentUser: CurrentUser;
  serviceConnection: ServiceConnection;
  moduleStatuses: ModuleStatus[];
  moduleRegistryState: "loading" | "ready" | "error";
  onClose: () => void;
};

export function SettingsDialog({
  currentUser,
  serviceConnection,
  moduleStatuses,
  moduleRegistryState,
  onClose,
}: SettingsDialogProps) {
  const isAdmin = currentUser.roles.some((role) => role.id === "system-admin");
  const [tab, setTab] = useState<SettingsTab>("general");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [permissions, setPermissions] = useState<PermissionDefinition[]>([]);
  const [rolePolicies, setRolePolicies] = useState<RolePermissionPolicy[]>([]);
  const [fields, setFields] = useState<SensitiveFieldPolicy[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [adminModuleSettings, setAdminModuleSettings] = useState<AdminModuleSettings | null>(null);
  const [notice, setNotice] = useState("");
  const [newRoleName, setNewRoleName] = useState("");
  const [newUserOpen, setNewUserOpen] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", display_name: "", department: "", password: "" });
  const [newUserRoleIds, setNewUserRoleIds] = useState<string[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userRoleDraft, setUserRoleDraft] = useState<string[]>([]);
  const [policyView, setPolicyView] = useState<PolicyView>("modules");
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [selectedFieldId, setSelectedFieldId] = useState("");
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const [newField, setNewField] = useState({ area: "采购", name: "", description: "", read_role_ids: [] as string[], write_role_ids: [] as string[] });

  useEffect(() => {
    if (!isAdmin) return;
    setLoadState("loading");
    Promise.all([
      fetchUsers(),
      fetchRoles(),
      fetchPermissionCatalog(),
      fetchRolePermissions(),
      fetchSensitiveFields(),
      fetchAuditEvents(),
      fetchAdminModuleSettings(),
    ]).then(([loadedUsers, loadedRoles, loadedPermissions, loadedRolePolicies, loadedFields, loadedEvents, loadedModuleSettings]) => {
      setUsers(loadedUsers);
      setRoles(loadedRoles);
      setPermissions(loadedPermissions);
      setRolePolicies(loadedRolePolicies);
      setFields(loadedFields);
      setAuditEvents(loadedEvents);
      setAdminModuleSettings(loadedModuleSettings);
      setSelectedUserId(loadedUsers[0]?.id ?? "");
      setSelectedRoleId(loadedRoles.find((role) => role.id !== "system-admin")?.id ?? loadedRoles[0]?.id ?? "");
      setSelectedFieldId(loadedFields[0]?.id ?? "");
      setNewUserRoleIds(loadedRoles.some((role) => role.id === "employee") ? ["employee"] : []);
      setLoadState("ready");
    }).catch(() => setLoadState("error"));
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin || tab !== "audit" || loadState !== "ready") return;
    void fetchAuditEvents().then(setAuditEvents).catch(() => showNotice("审计记录刷新失败"));
  }, [isAdmin, loadState, tab]);

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? null;
  const selectedRolePolicy = rolePolicies.find((policy) => policy.role_id === selectedRoleId) ?? null;
  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? null;

  useEffect(() => {
    setUserRoleDraft(selectedUser?.roles.map((role) => role.id) ?? []);
  }, [selectedUser]);

  const permissionsByModule = useMemo(() => MODULE_OPTIONS.map((module) => ({
    ...module,
    permissions: permissions.filter((permission) => permission.module_id === module.id),
  })).filter((module) => module.permissions.length > 0), [permissions]);

  const serviceCopy = serviceConnection.state === "online"
    ? { label: "已连接", detail: `API ${serviceConnection.health.api_version} · 数据版本 ${serviceConnection.health.schema_version}` }
    : serviceConnection.state === "checking"
      ? { label: "连接中", detail: "正在检查本地 API 与数据库。" }
      : { label: "未连接", detail: "请启动本地 API 后刷新页面。" };
  const enabledCount = moduleStatuses.filter((module) => module.mode !== "off").length;
  const runtimeEnvironment = serviceConnection.state === "online" ? serviceConnection.health.environment : null;

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2200);
  };

  const submitRole = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newRoleName.trim();
    if (!name) return;
    try {
      const created = await createRole(name);
      setRoles((current) => [...current, created]);
      setRolePolicies((current) => [...current, { role_id: created.id, permission_ids: [] }]);
      setNewRoleName("");
      setSelectedRoleId(created.id);
      showNotice("角色已创建");
    } catch {
      showNotice("角色名称已存在或暂时无法创建");
    }
  };

  const submitUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newUserRoleIds.length === 0) {
      showNotice("请至少选择一个角色");
      return;
    }
    try {
      const created = await createUser({
        ...newUser,
        department: newUser.department.trim() || null,
        role_ids: newUserRoleIds,
      });
      setUsers((current) => [...current, created]);
      setNewUser({ username: "", display_name: "", department: "", password: "" });
      setNewUserRoleIds(roles.some((role) => role.id === "employee") ? ["employee"] : []);
      setNewUserOpen(false);
      setSelectedUserId(created.id);
      showNotice("账号已创建");
    } catch {
      showNotice("账号信息有误或账号名已存在");
    }
  };

  const saveUserRoles = async () => {
    if (!selectedUser || userRoleDraft.length === 0) return;
    try {
      const updated = await updateUser(selectedUser.id, { role_ids: userRoleDraft });
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      showNotice("账号角色已更新，原登录会话已失效");
    } catch {
      showNotice("账号角色更新失败");
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

  const togglePermission = (permissionId: string) => {
    if (!selectedRolePolicy || selectedRole?.id === "system-admin") return;
    setRolePolicies((current) => current.map((policy) => policy.role_id === selectedRolePolicy.role_id ? {
      ...policy,
      permission_ids: policy.permission_ids.includes(permissionId)
        ? policy.permission_ids.filter((id) => id !== permissionId)
        : [...policy.permission_ids, permissionId],
    } : policy));
  };

  const savePermissions = async () => {
    if (!selectedRolePolicy || selectedRole?.id === "system-admin") return;
    try {
      const updated = await updateRolePermissions(selectedRolePolicy.role_id, selectedRolePolicy.permission_ids);
      setRolePolicies((current) => current.map((policy) => policy.role_id === updated.role_id ? updated : policy));
      showNotice("角色权限已生效");
    } catch {
      showNotice("角色权限保存失败");
    }
  };

  const toggleFieldRole = (kind: "read_role_ids" | "write_role_ids", roleId: string) => {
    if (!selectedField) return;
    setFields((current) => current.map((field) => field.id === selectedField.id ? {
      ...field,
      [kind]: field[kind].includes(roleId)
        ? field[kind].filter((id) => id !== roleId)
        : [...field[kind], roleId],
    } : field));
  };

  const saveField = async () => {
    if (!selectedField) return;
    try {
      const updated = await updateSensitiveField(selectedField.id, {
        read_role_ids: selectedField.read_role_ids,
        write_role_ids: selectedField.write_role_ids,
      });
      setFields((current) => current.map((field) => field.id === updated.id ? updated : field));
      showNotice("敏感字段开放范围已生效");
    } catch {
      showNotice("敏感字段策略保存失败");
    }
  };

  const submitField = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newField.name.trim() || !newField.description.trim()) return;
    try {
      const created = await createSensitiveField({
        ...newField,
        name: newField.name.trim(),
        description: newField.description.trim(),
      });
      setFields((current) => [...current, created]);
      setSelectedFieldId(created.id);
      setNewField({ area: "采购", name: "", description: "", read_role_ids: [], write_role_ids: [] });
      setNewFieldOpen(false);
      showNotice("敏感字段已新增");
    } catch {
      showNotice("字段名称已存在或暂时无法新增");
    }
  };

  const saveModuleMode = async (
    moduleId: Section,
    mode: ModuleMode,
    reviews: ActivationReview[] = [],
  ) => {
    try {
      const updated = await updateAdminModuleSetting(moduleId, mode, reviews);
      setAdminModuleSettings((current) => current ? {
        ...current,
        modules: current.modules.map((module) => module.id === updated.id ? updated : module),
      } : current);
      showNotice(updated.current_mode === updated.pending_mode ? "模块状态未变化" : "已保存，重启服务后生效");
    } catch {
      showNotice("模块状态保存失败");
      throw new Error("Module mode update failed");
    }
  };

  const navItems: { id: SettingsTab; label: string; icon: typeof CircleUserRound }[] = [
    { id: "general", label: "常规", icon: PanelsTopLeft },
    ...(isAdmin ? [
      { id: "accounts" as const, label: "账号与角色", icon: CircleUserRound },
      { id: "permissions" as const, label: "权限与字段", icon: KeyRound },
      { id: "audit" as const, label: "审计记录", icon: ClipboardList },
    ] : []),
  ];

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog settings-dialog--admin" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><h1 id="settings-title">系统设置</h1><p>{isAdmin ? "管理账号、访问边界和安全记录。" : "查看当前系统运行状态。"}</p></div>
          <button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="settings-dialog__body">
          <nav aria-label="设置分类">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button className={tab === id ? "is-active" : ""} key={id} type="button" onClick={() => setTab(id)}>
                <span><Icon size={15} />{label}</span><ChevronRight size={15} />
              </button>
            ))}
          </nav>
          <article>
            {notice && <div className="settings-notice" role="status"><Check size={14} />{notice}</div>}
            {tab === "general" && <GeneralSettings serviceCopy={serviceCopy} environment={runtimeEnvironment} moduleStatuses={moduleStatuses} moduleRegistryState={moduleRegistryState} enabledCount={enabledCount} isAdmin={isAdmin} adminModuleSettings={adminModuleSettings} onModeChange={saveModuleMode} />}
            {tab !== "general" && loadState === "loading" && <SettingsState copy="正在读取管理数据…" />}
            {tab !== "general" && loadState === "error" && <SettingsState copy="管理数据暂时无法读取，请稍后重试。" error />}
            {tab === "accounts" && loadState === "ready" && (
              <section className="admin-settings-section">
                <div className="admin-section-heading"><div><h2>账号与角色</h2><p>账号由管理员创建；角色变化会使该账号重新登录。</p></div><button className="secondary-button" type="button" onClick={() => setNewUserOpen((open) => !open)}><Plus size={14} />新建账号</button></div>
                {newUserOpen && <form className="admin-create-form" onSubmit={submitUser}>
                  <div className="admin-form-grid">
                    <label>姓名<input required maxLength={100} value={newUser.display_name} onChange={(event) => setNewUser({ ...newUser, display_name: event.target.value })} /></label>
                    <label>账号名<input required maxLength={100} pattern="[A-Za-z0-9._-]+" autoComplete="off" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} /></label>
                    <label>部门<input maxLength={100} value={newUser.department} onChange={(event) => setNewUser({ ...newUser, department: event.target.value })} /></label>
                    <label>初始密码<input required minLength={12} maxLength={1000} type="password" autoComplete="new-password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} /></label>
                  </div>
                  <RoleChecks roles={roles} selectedIds={newUserRoleIds} onToggle={(roleId) => setNewUserRoleIds(toggleId(newUserRoleIds, roleId))} />
                  <div className="admin-form-actions"><button type="button" className="secondary-button" onClick={() => setNewUserOpen(false)}>取消</button><button type="submit" className="primary-button">创建账号</button></div>
                </form>}
                <div className="admin-split">
                  <div className="admin-list-panel">
                    <form className="role-create" onSubmit={submitRole}><input aria-label="新角色名称" maxLength={100} placeholder="新建自定义角色" value={newRoleName} onChange={(event) => setNewRoleName(event.target.value)} /><button type="submit" aria-label="创建角色" disabled={!newRoleName.trim()}><Plus size={14} /></button></form>
                    <p className="admin-list-label">账号 · {users.length}</p>
                    {users.map((user) => <button className={selectedUserId === user.id ? "admin-list-row is-active" : "admin-list-row"} type="button" key={user.id} onClick={() => setSelectedUserId(user.id)}><span className="admin-user-mark">{user.display_name.slice(0, 1)}</span><span><strong>{user.display_name}</strong><small>{user.department || user.username}</small></span><i data-active={user.is_active}>{user.is_active ? "启用" : "停用"}</i></button>)}
                  </div>
                  <div className="admin-detail-panel">
                    {selectedUser ? <>
                      <div className="admin-detail-heading"><div><h3>{selectedUser.display_name}</h3><p>@{selectedUser.username} · {selectedUser.department || "未填写部门"}</p></div><span className="status-chip" data-active={selectedUser.is_active}>{selectedUser.is_active ? "使用中" : "已停用"}</span></div>
                      <RoleChecks roles={roles} selectedIds={userRoleDraft} onToggle={(roleId) => setUserRoleDraft(toggleId(userRoleDraft, roleId))} />
                      <div className="admin-form-actions"><button className="secondary-button" type="button" disabled={selectedUser.id === currentUser.id} onClick={toggleUserActive}>{selectedUser.is_active ? "停用账号" : "启用账号"}</button><button className="primary-button" type="button" disabled={userRoleDraft.length === 0} onClick={saveUserRoles}>保存角色</button></div>
                    </> : <SettingsState copy="请选择一个账号。" />}
                  </div>
                </div>
              </section>
            )}
            {tab === "permissions" && loadState === "ready" && (
              <section className="admin-settings-section">
                <div className="admin-section-heading"><div><h2>权限与敏感字段</h2><p>模块状态、操作权限和字段策略均由服务端执行。</p></div><div className="admin-section-actions"><div className="policy-switch"><button className={policyView === "modules" ? "is-active" : ""} type="button" onClick={() => setPolicyView("modules")}>模块操作</button><button className={policyView === "fields" ? "is-active" : ""} type="button" onClick={() => setPolicyView("fields")}>敏感字段</button></div>{policyView === "fields" && <button className="secondary-button" type="button" onClick={() => setNewFieldOpen(true)}><Plus size={14} />新增字段</button>}</div></div>
                {policyView === "modules" ? <div className="admin-split">
                  <div className="admin-list-panel"><p className="admin-list-label">选择角色</p>{roles.map((role) => <button className={selectedRoleId === role.id ? "admin-list-row is-active" : "admin-list-row"} type="button" key={role.id} onClick={() => setSelectedRoleId(role.id)}><span className="admin-user-mark"><UserRoundCog size={14} /></span><span><strong>{role.name}</strong><small>{role.system ? "系统预置角色" : "自定义角色"}</small></span></button>)}</div>
                  <div className="admin-detail-panel">{selectedRole && selectedRolePolicy ? <><div className="admin-detail-heading"><div><h3>{selectedRole.name}</h3><p>{selectedRole.id === "system-admin" ? "系统管理员固定拥有全部权限。" : "修改后立即影响该角色的现有登录账号。"}</p></div></div><div className="permission-groups">{permissionsByModule.map((module) => <fieldset key={module.id}><legend>{module.label}</legend>{module.permissions.map((permission) => <label key={permission.id}><input type="checkbox" checked={selectedRolePolicy.permission_ids.includes(permission.id)} disabled={selectedRole.id === "system-admin"} onChange={() => togglePermission(permission.id)} /><span><strong>{permission.name}</strong><small>{permission.description}</small></span></label>)}</fieldset>)}</div>{selectedRole.id !== "system-admin" && <div className="admin-form-actions"><button className="primary-button" type="button" onClick={savePermissions}>保存权限</button></div>}</> : <SettingsState copy="请选择一个角色。" />}</div>
                </div> : <div className="admin-split">
                  <div className="admin-list-panel"><p className="admin-list-label">字段目录 · {fields.length}</p>{fields.map((field) => <button className={selectedFieldId === field.id ? "admin-list-row is-active" : "admin-list-row"} type="button" key={field.id} onClick={() => setSelectedFieldId(field.id)}><span className="admin-user-mark"><KeyRound size={14} /></span><span><strong>{field.name}</strong><small>{field.area}</small></span><i>{field.read_role_ids.length + field.write_role_ids.length > 0 ? "已配置" : "仅管理员"}</i></button>)}</div>
                  <div className="admin-detail-panel">{newFieldOpen ? <form className="admin-field-form" onSubmit={submitField}><div className="admin-detail-heading"><div><h3>新增敏感字段</h3><p>登记业务字段并设置可读、可写角色。</p></div></div><div className="admin-form-grid"><label>字段名称<input required maxLength={100} value={newField.name} onChange={(event) => setNewField({ ...newField, name: event.target.value })} /></label><label>业务区域<select value={newField.area} onChange={(event) => setNewField({ ...newField, area: event.target.value })}>{["采购", "研发", "销售", "总经办", "知识库", "其他"].map((area) => <option key={area} value={area}>{area}</option>)}</select></label><label className="admin-form-grid__wide">字段说明<textarea required maxLength={300} rows={3} value={newField.description} onChange={(event) => setNewField({ ...newField, description: event.target.value })} /></label></div><div className="field-role-grid"><RoleChecks title="允许读取" hint="未选择时仅系统管理员可读取" roles={roles.filter((role) => role.id !== "system-admin")} selectedIds={newField.read_role_ids} onToggle={(roleId) => setNewField({ ...newField, read_role_ids: toggleId(newField.read_role_ids, roleId) })} /><RoleChecks title="允许写入" hint="写入权限与读取权限分别控制" roles={roles.filter((role) => role.id !== "system-admin")} selectedIds={newField.write_role_ids} onToggle={(roleId) => setNewField({ ...newField, write_role_ids: toggleId(newField.write_role_ids, roleId) })} /></div><div className="admin-form-actions"><button className="secondary-button" type="button" onClick={() => setNewFieldOpen(false)}>取消</button><button className="primary-button" type="submit">创建字段</button></div></form> : selectedField ? <><div className="admin-detail-heading"><div><h3>{selectedField.name}</h3><p>{selectedField.description}</p></div><span className="status-chip">{selectedField.area}</span></div><div className="field-role-grid"><RoleChecks title="允许读取" hint="未选择时仅系统管理员可读取" roles={roles.filter((role) => role.id !== "system-admin")} selectedIds={selectedField.read_role_ids} onToggle={(roleId) => toggleFieldRole("read_role_ids", roleId)} /><RoleChecks title="允许写入" hint="写入权限与读取权限分别控制" roles={roles.filter((role) => role.id !== "system-admin")} selectedIds={selectedField.write_role_ids} onToggle={(roleId) => toggleFieldRole("write_role_ids", roleId)} /></div><div className="admin-form-actions"><button className="primary-button" type="button" onClick={saveField}>保存字段策略</button></div></> : <SettingsState copy="请选择一个字段。" />}</div>
                </div>}
              </section>
            )}
            {tab === "audit" && loadState === "ready" && <section className="admin-settings-section"><div className="admin-section-heading"><div><h2>审计记录</h2><p>仅记录操作主体、对象和时间，不保存正文及字段值。</p></div><span className="admin-count">最近 {auditEvents.length} 条</span></div><div className="audit-list">{auditEvents.length === 0 ? <SettingsState copy="暂无审计记录。" /> : auditEvents.map((event) => <div className="audit-row" key={event.id}><span className="audit-row__icon"><ClipboardList size={14} /></span><div><strong>{AUDIT_LABELS[event.action] ?? event.action}</strong><p>{event.actor_name ?? "未知账号"} · {event.target_type}</p></div><time dateTime={event.created_at}>{formatDate(event.created_at)}</time></div>)}</div></section>}
          </article>
        </div>
      </section>
    </div>
  );
}

function GeneralSettings({ serviceCopy, environment: serviceEnvironment, moduleStatuses, moduleRegistryState, enabledCount, isAdmin, adminModuleSettings, onModeChange }: {
  serviceCopy: { label: string; detail: string };
  environment: RuntimeEnvironment | null;
  moduleStatuses: ModuleStatus[];
  moduleRegistryState: "loading" | "ready" | "error";
  enabledCount: number;
  isAdmin: boolean;
  adminModuleSettings: AdminModuleSettings | null;
  onModeChange: (moduleId: Section, mode: ModuleMode, reviews?: ActivationReview[]) => Promise<void>;
}) {
  const [activationModule, setActivationModule] = useState<Section | null>(null);
  const [reviews, setReviews] = useState<ActivationReview[]>([]);
  const environment = serviceEnvironment ?? adminModuleSettings?.environment ?? null;
  const pendingCount = adminModuleSettings?.modules.filter((module) => module.current_mode !== module.pending_mode).length ?? 0;
  const modeLabel = (mode: ModuleMode) => mode === "active" ? "启用" : mode === "prototype" ? "原型" : "关闭";
  const chooseMode = (moduleId: Section, mode: ModuleMode) => {
    if (environment === "production" && mode === "active") {
      setActivationModule(moduleId);
      setReviews([]);
      return;
    }
    void onModeChange(moduleId, mode).catch(() => undefined);
  };
  const confirmActivation = () => {
    if (!activationModule || reviews.length !== 3) return;
    void onModeChange(activationModule, "active", reviews).then(() => {
      setActivationModule(null);
      setReviews([]);
    }).catch(() => undefined);
  };
  return <section className="admin-settings-section"><h2>常规</h2><div className="environment-summary" data-environment={environment ?? "unknown"}><div><strong>{environment === "test" ? "测试环境" : environment === "production" ? "正式环境" : "环境状态未知"}</strong><p>{environment === "test" ? "使用独立账号与样例数据，不影响正式服务。" : environment === "production" ? "仅部署已审核的发布版本。" : "本地服务连接后显示当前环境。"}</p></div>{pendingCount > 0 && <span>{pendingCount} 项待重启</span>}</div><section className="module-settings" aria-labelledby="module-settings-title"><div className="module-settings__heading"><div><strong id="module-settings-title">功能模块</strong><p>状态只影响当前服务器；关闭时入口和业务接口同时停用。</p></div><span>{moduleRegistryState === "ready" ? `${enabledCount} 个运行中` : moduleRegistryState === "loading" ? "读取中" : "状态不可用"}</span></div><div className="module-settings__list">{MODULE_OPTIONS.map((item) => { const Icon = item.icon; const publicMode = moduleStatuses.find((module) => module.id === item.id)?.mode ?? "off"; const managed = adminModuleSettings?.modules.find((module) => module.id === item.id); const currentMode = managed?.current_mode ?? publicMode; const pendingMode = managed?.pending_mode ?? currentMode; const hasPending = currentMode !== pendingMode; return <div className="module-setting-row" key={item.id}><span className="module-setting-row__icon"><Icon size={16} /></span><div><strong>{item.label}</strong><p>{item.description}{hasPending ? ` · 当前${modeLabel(currentMode)}` : ""}</p></div>{isAdmin && adminModuleSettings ? <select aria-label={`${item.label}状态`} value={pendingMode} data-pending={hasPending} onChange={(event) => chooseMode(item.id, event.target.value as ModuleMode)}><option value="off">关闭</option><option value="prototype">原型</option><option value="active">启用</option></select> : <span className="module-mode-label" data-mode={currentMode}>{modeLabel(currentMode)}</span>}</div>; })}</div>{activationModule && <div className="production-review-gate"><strong>确认正式启用</strong><p>三项审查必须已经实际完成。</p><div>{([ ["business", "业务负责人"], ["security", "数据安全审查"], ["code", "代码审查"] ] as const).map(([id, label]) => <label key={id}><input type="checkbox" checked={reviews.includes(id)} onChange={() => setReviews(toggleId(reviews, id) as ActivationReview[])} />{label}</label>)}</div><div className="admin-form-actions"><button className="secondary-button" type="button" onClick={() => setActivationModule(null)}>取消</button><button className="primary-button" type="button" disabled={reviews.length !== 3} onClick={confirmActivation}>保存为待启用</button></div></div>}</section><h3 className="settings-subheading">运行与安全</h3><div className="setting-row"><div><strong>本地服务</strong><p>{serviceCopy.detail}</p></div><span className={`setting-connection setting-connection--${serviceCopy.label === "已连接" ? "online" : serviceCopy.label === "连接中" ? "checking" : "offline"}`}><i />{serviceCopy.label}</span></div><div className="setting-row"><div><strong>权限默认拒绝</strong><p>未配置开放范围时，仅系统管理员可以访问。</p></div><span className="setting-enabled"><ShieldCheck size={15} />已保护</span></div></section>;
}

function RoleChecks({ roles, selectedIds, onToggle, title = "分配角色", hint }: { roles: UserRole[]; selectedIds: string[]; onToggle: (roleId: string) => void; title?: string; hint?: string }) {
  return <fieldset className="role-checks"><legend>{title}</legend>{hint && <p>{hint}</p>}<div>{roles.map((role) => <label key={role.id}><input type="checkbox" checked={selectedIds.includes(role.id)} onChange={() => onToggle(role.id)} /><span>{role.name}</span></label>)}</div></fieldset>;
}

function SettingsState({ copy, error = false }: { copy: string; error?: boolean }) {
  return <div className={error ? "settings-state is-error" : "settings-state"}>{copy}</div>;
}

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
