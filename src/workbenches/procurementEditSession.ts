import { useEffect, useMemo, useRef, useState } from "react";
import { bulkAdjustProcurementPrices, cancelProcurementUpdate, fetchProcurementOverview, reviewProcurementIssue } from "../api";
import type { ProcurementOverview } from "../types";
import { useUnsavedChanges } from "../components/Interaction";
import { collectPriceEdits } from "./procurementLedger";
import { resolveReason, type ReasonSelection } from "./procurementReasons";
import { usePricePreview } from "./procurementPriceEditing";

type Edit = { update_id: string | null; updated_at: string | null; originals: Record<string,string>; order: string[]; sort: string; sortDirection: string };
const originals = (data: ProcurementOverview) => Object.fromEntries((data.current_update?.input_items ?? []).map(item => [item.material_id,item.draft_price ?? ""]));

export function useProcurementEditSession(data: ProcurementOverview, readonly: boolean, onSaved: (data: ProcurementOverview)=>void, onRefresh: ()=>Promise<void>) {
  const current=readonly?null:data.current_update;
  const canEdit=!readonly&&Boolean(data.capabilities?.can_edit)&&(!current||["draft","returned"].includes(current.status));
  const canConfirm=!readonly&&Boolean(data.capabilities?.can_activate)&&Boolean(current&&["draft","returned","submitted","revalidation_required"].includes(current.status));
  const [edit,setEdit]=useState<Edit|null>(null);
  const [values,setValues]=useState<Record<string,string>>({});
  const [editDate,setEditDate]=useState("");
  const [editReason,setEditReason]=useState<ReasonSelection>({selected:"",custom:""});
  const [editError,setEditError]=useState("");
  const [saveOpen,setSaveOpen]=useState(false);
  const [expanded,setExpanded]=useState<string|null>(null);
  const [reviewReasons,setReviewReasons]=useState<Record<string,ReasonSelection>>({});
  const [reviewError,setReviewError]=useState("");
  const [cancelArmed,setCancelArmed]=useState(false);
  const [panelError,setPanelError]=useState("");
  const [busy,setBusy]=useState(false);
  const pending=useRef(false), mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const currentId=current?.id;
  useEffect(()=>{setExpanded(null);setReviewReasons({});setReviewError("");},[currentId]);
  useEffect(()=>{setCancelArmed(false);},[current,edit,data.capabilities?.can_cancel_round]);
  const edits=useMemo(()=>collectPriceEdits(values,edit?.originals??{}),[values,edit]);
  const dirty=edits.length>0;
  const reviewDirty=Object.values(reviewReasons).some(value=>Boolean(value.selected||value.custom));
  const validEdits=edits.every(item=>/^\d+(\.\d+)?$/.test(item.price));
  const pricePreview=usePricePreview(saveOpen,editDate,edits);
  const unsaved=useUnsavedChanges(dirty||reviewDirty,busy,"价格修改或波动确认依据尚未保存，确认后将放弃本次修改。","procurement-before-leave");
  const begin=()=>{if(pending.current||!mounted.current)return false;pending.current=true;setBusy(true);return true;};
  const finish=()=>{pending.current=false;if(mounted.current)setBusy(false);};
  const startEditing=(order:string[],sort:string,sortDirection:string)=>{
    if(!canEdit||edit||pending.current)return;
    setEdit({update_id:current?.id??null,updated_at:current?.updated_at??null,originals:originals(data),order,sort,sortDirection});
    setEditDate(current?.price_date??new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));
    setValues({});setEditError("");setEditReason({selected:"",custom:""});setExpanded(null);
  };
  const stopEditing=async()=>{
    if(pending.current||!await unsaved.request()||!mounted.current)return false;
    setEdit(null);setValues({});setEditError("");setSaveOpen(false);setReviewReasons({});return true;
  };
  const saveEdits=async()=>{
    if(!canEdit||!edit||!dirty||!validEdits||!editDate||!resolveReason(editReason)||!pricePreview.data||!begin())return;
    setEditError("");
    try {
      const result=await bulkAdjustProcurementPrices({update_id:edit.update_id,updated_at:edit.updated_at,effective_date:editDate,reason:resolveReason(editReason),items:edits,...(data.capabilities?.can_activate?{price_confirmation:{baseline_id:pricePreview.data.baseline_id,references:Object.fromEntries(pricePreview.data.rows.map(row=>[row.material_id,row.reference_price]))}}:{})});
      if(!mounted.current)return;
      onSaved(result);setSaveOpen(false);setEdit(null);setValues({});
    }catch(error){if(mounted.current){setEditError(error instanceof Error?error.message:"保存失败，输入已保留。");pricePreview.refresh();}}
    finally {finish();}
  };
  const recover=async()=>{
    if(!edit||!begin())return;
    try {
      const fresh=await fetchProcurementOverview();if(!mounted.current)return;
      onSaved(fresh);
      setEdit(old=>old?{...old,update_id:fresh.current_update?.id??null,updated_at:fresh.current_update?.updated_at??null,originals:originals(fresh)}:null);
      if(fresh.current_update)setEditDate(fresh.current_update.price_date);
      pricePreview.refresh();setEditError("已读取最新版本，输入已保留。请核对后重新保存。");
    }catch(error){if(mounted.current)setEditError(error instanceof Error?error.message:"读取失败，输入已保留。");}
    finally {finish();}
  };
  const cancelRound=async()=>{
    if(!current||!cancelArmed||!data.capabilities?.can_cancel_round||!begin())return;
    setPanelError("");
    try {const value=await cancelProcurementUpdate(current.id,"用户确认取消本轮");if(mounted.current)onSaved(value);}
    catch(error){if(mounted.current)setPanelError(error instanceof Error?error.message:"取消失败，请重试。");}
    finally {if(mounted.current)setCancelArmed(false);finish();}
  };
  const review=async(issueId:string)=>{
    const reason=resolveReason(reviewReasons[issueId]);
    if(!current||!canConfirm||!reason||!begin())return false;
    setReviewError("");
    try {
      await reviewProcurementIssue(current.id,issueId,reason,current.updated_at);
      if(!mounted.current)return false;
      setReviewReasons(rows=>{const next={...rows};delete next[issueId];return next;});
      await onRefresh();if(!mounted.current)return false;setExpanded(null);return true;
    }catch(error){if(mounted.current)setReviewError(error instanceof Error?error.message:"确认失败，请重试。");return false;}
    finally {finish();}
  };
  return {edit,values,editDate,editReason,editError,saveOpen,expanded,reviewReasons,reviewError,cancelArmed,panelError,busy,edits,dirty,validEdits,pricePreview,unsaved,canEdit,canConfirm,
    actions:{startEditing,stopEditing,saveEdits,recover,cancelRound,review,
      changePrice:(id:string,value:string)=>{if(!pending.current)setValues(rows=>({...rows,[id]:value}));},
      retractPrice:(id:string)=>{if(!pending.current)setValues(rows=>{if(rows[id]!=="")return rows;const next={...rows};delete next[id];return next;});},
      changeDate:(value:string)=>{if(!pending.current)setEditDate(value);},
      chooseReason:(value:ReasonSelection)=>{if(!pending.current)setEditReason(value);},
      openSave:()=>{if(edit&&dirty&&validEdits&&!pending.current)setSaveOpen(true);},
      closeSave:()=>{if(!pending.current)setSaveOpen(false);},
      armCancel:(value:boolean)=>{if(!pending.current){setCancelArmed(value);if(value)setPanelError("");}},
      chooseReviewReason:(id:string,value:ReasonSelection)=>{if(!pending.current)setReviewReasons(rows=>({...rows,[id]:value}));},
      toggleReview:(id:string|null)=>{if(!pending.current){setExpanded(old=>old===id?null:id);setReviewError("");}},
      orderRows:(order:string[],sort:string,sortDirection:string)=>setEdit(old=>old?{...old,order,sort,sortDirection}:old),
    }};
}
