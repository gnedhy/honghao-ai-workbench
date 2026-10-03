import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CalendarDays, Pencil, X } from "lucide-react";
import { adjustProcurementPrice, fetchProcurementMaterial, updateProcurementMaterial } from "../api";
import type { ResearchMaterialDetail } from "../types";
import { DiscardChangesDialog, useExitTransition, useUnsavedChanges } from "../components/Interaction";
import { WorkbenchLoading } from "../components/WorkbenchLayout";
import { PRICE_REASONS, resolveReason, type ReasonSelection } from "./procurementReasons";
import { usePricePreview, PriceReview, ReasonSelect } from "./procurementPriceEditing";
import { MaterialPriceBody, focusWithoutScroll, recordDialogKeys } from "./ProcurementMaterialView";
import styles from "../components/WorkbenchSurface.module.css";
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const priceKey=(value:string,date:string,reason:ReasonSelection)=>JSON.stringify([value,date,reason.selected,reason.custom]);

export function ProcurementMaterialDrawer({ batches, materialId, canEdit, canManage, onClose, onChanged, currentPriceDate, startWithNewPrice = false }: { batches: Array<{ id: string; comparison?: { added_material_ids?: string[] } | null }>; materialId: string; canEdit: boolean; canManage: boolean; onClose: () => void; onChanged?: () => void; currentPriceDate?: string; startWithNewPrice?: boolean }) {
  const [detail, setDetail] = useState<ResearchMaterialDetail | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const { closing, close: finishClose } = useExitTransition(onClose);
  const [editing, setEditing] = useState<string | null>(startWithNewPrice ? "new" : null);
  const [identityStep, setIdentityStep] = useState<"edit" | "confirm" | null>(null);
  const [discardTarget, setDiscardTarget] = useState<"panel" | "drawer" | null>(null);
  const [identityCode, setIdentityCode] = useState("");
  const [panelClosing, setPanelClosing] = useState(false);
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (panelTimer.current !== null) clearTimeout(panelTimer.current); }, []);
  const [saving, setSaving] = useState(false);
  const [priceValue, setPriceValue] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(() => currentPriceDate ?? today());
  const [reason, setReason] = useState<ReasonSelection>({ selected: "", custom: "" });
  const [error, setError] = useState("");
  const [clean, setClean] = useState(()=>priceKey("",effectiveDate,reason));
  const working=useRef(false),mounted=useRef(true),reads=useRef(0);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const dateInput = useRef<HTMLInputElement>(null);
  const load = useCallback((signal?: AbortSignal) => {
    const sequence=++reads.current;
    setLoadState(state => state === "ready" ? state : "loading");
    return fetchProcurementMaterial(materialId, signal)
      .then((value) => { if(mounted.current&&!signal?.aborted&&sequence===reads.current){setDetail(value);setLoadState("ready");} })
      .catch((failure: unknown) => {
        if (mounted.current&&!signal?.aborted&&sequence===reads.current&&!(failure instanceof DOMException && failure.name === "AbortError")) setLoadState("error");
      });
  }, [materialId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  const unsaved = identityStep ? Boolean(detail && identityCode.trim() !== detail.material.code) : Boolean(editing&&priceKey(priceValue,effectiveDate,reason)!==clean);
  const guard=useUnsavedChanges(unsaved,saving,"尚未保存的价格或资料修改将被放弃。","procurement-before-leave");
  const close = (discard = false) => { if (closing || working.current) return; if (unsaved && !discard) { setDiscardTarget("drawer"); return; } setDiscardTarget(null); finishClose(); };
  const closePanel = (saved = false) => {
    if (panelClosing || (!saved && working.current)) return;
    if (!saved && unsaved) { setDiscardTarget("panel"); return; }
    setDiscardTarget(null);
    setPanelClosing(true);
    panelTimer.current = setTimeout(() => { setEditing(null); setIdentityStep(null); setPriceValue(""); setPanelClosing(false); setError(""); panelTimer.current = null; }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--motion-exit")) || 140);
  };
  const startEdit = async (id: string | null, value?: string | null, dateValue?: string) => {
    if(!canEdit||working.current||closing||!await guard.request()||!mounted.current)return;
    if (panelTimer.current !== null) { clearTimeout(panelTimer.current); panelTimer.current = null; }
    const date=dateValue??currentPriceDate??today();
    setIdentityStep(null); setEditing(id ?? "new"); setPanelClosing(false); setPriceValue(value ?? ""); setEffectiveDate(date); setReason({ selected: "", custom: "" }); setClean(priceKey(value??"",date,{selected:"",custom:""}));setError("");
  };
  const startIdentityEdit = async () => {
    if(!canManage||working.current||closing||!await guard.request()||!mounted.current)return;
    if (panelTimer.current !== null) { clearTimeout(panelTimer.current); panelTimer.current = null; }
    if (!detail) return;
    setEditing(null); setIdentityStep("edit"); setPanelClosing(false); setIdentityCode(detail.material.code); setError("");
  };
  const save = async () => {
    if (!canEdit||!detail||working.current||!priceValue||!effectiveDate||!resolveReason(reason)||!pricePreview.data) return;
    working.current=true;setError(""); setSaving(true);
    try {
      if (!detail) return;
      await adjustProcurementPrice(materialId, { price: priceValue, effective_date: effectiveDate, reason: resolveReason(reason), target_history_id: editing === "new" ? null : editing, updated_at: detail.material.updated_at });
      if(!mounted.current)return;
      await load(); if(!mounted.current)return; closePanel(true); onChanged?.();
    } catch (failure) { if(mounted.current){setError(failure instanceof Error ? failure.message : "价格修正失败"); pricePreview.refresh();} }
    finally {working.current=false;if(mounted.current)setSaving(false);}
  };
  const saveIdentity = async () => {
    if(!canManage||!detail||working.current||!identityCode.trim()||identityCode.trim()===detail.material.code)return;
    working.current=true;setError(""); setSaving(true);
    try {
      const value=await updateProcurementMaterial(materialId, { code: identityCode, name: detail.material.name });
      if(!mounted.current)return;reads.current++;setDetail(value);
      closePanel(true); onChanged?.();
    } catch (failure) { if(mounted.current)setError(failure instanceof Error ? failure.message : "原料资料修改失败"); }
    finally {working.current=false;if(mounted.current)setSaving(false);}
  };
  const panelOpen = Boolean(editing || identityStep);
  const pricePreview = usePricePreview(Boolean(editing), effectiveDate, [{ material_id: materialId, price: priceValue }]);
  const identityChanged = Boolean(detail && identityCode.trim() !== detail.material.code);
  const openDatePicker = () => { const input = dateInput.current; input?.focus(); try { input?.showPicker?.(); } catch { /* Native input remains usable. */ } };
  return <div inert={closing} className={`${styles.drawerLayer} ${closing ? styles.closing : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); panelOpen ? closePanel() : close(); } else recordDialogKeys(event); }}>
    {guard.confirmation}<aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="原料价格详情">
      <header className={styles.drawerHeader}><div><span>原料详情</span><h2>{detail ? detail.material.code : "正在读取"}</h2></div><div className={styles.drawerHeaderActions}>{detail && canEdit && <button className="primary-button" type="button" disabled={saving} onClick={() => void startEdit(null)}><Pencil size={14} />录入新价格</button>}{detail && canManage && <button className="secondary-button" type="button" disabled={saving} onClick={() => void startIdentityEdit()}><Pencil size={14} />编辑资料</button>}<button className="icon-button" type="button" aria-label="关闭详情" ref={focusWithoutScroll} disabled={saving} onClick={() => close()}><X size={17} /></button></div></header>
      {loadState === "error" && !detail ? <div className={styles.drawerLoading}><span><strong>原料详情暂时不可用</strong><button className="secondary-button" type="button" onClick={() => void load()}>重新加载</button></span></div> : !detail ? <WorkbenchLoading local title="正在读取原料详情" /> : <MaterialPriceBody detail={detail} batches={batches} notice={loadState === "error" && <p role="alert" className={styles.error}>价格更新失败，当前显示上次读取的内容。<button type="button" onClick={() => void load()}>重试</button></p>}/> }
      {detail && panelOpen && <div className={`${styles.drawerSubpanelLayer}${panelClosing ? ` ${styles.panelClosing}` : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
        <section className={styles.drawerSubpanel} aria-label={editing ? "价格修正" : "原料资料编辑"}>
          {discardTarget && <DiscardChangesDialog description="尚未保存的价格或资料修改将被放弃。" disabled={saving} onCancel={() => setDiscardTarget(null)} onDiscard={() => discardTarget === "drawer" ? close(true) : closePanel(true)}/>}
          {editing && <form className={styles.adjustmentForm} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className={styles.panelHeading}><strong>{editing === "new" ? "录入新价格" : "修正历史记录"}</strong><button type="button" aria-label="取消修正" onClick={() => closePanel()}><X size={14} /></button></div>
            <p className={styles.fieldHint}>录入后加入本轮更新，启用前，最新价格保持不变。</p>
            <label>价格<input autoFocus type="number" min="0" step="0.01" disabled={saving} value={priceValue} onChange={(event) => setPriceValue(event.target.value)} /></label>
            <label>价格日期<div className={styles.dateField} onClick={openDatePicker}><input ref={dateInput} type="date" disabled={saving} value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /><CalendarDays size={15} /></div></label>
            <div className={styles.reasonField}><span>录价说明</span><ReasonSelect label="录价说明" options={PRICE_REASONS} placeholder="请选择说明" value={reason} disabled={saving} onChange={setReason} /></div>
            {pricePreview.data ? <PriceReview preview={pricePreview.data} /> : <p>{pricePreview.error ?? "填写价格后核对价格变化"}{pricePreview.error && <button type="button" onClick={pricePreview.refresh}>重新核对</button>}</p>}
            {error && <p className={styles.error}>{error}<button type="button" onClick={() => { void load(); pricePreview.refresh(); }}>读取最新价格核对（保留输入）</button></p>}
            <button className="primary-button" type="submit" disabled={saving || !priceValue || !effectiveDate || !resolveReason(reason) || !pricePreview.data}>{saving ? "正在写入" : "确认并保存"}</button>
          </form>}
          {identityStep === "edit" && <form className={styles.adjustmentForm} onSubmit={(event) => { event.preventDefault(); setIdentityStep("confirm"); setError(""); }}>
            <div className={styles.panelHeading}><strong>编辑原料资料</strong><button type="button" aria-label="取消编辑" onClick={() => closePanel()}><X size={14} /></button></div>
            <label>原料编号<input autoFocus disabled={saving} readOnly={!canManage} value={identityCode} onChange={(event) => setIdentityCode(event.target.value)} /></label>
            {error && <p className={styles.error}>{error}</p>}
            <button className="primary-button" type="submit" disabled={!identityChanged || !identityCode.trim()}>检查修改</button>
          </form>}
          {identityStep === "confirm" && <div className={styles.adjustmentForm}>
            <div className={styles.panelHeading}><strong>确认资料修改</strong><button type="button" aria-label="取消编辑" onClick={() => closePanel()}><X size={14} /></button></div>
            <div className={styles.identityReview}><span>原料编号</span><strong>{detail.material.code}</strong><ArrowRight size={14} /><strong>{identityCode.trim()}</strong></div>
            {identityCode.trim() !== detail.material.code && <p className={styles.panelNote}>旧编号会保留为导入别名，已发布价格批次不会被改写。</p>}
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.panelActions}><button className="secondary-button" type="button" disabled={saving} onClick={() => setIdentityStep("edit")}>返回编辑</button><button className="primary-button" type="button" disabled={saving} onClick={() => void saveIdentity()}>{saving ? "正在修改" : "确认修改"}</button></div>
          </div>}
        </section>
      </div>}
    </aside>
  </div>;
}
