import { ChevronRight, Info, KeyRound, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { changeMyPassword, fetchPersonalProfile } from "../api";
import type { CurrentUser, PersonalProfile } from "../types";

const SCOPE_NAMES: Record<string, string> = { procurement: "采购工作台", research: "研发工作台", sales: "销售工作台", management: "总经办工作台", knowledge: "知识库" };
const LEVEL_NAMES: Record<number, string> = { 2: "查看", 3: "编辑", 4: "管理" };

export function ProfileDialog({ onClose, onUserChanged, onPasswordChanged, beforePasswordChange }: {
  onClose: () => void;
  onUserChanged: (user: CurrentUser) => void;
  onPasswordChanged: (message: string) => void;
  beforePasswordChange: () => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [profile, setProfile] = useState<PersonalProfile | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [instant, setInstant] = useState(false);
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const dirty = Object.values(passwords).some(Boolean);
  const priceAccess = profile?.procurement_capabilities.can_manage_grants ? "启用与授权管理" : profile?.procurement_capabilities.can_activate ? "仅启用" : "未授权";
  const priceAccessDescription = profile?.procurement_capabilities.can_manage_grants
    ? "可以启用采购价格，也可以授予或撤销其他人的价格启用权。不包含账号管理或其他业务权限。"
    : profile?.procurement_capabilities.can_activate
      ? "可以启用采购价格，不能授予或撤销他人的启用权。"
      : "不能启用采购价格。录入、修改价格仍以已有业务和字段权限为准。";

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
    }).catch(() => { if (!controller.signal.aborted) setLoadError("个人资料读取失败，请重试；登录失效时请重新登录。"); });
    return () => controller.abort();
  }, [reload, onUserChanged]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty || busy.current) event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);

  useEffect(() => { if (discardOpen) keepEditing.current?.focus(); }, [discardOpen]);

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
    <header><h1 id="personal-profile-title">个人资料</h1><button className="icon-button" type="button" aria-label="关闭个人资料" autoFocus disabled={submitting} onClick={close}><X size={18} /></button></header>
    {discardOpen && <section className="personal-profile__discard" role="alertdialog" aria-labelledby="profile-discard-title" aria-describedby="profile-discard-copy"><h2 id="profile-discard-title">放弃密码输入？</h2><p id="profile-discard-copy">密码尚未保存，关闭后需重新输入。</p><div className="admin-form-actions"><button ref={keepEditing} className="secondary-button" type="button" onClick={() => { setDiscardOpen(false); dialog.current?.querySelector<HTMLButtonElement>("header button")?.focus(); }}>继续编辑</button><button className="primary-button" type="button" onClick={onClose}>放弃并关闭</button></div></section>}
    <div className="personal-profile__body" hidden={discardOpen} inert={discardOpen}>
      {loadError ? <div role="alert"><p>{loadError}</p><button className="secondary-button" onClick={() => setReload((value) => value + 1)}>重新读取</button></div> : !profile ? <p role="status">正在读取个人资料…</p> : <>
        <div className="personal-profile__identity"><span className="avatar" aria-hidden="true">{Array.from(profile.display_name)[0]}</span><div><div className="personal-profile__name"><strong>{profile.display_name}</strong>{profile.is_system_admin && <span className="personal-profile__role">系统管理员</span>}</div><p><span aria-label={`登录账号：${profile.username}`}>{profile.username}</span><span aria-hidden="true"> · </span><span aria-label={`部门：${profile.department || "未填写"}`}>{profile.department || "未填写"}</span></p></div></div>
        <div className="personal-profile__access">
          <details><summary><span><ShieldCheck size={16} />访问权限</span><span className="personal-profile__summary">{profile.is_system_admin ? "全部业务范围" : Object.keys(profile.scope_levels).length ? `${Object.keys(profile.scope_levels).length} 项业务范围` : "未授权"}<ChevronRight size={14} /></span></summary>
            <div className="personal-profile__detail">{profile.is_system_admin ? <p>系统管理员，拥有全部业务范围和系统管理权限。</p> : Object.keys(profile.scope_levels).length ? <dl className="personal-profile__rows">{Object.entries(profile.scope_levels).map(([scope, level]) => <div key={scope}><dt>{SCOPE_NAMES[scope] || scope}</dt><dd>{LEVEL_NAMES[level!] || "未授权"}</dd></div>)}</dl> : <p>暂无业务授权，需要使用业务功能时请联系管理员。</p>}</div>
          </details>
          <details className="personal-profile__price-access"><summary><span><ShieldCheck size={16} />采购价格权限</span><span className="personal-profile__summary">{priceAccess}<Info size={14} /></span></summary><div className="personal-profile__detail"><p>{priceAccessDescription}</p><p>业务功能仍受模块启用状态限制。</p></div></details>
        </div>
        <section className="personal-profile__security" aria-label="账号安全">
          <button className="personal-profile__password-toggle" type="button" aria-expanded={expanded} aria-controls="profile-password-form" disabled={submitting} onClick={(event) => { setInstant(event.detail === 0); setExpanded(!expanded); }}><span><KeyRound size={16} />修改密码</span><ChevronRight size={16} /></button>
          <div className="personal-profile__collapse" data-open={expanded} data-instant={instant} aria-hidden={!expanded} inert={!expanded}><div>
            <form id="profile-password-form" className="personal-profile__password-form" onSubmit={submit} aria-busy={submitting}>
              <p id="profile-password-help" className="personal-profile__hint">新密码须为 12–1000 个字符。修改成功后，所有设备需重新登录。</p>
              <label>当前密码<input type="password" autoComplete="current-password" required maxLength={1000} disabled={submitting} value={passwords.current_password} onChange={(event) => setPasswords({ ...passwords, current_password: event.target.value })} /></label>
              <label>新密码<input type="password" autoComplete="new-password" aria-describedby="profile-password-help" required minLength={12} maxLength={1000} disabled={submitting} value={passwords.new_password} onChange={(event) => setPasswords({ ...passwords, new_password: event.target.value })} /></label>
              <label>确认新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={1000} disabled={submitting} value={passwords.confirm_password} onChange={(event) => setPasswords({ ...passwords, confirm_password: event.target.value })} /></label>
              {error && <p className="login-error" role="alert">{error}</p>}
              <div className="admin-form-actions"><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "正在修改…" : "修改密码并重新登录"}</button></div>
            </form>
          </div></div>
        </section>
      </>}
    </div>
    {profile && !discardOpen && <footer className="personal-profile__note">姓名与部门由管理员维护 · 登录账号不可修改</footer>}
  </dialog>;
}
