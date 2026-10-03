import {useEffect,useMemo,useRef,useState} from "react";
import {fetchJson} from "../api";
import {type Adjustment,type Detail,type Formula,type InputLine,type Simulation,productPath,request,errorText} from "./researchModel";

function normalizedFormula(value:Formula):Formula {
 const source=structuredClone(value),total=source.lines.reduce((sum,line)=>sum+Number(line.quantity),0);
 const base=Number(source.ratio_base)>0?Number(source.ratio_base):total>0?Number(total.toFixed(10)):100;
 return {...source,adjustment_reason:source.adjustment_reason||"",adjustment_note:source.adjustment_note||"",ratio_linked:source.ratio_linked??true,ratio_base:String(base),lines:source.lines.map(line=>({...line,ratio:line.ratio??(Number(line.quantity)/base*100).toFixed(2)}))};
}
function formulaKey(value:Formula) {
 return JSON.stringify({owner:value.owner??"",yield:value.yield,ratio_linked:value.ratio_linked??true,ratio_base:value.ratio_base,
  adjustment_reason:value.adjustment_reason??"",adjustment_note:value.adjustment_note??"",manual_costs:{latest:value.manual_costs?.latest??null,inventory:value.manual_costs?.inventory??null},
  lines:value.lines.map(({kind,ref,code,quantity,ratio})=>({kind,ref,code,quantity,ratio}))});
}

