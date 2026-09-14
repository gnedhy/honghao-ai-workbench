import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ArrowLeft, X, ImagePlus, LockKeyhole, UserRound, Check, ChevronDown } from "lucide-react";
import type { CurrentUser } from "../types";
import { DiscardChangesDialog, useExitTransition } from "./Interaction";
import "./FeedbackDialog.css";
import procurementStyles from "./WorkbenchSurface.module.css";

type Feedback = {
  id: string; owner_id: string; owner_name: string; kind: string; text: string;
  context: string; version: string; created_at: string; status: string; result: string;
  result_at: string | null; revision: number; unread: boolean; has_image: boolean;
};
const statuses = ["待处理", "处理中", "已处理"];
export type FeedbackDraft = { kind: string; text: string; image: string };
export const emptyFeedbackDraft: FeedbackDraft = { kind: "问题反馈", text: "", image: "" };
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
class FeedbackError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(path = "", method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/feedback${path}`, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new FeedbackError(typeof data?.detail === "string" ? data.detail : "操作未完成，请稍后重试。", response.status);
  return data as T;
}

export function FeedbackDialog({ currentUser, context, version, onClose, onUnreadChanged, draft, onDraftChange }: {
  currentUser: CurrentUser; context: string; version: string; onClose: () => void; onUnreadChanged: () => void;
  draft: FeedbackDraft; onDraftChange: Dispatch<SetStateAction<FeedbackDraft>>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const backButton = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const fileSequence = useRef(0);
  const { closing, close } = useExitTransition(onClose);
  const [records, setRecords] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const hasDraft = !!(draft.text || draft.image || draft.kind !== "问题反馈");
  const [view, setView] = useState<"list" | "new" | "detail">(hasDraft ? "new" : "list");
  const [selected, setSelected] = useState<Feedback | null>(null);
  const [filter, setFilter] = useState("全部");
  const [onlyMine, setOnlyMine] = useState(false);
  const { kind, text, image } = draft;
  const setKind = (kind: string) => onDraftChange(old => ({ ...old, kind }));
  const setText = (text: string) => onDraftChange(old => ({ ...old, text }));
  const setImage = (image: string) => onDraftChange(old => ({ ...old, image }));
  const [status, setStatus] = useState("待处理");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<(() => void) | null>(null);
  const admin = currentUser.is_system_admin;
  const dirty = view === "new" ? !!(text || image || kind !== "问题反馈") : view === "detail" && admin && !!selected && (status !== selected.status || result !== (selected.result || ""));

  async function refresh() {
    const rows = await request<Feedback[]>();
    setRecords(rows);
    return rows;
  }
  useEffect(() => {
    const previous = previousFocus.current;
    dialog.current?.showModal();
    let active = true;
    request<Feedback[]>().then(rows => { if (active) setRecords(rows); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    const element = dialog.current;
    return () => { active = false; fileSequence.current++; element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  useEffect(() => { bodyRef.current?.scrollTo(0, 0); if (view !== "list") backButton.current?.focus(); }, [view]);

  function leave(action: () => void) {
    if (busyRef.current || imageLoading || closing) return;
    if (dirty && view === "detail") setPending(() => action); else action();
  }
  function list() { setView("list"); setError(""); void refresh().catch(e => setError(e.message)); }
  async function open(row: Feedback) {
    if (busyRef.current) return;
    setSelected(row); setStatus(row.status); setResult(row.result || ""); setError(""); setNotice(""); setView("detail");
    if (!row.unread) return;
    try {
      await request(`/${encodeURIComponent(row.id)}/read`, "POST", { revision: row.revision });
      setRecords(old => old.map(item => item.id === row.id ? { ...item, unread: false } : item));
      onUnreadChanged();
    } catch { setError("未能标记已读，消息提醒已保留。"); }
  }
  async function chooseImage(file?: File) {
    if (!file) return;
    const sequence = ++fileSequence.current;
    setImage(""); setError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024 || !file.size) { setError("请选择 5 MB 以内的 PNG、JPG 或 WebP 图片。"); return; }
    setImageLoading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("图片无法读取。")); reader.readAsDataURL(file); });
      await new Promise<void>((resolve, reject) => { const picture = new Image(); picture.onload = () => resolve(); picture.onerror = () => reject(new Error("图片无法读取，请重新选择。")); picture.src = data; });
      if (sequence === fileSequence.current) setImage(data);
    } catch (e) { if (sequence === fileSequence.current) setError((e as Error).message); }
    finally { if (sequence === fileSequence.current) setImageLoading(false); }
  }
  async function save() {
    if (busyRef.current || imageLoading) return;
    if (view === "new" && !text.trim()) { setError("请填写反馈内容。"); return; }
    if (view === "detail" && status === "已处理" && !result.trim()) { setError("请填写处理结果，再标记为已处理。"); return; }
    if (view === "detail" && status !== "已处理" && result.trim()) { setError("填写处理结果后，请选择已处理再保存。"); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (view === "new") {
        await request("", "POST", { kind, text: text.trim(), context, version, ...(image ? { image } : {}) });
        setText(""); setImage(""); setKind("问题反馈"); setFilter("全部"); setView("list"); setNotice("反馈已提交，处理结果会在这里通知你。");
      } else if (selected) {
        const updated = await request<Feedback>(`/${encodeURIComponent(selected.id)}`, "PATCH", { status, result: result.trim(), revision: selected.revision });
        setSelected(updated); setStatus(updated.status); setResult(updated.result || "");
        setNotice(status === "已处理" ? "处理结果已保存。" : "处理状态已保存。");
      }
      onUnreadChanged();
      await refresh().catch(() => setError("已保存，但列表刷新失败，请返回列表重试。"));
    } catch (e) {
      if (e instanceof FeedbackError && e.status === 409 && selected) {
        try { const rows = await refresh(); const latest = rows.find(row => row.id === selected.id); if (latest) setSelected(latest); } catch { /* Keep the original revision so another save cannot overwrite newer data. */ }
        setError("该反馈已被其他管理员更新。你的输入已保留，请核对最新状态后再保存。");
      } else setError((e as Error).message);
    } finally { busyRef.current = false; setBusy(false); }
  }
  const rows = records.filter(row => (admin || row.owner_id === currentUser.id) && (!onlyMine || row.owner_id === currentUser.id) && (filter === "全部" || row.status === filter));
  return <dialog inert={closing} ref={dialog} className="feedback-dialog" data-closing={closing || undefined} aria-labelledby="feedback-title" onClick={event => { if (view === "list" && event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) leave(close); } }} onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); event.stopPropagation(); if (!pending) leave(close); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <div className="feedback-window" inert={!!pending || closing}>
      <header className="feedback-header">
        {view !== "list" && <button ref={backButton} className="feedback-icon" aria-label="返回列表" title="返回列表" disabled={busy || imageLoading} onClick={() => leave(list)}><ArrowLeft size={19} /></button>}
        <h2 id="feedback-title">{view === "new" ? "新建反馈" : view === "detail" ? "反馈详情" : admin ? "用户反馈" : "我的反馈"}</h2>
        {view === "list" && <button className="secondary-button" onClick={() => { setError(""); setNotice(""); setView("new"); }}>{hasDraft ? "继续填写" : "新建反馈"}</button>}
        <button className="feedback-icon" aria-label="关闭反馈" disabled={busy || imageLoading} onClick={() => leave(close)}><X size={19} /></button>
      </header>
      <div key={view} className="feedback-body" data-view={view} ref={bodyRef}>
        {notice && <p className="feedback-notice" role="status">{notice}</p>}
        {view === "list" && <>
          <div className="feedback-toolbar"><span>{loading ? "正在加载…" : `${rows.length} 条反馈`}</span><div>{admin && <button type="button" className="feedback-mine" aria-pressed={onlyMine} onClick={() => setOnlyMine(!onlyMine)}><UserRound size={14} />仅看我提交的{onlyMine && <Check size={14} />}</button>}<details className={`${procurementStyles.columnMenu} ${procurementStyles.personMenu} feedback-filter`} onKeyDown={event => { if (event.key === "Escape" && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary aria-label="筛选处理状态">{filter}<ChevronDown size={14} /></summary><div>{["全部", ...statuses].map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={event => { setFilter(value); const menu = event.currentTarget.closest("details"); menu?.removeAttribute("open"); menu?.querySelector("summary")?.focus(); }}>{value}{filter === value && <Check size={14} />}</button>)}</div></details></div></div>
          {!loading && !rows.length && <div className="feedback-empty"><strong>暂无反馈</strong><p>{filter !== "全部" || onlyMine ? "当前筛选下没有反馈。" : "你的问题和建议，会显示在这里。"}</p></div>}
          {rows.map(row => <button className="feedback-item" key={row.id} onClick={() => void open(row)}><span className="feedback-item-copy"><small>{row.kind}</small><strong>{row.text.split("\n")[0]}</strong><small>{admin ? `${row.owner_id === currentUser.id ? "我提交的" : row.owner_name} · ` : ""}{date(row.created_at)}</small></span><span className="feedback-item-right">{row.unread && <span className="feedback-dot" aria-label="未读" />}<span className="feedback-status" data-state={row.status}>{row.status}</span></span></button>)}
        </>}
        {view === "new" && <form id="feedback-compose" onSubmit={e => { e.preventDefault(); void save(); }}>
          <fieldset disabled={busy} className="feedback-compose-fields">
          <small className="feedback-context">草稿在本次登录期间自动保留，刷新页面或退出登录后清空。</small>
          <fieldset className="feedback-kind-options"><legend>反馈类型</legend><div className="feedback-segments sliding-segments">{["问题反馈", "功能建议"].map(value => <label key={value}><input type="radio" name="feedback-kind" value={value} checked={kind === value} onChange={() => setKind(value)} />{value}</label>)}</div></fieldset>
          <div className="feedback-writing"><div className="feedback-label-row"><label htmlFor="feedback-text">反馈内容</label><small>必填</small></div><div className="feedback-editor"><textarea id="feedback-text" required maxLength={2000} value={text} onChange={e => setText(e.target.value)} placeholder="在哪个页面、进行了什么操作、遇到了什么问题？" /><div className="feedback-count">{text.length} / 2000</div></div></div>
          <div className="feedback-attachment-field"><div className="feedback-label-row"><label htmlFor="feedback-file">附加截图 <span>（选填）</span></label></div><div className="feedback-upload-row"><label className="feedback-upload-target" htmlFor="feedback-file">{image ? <img src={image} alt="待提交截图" /> : <ImagePlus size={24} />}<span><strong>{imageLoading ? "正在读取图片…" : image ? "已选择截图，可点击更换" : "添加一张截图"}</strong><small>PNG、JPG、WebP · 最多 5 MB</small></span><span className="feedback-upload-choice">{image ? "更换图片" : "选择图片"}</span><input id="feedback-file" type="file" accept="image/png,image/jpeg,image/webp" disabled={imageLoading} onChange={e => void chooseImage(e.target.files?.[0])} /></label>{image && <button type="button" className="feedback-icon feedback-remove-image" aria-label="移除截图" title="移除截图" onClick={() => { setImage(""); const input = document.getElementById("feedback-file") as HTMLInputElement; if (input) input.value = ""; }}><X size={16} /></button>}</div></div>
          </fieldset>
        </form>}
        {view === "detail" && selected && <>
          <div className="feedback-detail-heading"><strong>{selected.kind}</strong><span className="feedback-status" data-state={selected.status}>{selected.status}</span></div>
          <p className="feedback-meta">{selected.owner_name} · {date(selected.created_at)}</p><p className="feedback-text">{selected.text}</p>
          {selected.has_image && <a className="feedback-attachment" href={`/api/feedback/${encodeURIComponent(selected.id)}/image`} target="_blank" rel="noreferrer"><img src={`/api/feedback/${encodeURIComponent(selected.id)}/image`} alt="反馈截图" /></a>}
          <p className="feedback-context">{selected.context} · 版本 {selected.version}</p>
          {selected.result && <section className="feedback-result"><strong>处理结果</strong><p className="feedback-text">{selected.result}</p>{selected.result_at && <small>{date(selected.result_at)}</small>}</section>}
          {!selected.result && !admin && <p className="feedback-context">{selected.status === "处理中" ? "管理员正在处理，请耐心等待结果。" : "已收到你的反馈，等待管理员处理。"}</p>}
          {admin && <form id="feedback-process" className="feedback-process" onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={busy}><label htmlFor="feedback-status">处理状态</label><select id="feedback-status" value={status} onChange={e => setStatus(e.target.value)}>{statuses.map(value => <option key={value}>{value}</option>)}</select><label htmlFor="feedback-result">处理结果 <span>（完成时必填，对提交人可见）</span></label><textarea id="feedback-result" maxLength={2000} value={result} onChange={e => setResult(e.target.value)} placeholder="说明已做的改进、解决办法或暂不处理的原因。" /></fieldset></form>}
        </>}
      </div>
      {error && <p className="feedback-error" role="alert">{error}{view === "list" && <button onClick={() => { setError(""); setLoading(true); void refresh().catch(e => setError(e.message)).finally(() => setLoading(false)); }}>重试</button>}</p>}
      {view !== "list" && <footer className="feedback-actions">{view === "new" && <small className="feedback-privacy"><LockKeyhole size={14} />仅本人和管理员可查看</small>}{view === "new" && !!(text.trim() || image) && <button className="secondary-button" disabled={busy || imageLoading} onClick={() => setPending(() => () => { onDraftChange(emptyFeedbackDraft); list(); })}>放弃草稿</button>}{view === "detail" && <button className="secondary-button" disabled={busy || imageLoading} onClick={() => leave(list)}>返回列表</button>}{(view === "new" || admin) && <button className="primary-button" type="submit" form={view === "new" ? "feedback-compose" : "feedback-process"} disabled={busy || imageLoading || (view === "new" ? !text.trim() : !dirty)}>{busy ? "正在保存…" : view === "new" ? "提交反馈" : "保存处理"}</button>}</footer>}
    </div>
    {pending && <DiscardChangesDialog {...(view === "new" ? { title: "放弃这份草稿？", description: "反馈类型、正文和截图将被清空。", confirmLabel: "放弃草稿", cancelLabel: "继续填写" } : {})} onCancel={() => setPending(null)} onDiscard={() => { const action = pending; setPending(null); action(); }} />}
  </dialog>;
}
