import { Check, ChevronRight, Eye, EyeOff, Info, KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { changeMyPassword, fetchPersonalProfile } from "../api";
import { DiscardChangesDialog, SettingsGroup, useFadingScrollbars } from "./SettingsDialog";
import type { CurrentUser, PersonalProfile } from "../types";

const SCOPE_NAMES: Record<string, string> = { procurement: "采购工作台", research: "研发工作台", sales: "销售工作台", management: "总经办工作台", knowledge: "知识库" };
const LEVEL_NAMES: Record<number, string> = { 2: "查看", 3: "编辑", 4: "管理" };

function PasswordInput({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const [visible, setVisible] = useState(false);
  const hasValue = String(props.value ?? "").length > 0;
  useEffect(() => { if (!hasValue) setVisible(false); }, [hasValue]);
  return <span className="personal-password-input"><input {...props} type={visible && hasValue ? "text" : "password"} /><button type="button" className="personal-password-eye" data-visible={hasValue} aria-hidden={!hasValue} tabIndex={hasValue ? 0 : -1} aria-label={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={visible} disabled={props.disabled || !hasValue} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}</button></span>;
}

export function ProfileDialog({ onClose, onUserChanged, onPasswordChanged, beforePasswordChange }: {
  onClose: () => void;
  onUserChanged: (user: CurrentUser) => void;
  onPasswordChanged: (message: string) => void;
  beforePasswordChange: () => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useFadingScrollbars(dialog);
  const busy = useRef(false);
  const [profile, setProfile] = useState<PersonalProfile | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => { const refresh = () => setReload(n => n + 1); window.addEventListener("activation-grants-changed", refresh); return () => window.removeEventListener("activation-grants-changed", refresh); }, []);
  const [expanded, setExpanded] = useState(false);
  const [instant, setInstant] = useState(false);
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(pattern => pattern.test(passwords.new_password)).length;
  const strength = passwords.new_password.length < 8 || /^(.)\1+$/.test(passwords.new_password) || /^(1234567890?|password|qwerty|admin)/i.test(passwords.new_password) ? "较弱" : passwords.new_password.length >= 12 && variety >= 3 ? "较高" : "一般";
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirty = Object.values(passwords).some(Boolean);

  useEffect(() => {
    const trigger = document.querySelector<HTMLButtonElement>(".profile-trigger");
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); trigger?.focus(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    void fetchPersonalProfile(controller.signal).then((data) => {
      if (!controller.signal.aborted) { setProfile(data); onUserChanged(data); }
    }).catch(() => { if (!controller.signal.aborted) setLoadError("我的账号读取失败，请重试；登录失效时请重新登录。"); });
    return () => controller.abort();
  }, [reload, onUserChanged]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty || busy.current) event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);


  const close = () => {
    if (busy.current) return;
    if (dirty) { setDiscardOpen(true); return; }
    onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    if (passwords.new_password !== passwords.confirm_password) { setError("两次新密码不一致，请重新核对。"); return; }
    if (passwords.current_password === passwords.new_password) { setError("新密码不能与当前密码相同。"); return; }
    if (!beforePasswordChange()) return;
    busy.current = true;
    setSubmitting(true);
    setError("");
    try {
      const result = await changeMyPassword(passwords);
      setPasswords({ current_password: "", new_password: "", confirm_password: "" });
      onPasswordChanged(result.message);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "密码修改失败，请重试。"); }
    finally { busy.current = false; setSubmitting(false); }
  };

  return <dialog ref={dialog} className="settings-dialog personal-profile" aria-labelledby="personal-profile-title"
    onCancel={(event) => { event.preventDefault(); if (discardOpen) { setDiscardOpen(false); dialog.current?.querySelector<HTMLButtonElement>("header button")?.focus(); } else close(); }}
    onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }}>
    <header><h1 id="personal-profile-title">我的账号</h1><button className="icon-button" type="button" aria-label="关闭我的账号" autoFocus disabled={submitting} onClick={close}><X size={18} /></button></header>
    {discardOpen && <DiscardChangesDialog description="关闭后，未保存的密码输入将不会保留。" confirmLabel="放弃并关闭" onCancel={() => setDiscardOpen(false)} onDiscard={onClose} />}
    <div className="personal-profile__body">
      {loadError ? <div role="alert"><p>{loadError}</p><button className="secondary-button" onClick={() => setReload((value) => value + 1)}>重新读取</button></div> : !profile ? <p role="status">正在读取我的账号…</p> : <>
        <div className="personal-profile__identity"><span className="avatar" aria-hidden="true">{Array.from(profile.display_name)[0]}</span><div><div className="personal-profile__name"><strong>{profile.display_name}</strong>{profile.is_system_admin && <span className="personal-profile__role">管理员</span>}</div><p><span aria-label={`登录账号：${profile.username}`}>{profile.username}</span><span aria-hidden="true"> · </span><span aria-label={`部门：${profile.department || "未分配"}`}>{profile.department || "未分配"}</span></p></div></div>
        {!!profile.departments?.some(d => !d.is_primary) && <p className="personal-profile__hint">兼属：{profile.departments.filter(d => !d.is_primary).map(d => d.name).join('、')}</p>}
        <div className="personal-profile__scroll" tabIndex={0} role="region" aria-label="我的权限与密码设置">
        <section className="personal-profile__access personal-account-permissions" aria-label="我的权限">
          <SettingsGroup id="my-permissions" title="我的权限" description="查看功能模块与职能工作台的授权范围。" summary={profile.is_system_admin ? "系统管理员" : `${Object.keys(profile.scope_levels).length} 项已授权`}>
            {profile.is_system_admin && <p className="personal-profile__hint">拥有全部业务范围和系统管理权限。</p>}
            {[{ id: "modules", title: "功能模块", scopes: ["knowledge"] }, { id: "workbenches", title: "职能工作台", scopes: ["procurement", "research", "sales", "management"] }].map(group => ({ ...group, scopes: group.scopes.filter(scope => profile.is_system_admin || (profile.scope_levels[scope as keyof typeof profile.scope_levels] ?? 0) >= 2) })).filter(group => group.scopes.length > 0).map(group => <SettingsGroup key={group.id} id={"my-permissions-" + group.id} title={group.title} description={group.id === "modules" ? "查看各功能模块的访问权限。" : "查看各工作台的业务操作权限。"} summary={`${group.scopes.length} 项已授权`}>
              {group.scopes.map(scope => <div className="personal-account-scope" key={scope}>
                <div className="personal-account-scope-heading"><span>{SCOPE_NAMES[scope]}</span><span>{profile.is_system_admin ? "管理" : LEVEL_NAMES[profile.scope_levels[scope as keyof typeof profile.scope_levels]!] || "未授权"}</span></div>
                {(scope === "procurement" || scope === "research") && <div className="personal-capabilities">
                  {[{ id: "activate", label: scope === "research" ? "成本启用" : "价格启用", allowed: profile[scope === "research" ? "research_capabilities" : "procurement_capabilities"].can_activate, help: scope === "research" ? "核对并启用研发成本和配方，可启用本人或他人保存的草稿。不包含停用配方权限。" : "将已确认的采购价格启用为当前价格。录入、修改价格以工作台授权等级为准。" }, { id: "grants", label: "启用权分配", allowed: profile[scope === "research" ? "research_capabilities" : "procurement_capabilities"].can_manage_grants, help: "授予或撤销其他人在本工作台的启用权，不包含账号管理或其他业务授权。" }].map(item => <div className="personal-capability" key={item.id}>
                    <div className="personal-capability-row"><span>{item.label}<button type="button" className="personal-capability-help" aria-label={item.label + "说明：" + item.help} title={item.help}><Info size={13} /></button></span><span>{item.allowed ? "已授权" : "未授权"}</span></div>
                  </div>)}
                </div>}
              </div>)}
            </SettingsGroup>)}
            <p className="personal-profile__hint">{!profile.is_system_admin && !Object.values(profile.scope_levels).some(level => level >= 2) ? "暂无已授权的功能模块或工作台。" : "业务功能仍受模块启用状态限制。"}</p>
          </SettingsGroup>
        </section>
        <section className="personal-profile__security" aria-label="账号安全">
          <button className="personal-profile__password-toggle" type="button" aria-expanded={expanded} aria-controls="profile-password-form" disabled={submitting} onClick={(event) => { setInstant(event.detail === 0); setExpanded(!expanded); }}><span><KeyRound size={16} />修改密码</span><ChevronRight size={16} /></button>
          <div className="personal-profile__collapse" data-open={expanded} data-instant={instant} aria-hidden={!expanded} inert={!expanded}><div>
            <form id="profile-password-form" className="personal-profile__password-form" onSubmit={submit} aria-busy={submitting}>
              <label>当前密码<PasswordInput label="当前密码" autoComplete="current-password" required maxLength={1000} disabled={submitting} value={passwords.current_password} onChange={(event) => setPasswords({ ...passwords, current_password: event.target.value })} /></label>
              <label>新密码<PasswordInput label="新密码" autoComplete="new-password" aria-describedby={passwords.new_password ? "password-strength" : undefined} required maxLength={1000} disabled={submitting} value={passwords.new_password} onChange={(event) => { setPasswords({ ...passwords, new_password: event.target.value }); setError(""); }} />{passwords.new_password && <span id="password-strength" className="password-strength" data-strength={strength} role="status"><span className="password-strength-line"><span className="password-strength-bars" aria-hidden="true">{[1, 2, 3].map(segment => <span key={segment} data-active={segment <= (strength === "较高" ? 3 : strength === "一般" ? 2 : 1)} />)}</span><span>安全性{strength}</span></span><span className="password-advice">仅供参考，不影响保存</span></span>}</label>
              <label>确认新密码<PasswordInput label="确认新密码" autoComplete="new-password" aria-describedby={passwords.confirm_password ? "password-match" : undefined} aria-invalid={!!passwords.confirm_password && passwords.new_password !== passwords.confirm_password} required maxLength={1000} disabled={submitting} value={passwords.confirm_password} onChange={(event) => { setPasswords({ ...passwords, confirm_password: event.target.value }); setError(""); }} />{passwords.confirm_password && <span id="password-match" className="password-advice" data-match={passwords.new_password === passwords.confirm_password} role="status">{passwords.new_password === passwords.confirm_password ? <><Check size={13} aria-hidden="true" />两次密码一致</> : "两次密码不一致，请核对"}</span>}</label>
              {error && <p className="login-error" role="alert">{error}</p>}
              <div className="admin-form-actions"><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "正在修改…" : "修改密码并重新登录"}</button></div>
            </form>
          </div></div>
        </section>
        </div>
      </>}
    </div>
  </dialog>;
}