export function useResearchEditSession({detail,formula:currentFormula,adjustment,onBusy,onDirty,onChanged,onBack}: {
 detail:Detail;formula:Formula;adjustment:Adjustment;onBusy:(busy:boolean)=>void;onDirty:(dirty:boolean)=>void;onChanged:()=>void;onBack:(force?:boolean)=>void;
}) {
 const initial=useMemo(()=>normalizedFormula(detail.draft?.formula??currentFormula),[detail.draft,currentFormula]);
 const [formula,setFormula]=useState<Formula>(()=>({...structuredClone(initial),...adjustment}));
 const [revision,setRevision]=useState(detail.draft_revision??0);
 const [simulation,setSimulation]=useState<Simulation|null>(detail.draft?.simulation??null);
 const [pendingAction,setPendingAction]=useState("");const busy=Boolean(pendingAction);
 const [message,setMessage]=useState("");
 const [saved,setSaved]=useState(Boolean(detail.draft)&&(detail.draft?.formula.adjustment_reason||"")===(adjustment.adjustment_reason||"")&&(detail.draft?.formula.adjustment_note||"")===(adjustment.adjustment_note||""));
 const [confirming,changeConfirming]=useState(false),[conflict,setConflict]=useState<Detail|null>(null),[cancelSaveOpen,changeCancelSaveOpen]=useState(false);
 const baseline=useRef(formulaKey(initial));const dirty=formulaKey(formula)!==baseline.current;
 const liveTrial=useRef(Boolean(detail.draft));const sequence=useRef(0);
 const trialController=useRef<AbortController|null>(null),lifetime=useRef<AbortController|null>(null),mounted=useRef(false),working=useRef(false);
 const trialBasis=useRef<{formula:string;revision:number}|null>(null);
 const [trialChange,setTrialChange]=useState(detail.draft?1:0),[trialUpdating,setTrialUpdating]=useState(Boolean(detail.draft));
 useEffect(()=>{const controller=new AbortController();lifetime.current=controller;mounted.current=true;return()=>{mounted.current=false;controller.abort();trialController.current?.abort();};},[]);
 useEffect(()=>{onBusy(busy);return()=>onBusy(false);},[busy,onBusy]);
 useEffect(()=>{onDirty(dirty);},[dirty,onDirty]);
 const invalidate=()=>{++sequence.current;trialController.current?.abort();trialBasis.current=null;};
 const update=(next:Formula)=>{
  if(working.current||(saved&&!dirty))return;
  invalidate();setFormula(next);setSaved(false);changeConfirming(false);setMessage("");setConflict(null);
  if(liveTrial.current){setTrialUpdating(true);setTrialChange(value=>value+1);}else setSimulation(null);
 };
 useEffect(()=>{
  if(!trialChange||!liveTrial.current||!trialUpdating)return;
  const controller=new AbortController();trialController.current=controller;
  const current=++sequence.current;const input=JSON.stringify(formula);
  const timer=window.setTimeout(async()=>{
   try{
    const result=await fetchJson<Simulation>(`${productPath(detail.product.id)}/simulate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({formula,draft_revision:revision}),signal:controller.signal});
    if(!controller.signal.aborted&&current===sequence.current){setSimulation(result);trialBasis.current={formula:input,revision};}
   }catch(error){if(!controller.signal.aborted&&current===sequence.current){liveTrial.current=false;setSimulation(null);setMessage(errorText(error));}}
   finally{if(!controller.signal.aborted&&current===sequence.current)setTrialUpdating(false);}
  },trialChange===1&&saved?0:350);
  return()=>{clearTimeout(timer);controller.abort();};
 },[trialChange,formula,detail.product.id,revision,saved,trialUpdating]);
 const begin=(action:string)=>{if(working.current||!mounted.current)return false;working.current=true;onBusy(true);setPendingAction(action);return true;};
 const finish=()=>{working.current=false;if(mounted.current){onBusy(false);setPendingAction("");}};
 const validTrial=()=>Boolean(simulation&&!trialUpdating&&trialBasis.current?.formula===JSON.stringify(formula)&&trialBasis.current.revision===revision);
 const simulate=async()=>{
  if(!begin("simulate"))return;invalidate();setMessage("");
  const current=sequence.current;
  try{
   const result=await fetchJson<Simulation>(`${productPath(detail.product.id)}/simulate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({formula,draft_revision:revision}),signal:lifetime.current?.signal});
   if(!mounted.current||current!==sequence.current)return;
   setSimulation(result);trialBasis.current={formula:JSON.stringify(formula),revision};liveTrial.current=true;setTrialUpdating(false);changeConfirming(false);
  }catch(error){if(mounted.current&&current===sequence.current){setSimulation(null);setMessage(errorText(error));}}
  finally{finish();}
 };
 const save=async()=>{
  if(!validTrial()||!simulation||!begin("save"))return;
  try{
   const result=await request<{revision:number;simulation_token:string}>(`${productPath(detail.product.id)}/draft`,"PUT",{formula,draft_revision:revision,simulation_token:simulation.simulation_token});
   if(!mounted.current)return;
   setRevision(result.revision);setSimulation({...simulation,simulation_token:result.simulation_token});trialBasis.current={formula:JSON.stringify(formula),revision:result.revision};baseline.current=formulaKey(formula);onDirty(false);setSaved(true);setMessage("");onChanged();
  }catch(error){if(mounted.current)setMessage(errorText(error));}
  finally{finish();}
 };
 const cancelTrial=()=>{if(working.current)return;liveTrial.current=false;invalidate();setTrialUpdating(false);setSimulation(null);changeConfirming(false);setMessage("");};
 const discard=async()=>{
  if(!saved||!begin("discard"))return;
  try{
   await request(`${productPath(detail.product.id)}/draft`,"DELETE",{revision});if(!mounted.current)return;
   liveTrial.current=false;invalidate();setTrialUpdating(false);setSimulation(null);changeConfirming(false);setRevision(revision+1);baseline.current="";setSaved(false);changeCancelSaveOpen(false);onDirty(true);setMessage("已取消保存，当前填写仍保留。可重新试算并保存草稿。");onChanged();
  }catch(error){if(mounted.current)setMessage(errorText(error));}
  finally{finish();}
 };
 const activate=async()=>{
  if(!saved||dirty||!validTrial()||!simulation||!detail.capabilities?.can_activate||simulation.blocking.length||simulation.latest.cost==null||simulation.inventory.cost==null||!begin("activate"))return;
  try{await request(`${productPath(detail.product.id)}/activate`,"POST",{revision,simulation_token:simulation.simulation_token});if(!mounted.current)return;onDirty(false);onChanged();onBack(true);}
  catch(error){if(mounted.current){invalidate();liveTrial.current=false;setTrialUpdating(false);changeConfirming(false);setSimulation(null);setMessage(errorText(error));}}
  finally{finish();}
 };
 const recheck=async()=>{
  if(!begin("recheck"))return;invalidate();liveTrial.current=false;setTrialUpdating(false);setSimulation(null);changeConfirming(false);
  try{const result=await fetchJson<Detail>(productPath(detail.product.id),{signal:lifetime.current?.signal});if(mounted.current)setConflict(result);}
  catch(error){if(mounted.current)setMessage(errorText(error));}finally{finish();}
 };
 const acceptConflict=()=>{
  if(!conflict||working.current)return;invalidate();liveTrial.current=false;setTrialUpdating(false);
  const serverFormula=conflict.draft?.formula??conflict.recipes.find(row=>row.id===detail.product.id)??currentFormula;
  baseline.current=formulaKey(normalizedFormula(serverFormula));setRevision(conflict.draft_revision);setSimulation(null);setSaved(Boolean(conflict.draft)&&formulaKey(formula)===baseline.current);changeConfirming(false);setConflict(null);setMessage("已确认最新版本。请重新试算，核对并保存你的修改。");
 };
 const changeLine=(index:number,value:Partial<InputLine>)=>update({...formula,lines:formula.lines.map((line,i)=>i===index?{...line,...value}:line)});
 const changeAmount=(index:number,field:"ratio"|"quantity",value:string)=>{
  const valid=value.trim()!==""&&Number.isFinite(Number(value))&&Number(value)>=0;const ratioBase=Number(formula.ratio_base);
  const other=field==="ratio"?"quantity":"ratio",converted=field==="ratio"?Number(value)*ratioBase/100:Number(value)/ratioBase*100;
  changeLine(index,{[field]:value,...(formula.ratio_linked?{[other]:valid?String(Number(converted.toFixed(10))):""}:{})});
 };
 const move=(from:number,to:number)=>{if(from===to||to<0||to>=formula.lines.length)return;const lines=[...formula.lines];lines.splice(to,0,lines.splice(from,1)[0]);update({...formula,lines});};
 return {formula,revision,simulation,pendingAction,busy,message,saved,confirming,conflict,dirty,trialUpdating,liveTrial,update,changeLine,changeAmount,move,simulate,save,cancelTrial,discard,activate,recheck,acceptConflict,cancelSaveOpen,
  setCancelSaveOpen:(value:boolean)=>{if(!working.current)changeCancelSaveOpen(value);},
  setConfirming:(value:boolean)=>{if(!working.current&&(!value||saved&&!dirty&&validTrial()))changeConfirming(value);}};
}
