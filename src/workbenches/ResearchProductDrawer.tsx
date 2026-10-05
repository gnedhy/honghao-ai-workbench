import {useCallback,useEffect,useState,useRef} from "react";
import {Pencil,Trash2,ChevronRight} from "lucide-react";
import {fetchJson} from "../api";
import {WorkbenchLoading} from "../components/WorkbenchLayout";
import {DiscardChangesDialog,useUnsavedChanges} from "../components/Interaction";
import {ResearchFormulaEditor} from "./ResearchFormulaEditor";
import {Drawer,ReasonFields,FormulaDetails,HistoricalFormula,Money,Movement} from "./ResearchProductView";
import {type Detail,type Adjustment,type RecordRow,productPath,request,errorText,adjustmentReasons,formulaVersionLabel,recordDate,date} from "./researchModel";
import {costComparisonRecord} from "./researchAnalytics";
import p from "../components/WorkbenchSurface.module.css";
import s from "./ResearchWorkbench.module.css";
export function ResearchProductDrawer({ id, accessLevel, onClose, onChanged }: { id: string; accessLevel: number; onClose: () => void; onChanged: () => void }) {
  const [path, setPath] = useState<string[]>([id]); const current = path[path.length-1];
  const [policy, setPolicy] = useState<"latest" | "inventory">("latest");
  const [detail, setDetail] = useState<Detail | null>(null); const [error, setError] = useState(""); const [editing, setEditing] = useState(false); const [dirty, setDirty] = useState(false); const [record, setRecord] = useState<RecordRow | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [adjustment, setAdjustment] = useState<Adjustment>({});
  const reasonBaseline=useRef("");
  const beginEdit = useCallback((value: Detail) => {
    if(writing.current||editorWorking.current)return;
    const firstFormula = value.product.lifecycle === "draft" && value.product.revision === 0;
    const next={adjustment_reason:value.draft?.formula.adjustment_reason || (firstFormula ? "新增配方" : ""), adjustment_note:value.draft?.formula.adjustment_note || ""};
    reasonBaseline.current=JSON.stringify(next);setAdjustment(next);
    if (firstFormula) { setReasonOpen(false); setEditing(true); } else setReasonOpen(true);
  }, []);
  const [deleteOpen, setDeleteOpen] = useState(false), [deleting, setDeleting] = useState(false);
  const deleteFormula = async () => { if (!detail || writing.current || editorWorking.current) return; const epoch=reads.current.epoch;writing.current=true; setDeleting(true); try { await request(productPath(current), "DELETE", {revision:detail.draft_revision}); if(reads.current.alive&&reads.current.epoch===epoch){onChanged(); onClose();} } catch (reason) { if(reads.current.alive&&reads.current.epoch===epoch){setError(errorText(reason)); setDeleteOpen(false);} } finally {writing.current=false;if(reads.current.alive&&reads.current.epoch===epoch)setDeleting(false);} };
  const [deactivateOpen,setDeactivateOpen] = useState(false), [deactivating,setDeactivating] = useState(false);
  const canEdit=accessLevel>=3;
  const reads=useRef({alive:false,epoch:0,controller:null as AbortController|null});
  const writing=useRef(false);
  const load=useCallback(async (_signal?:AbortSignal,openDraft=false)=>{
   const state=reads.current;if(!state.alive||_signal?.aborted)return;state.controller?.abort();const controller=new AbortController();state.controller=controller;setError("");
   const signal=_signal?AbortSignal.any([controller.signal,_signal]):controller.signal;
   try{const result=await fetchJson<Detail>(productPath(current),{signal});if(!signal.aborted&&state.alive){setDetail(result);if(openDraft&&result.product.lifecycle==="draft"&&canEdit)beginEdit(result);}}
   catch(error){if(!signal.aborted&&state.alive)setError(errorText(error));}
  },[current,canEdit,beginEdit]);
  useEffect(()=>{const state=reads.current;++state.epoch;state.alive=true;setDetail(null);setEditing(false);setDirty(false);setRecord(null);setReasonOpen(false);setDeleteOpen(false);setDeactivateOpen(false);void load(undefined,true);return()=>{++state.epoch;state.alive=false;state.controller?.abort();};},[load]);
  const previousAccess=useRef(accessLevel);
  useEffect(()=>{const previous=previousAccess.current;previousAccess.current=accessLevel;if(previous!==accessLevel&&(previous>=3)===canEdit)void load();},[accessLevel,canEdit,load]);
  useEffect(() => { const refresh=()=>void load(); window.addEventListener("activation-grants-changed",refresh);window.addEventListener("focus",refresh);return()=>{window.removeEventListener("activation-grants-changed",refresh);window.removeEventListener("focus",refresh);}; },[load]);
  const calculationStatus = detail?.product.status;
  useEffect(() => {
    if (calculationStatus !== "updating" && calculationStatus !== "failed") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => { await load(controller.signal); if (!controller.signal.aborted) timer = setTimeout(refresh, 2000); };
    timer = setTimeout(refresh, 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [calculationStatus, load]);
  const [discardTarget, setDiscardTarget] = useState<"back" | "close" | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const editorWorking=useRef(false);
  const reportBusy=useCallback((value:boolean)=>{editorWorking.current=value;setEditorBusy(value);},[]);
  const reasonDirty=reasonOpen&&JSON.stringify(adjustment)!==reasonBaseline.current;
  const unsaved = useUnsavedChanges(dirty||reasonDirty, editorBusy || deleting || deactivating, "本次未保存的配方修改将被放弃，已保存草稿和正式配方保持不变。", "research-before-leave");
  const formula = detail?.recipes.find(item => item.id === current) ?? (detail ? { ...detail.product, lines: Array.isArray(detail.product.lines) ? detail.product.lines : [] } : null);
  const deactivate = async () => { if (!detail || writing.current || editorWorking.current) return; const epoch=reads.current.epoch;writing.current=true; setDeactivating(true); try { await request(`${productPath(current)}/deactivate`,"POST",{revision:detail.product.revision}); if(reads.current.alive&&reads.current.epoch===epoch){setDeactivateOpen(false); onChanged(); await load();} } catch (reason) {if(reads.current.alive&&reads.current.epoch===epoch)setError(errorText(reason)); } finally {writing.current=false;if(reads.current.alive&&reads.current.epoch===epoch)setDeactivating(false);} };
  return <Drawer key={current} busy={editorBusy || deleting || deactivating} wide backLabel={!editing && path.length > 1 ? "返回上层" : undefined} onBack={() => {if(!writing.current&&!editorWorking.current)setPath(path.slice(0,-1));}} titleAction={detail?.product.lifecycle === "draft" && detail.product.revision === 0 && accessLevel >= 3 ? <button type="button" className={`icon-button ${s.dangerButton}`} aria-label={`删除配方 ${detail.product.name}`} title="删除待启用配方" disabled={editorBusy || deleting || deactivating} onClick={() => {if(!editorWorking.current&&!writing.current)setDeleteOpen(true);}}><Trash2 size={15}/></button> : undefined} title={editing ? `编辑配方 · ${detail?.product.name ?? ""}` : detail?.product.name ?? "产品成本"} label={editing ? "试算和草稿不改变正式成本" : "产品配方与成本"} onClose={onClose} beforeClose={unsaved.request}>
    {unsaved.confirmation}
    {reasonOpen && <DiscardChangesDialog title="记录调整原因" description="当前成本自动按采购价格更新。手动调整需记录原因，保存草稿并核对启用后生效。" intent="primary" cancelLabel="取消" confirmLabel="进入编辑" confirmDisabled={!adjustmentReasons.includes(adjustment.adjustment_reason || "") || (adjustment.adjustment_reason === "其他" && !adjustment.adjustment_note?.trim())} onCancel={() => setReasonOpen(false)} onDiscard={() => {setReasonOpen(false);setEditing(true);}}><ReasonFields expanded value={adjustment} onChange={setAdjustment}/></DiscardChangesDialog>}
    {deleteOpen && detail && <DiscardChangesDialog title={`删除配方 ${detail.product.name}？`} description="将删除这条未启用配方及其草稿，无法恢复。" cancelLabel="保留配方" confirmLabel="删除配方" disabled={deleting} onCancel={() => setDeleteOpen(false)} onDiscard={() => void deleteFormula()}/>}
    {discardTarget && <DiscardChangesDialog description="本次未保存的配方修改将被放弃，已保存草稿和正式配方保持不变。" onCancel={() => setDiscardTarget(null)} onDiscard={() => { const target = discardTarget; setDiscardTarget(null); setDirty(false); if (target === "close") onClose(); else { setEditing(false); void load(); } }}/>}
    {error && <p role="alert" className={s.notice}>{error}<button className="secondary-button" onClick={() => void load()}>重试</button></p>}
    {!detail || !formula ? error ? null : <WorkbenchLoading local title="正在读取研发配方详情"/> : editing ? <ResearchFormulaEditor key={current} onBusy={reportBusy} adjustment={adjustment} detail={detail} formula={formula} accessLevel={accessLevel} onDirty={setDirty} onBack={(force) => { if (force || !dirty) { setDirty(false); setEditing(false); void load(); } else setDiscardTarget("back"); }} onChanged={() => { onChanged(); void load(); }}/>: <>
      <div className={s.sectionHeading}><span>{detail.product.owner} · {formulaVersionLabel(detail.product)}</span><div className={p.actions}>{accessLevel >= 3 && current.startsWith("recipe:") && <button className="secondary-button" disabled={deleting||deactivating} onClick={() => beginEdit(detail)}><Pencil size={14}/>{detail.product.lifecycle === "inactive" ? "恢复并编辑" : detail.draft ? "继续编辑草稿" : "编辑配方"}</button>}{accessLevel >= 4 && current.startsWith("recipe:") && detail.product.lifecycle === "active" && <button className={`secondary-button ${s.dangerButton}`} disabled={deactivating} aria-expanded={deactivateOpen} onClick={() => setDeactivateOpen(!deactivateOpen)}>停用配方</button>}</div></div>
      {accessLevel >= 4 && current.startsWith("recipe:") && detail.product.lifecycle === "active" && deactivateOpen && <div className={s.confirmation}><h3>核对停用影响</h3><p>停用后将从在用产品及投料选择中移除，历史记录继续保留。恢复须重新试算后启用。</p>{detail.referenced_by?.length ? <p role="alert">仍被在用产品引用，不能停用：{detail.referenced_by.map(row => row.name).join("、")}。</p> : <p>当前没有在用产品引用此配方。</p>}<div className={s.actions}><button className="secondary-button" onClick={() => setDeactivateOpen(false)} disabled={deactivating}>取消</button><button className={`secondary-button ${s.dangerButton}`} disabled={deactivating || Boolean(detail.referenced_by?.length)} onClick={() => void deactivate()}>确认停用</button></div></div>}
      {(detail.product.status === "updating" || detail.product.status === "failed") && <div className={s.notice}>成本{detail.product.status === "updating" ? "更新中" : "更新失败，等待重试"}。以下为上次完成的有效成本记录。</div>}
      {detail.product.lifecycle === "inactive" && <p className={s.notice}>此配方已停用，不参与当前产品核算。恢复前须重新试算、保存并启用。</p>}
      <FormulaDetails busy={editorBusy || deleting || deactivating} formula={detail.history[0]?.formula ?? formula} latest={detail.latest} inventory={detail.inventory} comparison={costComparisonRecord(detail.history, 0, policy)} policy={policy} onPolicyChange={setPolicy} onRef={ref => {if(!writing.current&&!editorWorking.current)setPath([...path, ref]);}}/>
      <section className={s.historySection}><div className={s.sectionHeading}><h3>成本历史</h3><span>{detail.history.length} 条</span></div>{detail.history.map((item,index) => { const expanded = record?.event_id === item.event_id && record?.recorded_at === item.recorded_at; return <div key={`${item.event_id}-${index}`} className={s.inlineRecord}><button className={s.historyRow} aria-expanded={expanded} onClick={() => setRecord(expanded ? null : item)}><span title={date(item.recorded_at)}>{recordDate(item)}<small>{item.record_type === "backfill" ? "历史回算 · " : ""}{item.reason ?? "成本核算"}{item.purchase_version != null && item.record_type === "formal" && ` · 采购 v${item.purchase_version}`}</small></span><Money value={item.latest_cost}/><Movement change={item.change} comparisonBasis={item.comparison_basis}/><ChevronRight size={15} style={{transform:expanded?"rotate(90deg)":undefined}}/></button>{expanded && <div className={s.expandedRecord}><HistoricalFormula busy={editorBusy || deleting || deactivating} key={`${record!.event_id}-${record!.recorded_at}`} record={record!} initialPolicy={policy}/><button className={s.back} onClick={() => setRecord(null)}>收起本期明细</button></div>}</div>; })}{!detail.history.length && <p>尚未建立成本记录。</p>}</section>


    </>}
  </Drawer>;
}
