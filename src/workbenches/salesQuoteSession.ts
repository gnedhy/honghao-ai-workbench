import { useEffect, useRef, useState } from "react";
import { fetchJson } from "../api";
import { createClientId } from "../clientId";
import { useUnsavedChanges } from "../components/Interaction";
import { adoptionExceptions, base, canEditQuoteItem, defaultParameters, draftItem, patchItems, pendingProductIds, quoteDraftItems, quoteFingerprint, quoteValue, type Batch, type DraftItem, type Mode, type Parameters, type Product } from "./salesModel";

const send = <T,>(path:string,body:unknown,method="POST") => fetchJson<T>(base+path,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
export type SalesQuoteSessionOptions = {products:Product[];catalog:Product[];existing?:Batch;accessLevel:number};

// One mounted editor owns inputs and recovery receipts. Catalog refreshes do not restart it.
export function useSalesQuoteSession({products,catalog,existing,accessLevel,onChanged}:SalesQuoteSessionOptions & {onChanged:()=>Promise<void>}) {
 const initialMode=existing?.mode??"domestic_direct";
 const [mode,setMode]=useState<Mode>(initialMode);
 const [customer,setCustomer]=useState(()=>({name:existing?.customer_name??"",code:existing?.customer_code??"",salesperson:existing?.salesperson??""}));
 const [items,setItems]=useState(()=>products.map(product=>draftItem(product,initialMode,existing?.items.find(row=>row.product_id===product.id))));
 const [savedBatch,setSavedBatch]=useState<Batch|undefined>(existing);
 const [savedFingerprint,setSavedFingerprint]=useState<string|null>(()=>
  existing&&items.some(row=>canEditQuoteItem(row)&&(!row.result||!row.trial_id||row.manual_price_confirmed!==true))?null:quoteFingerprint(customer,mode,items));
 const writing=useRef(false);
 // ponytail: recovery lasts for this mounted editor; durable cross-session recovery needs a separate contract.
 const pendingWrite=useRef<{path:string;body:unknown;method:string;fingerprint:string;stage:"create"|"draft"|"calculate"}|null>(null);
 const savedDraft=useRef<{id:string;revision:number;fingerprint:string}|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [keepCost,setKeepCost]=useState(false),[confirmLow,setConfirmLow]=useState(false);
 const [liveProducts,setLiveProducts]=useState(catalog);
 const fingerprint=quoteFingerprint(customer,mode,items), dirty=fingerprint!==savedFingerprint;
 const pendingIds=pendingProductIds(items);
 const exceptions=adoptionExceptions(savedBatch?.items??[],liveProducts,pendingIds);
 useEffect(()=>{
  if(!savedBatch||dirty||accessLevel<4)return;
  let active=true;
  void fetchJson<{products:Product[]}>(base+"/products").then(result=>{if(active)setLiveProducts(result.products);}).catch(()=>{});
  return ()=>{active=false;};
 },[savedBatch,dirty,accessLevel]);
 const guard=useUnsavedChanges(dirty,busy,"放弃尚未保存的报价修改？","sales-before-leave");
 const updateItem=(id:string,patch:Partial<DraftItem>)=>{if(!writing.current)setItems(rows=>patchItems(rows,[id],patch));};
 const updateParameter=(id:string,key:keyof Parameters,value:string)=>{if(!writing.current)setItems(rows=>patchItems(rows,[id],{},{[key]:value}));};
 const customerLocked=!!savedBatch?.items.some(row=>row.adopted);
 const changeCustomer=(patch:Partial<typeof customer>)=>{if(!writing.current&&!customerLocked)setCustomer(value=>({...value,...patch}));};
 const changeMode=(next:Mode)=>{if(writing.current||customerLocked)return;setMode(next);setItems(rows=>rows.map(row=>({...row,parameters:{...row.parameters,...defaultParameters(row.product,next,row.cost_basis)},result:null,trial_id:null,manual:false,final_price:null})));};
 const applyParameters=(values:Parameters)=>{
  const patch=Object.fromEntries(Object.entries(values).filter(([,value])=>value!==""&&value!=null)) as Parameters;
  if(writing.current||!Object.keys(patch).length)return false;
  setItems(rows=>patchItems(rows,rows.map(row=>row.product_id),{},patch));return true;
 };
 const fields=(mode.startsWith("export")?["export_addition_1","export_addition_2","export_multiplier"]:["allocation","freight","barrel","tax","profit","reverse"]) as (keyof Parameters)[];
 const invalid=items.some(row=>{const value=quoteValue(row.product,mode,row.cost_basis,row.parameters);return value==null||!Number.isFinite(value)||(row.product.special_allocation&&!mode.startsWith("export")&&(Number(row.parameters.allocation)<.3||Number(row.parameters.allocation)>1));});
 const customerInvalid=!customer.name.trim()||!customer.salesperson.trim();
 const write=async(request:NonNullable<typeof pendingWrite.current>)=>{
  pendingWrite.current=request;
  try{
   const result=(await send<{batch:Batch}>(request.path,request.body,request.method)).batch;
   pendingWrite.current=null;setSavedBatch(result);
   if(request.stage==="draft")savedDraft.current={id:result.id,revision:result.revision,fingerprint:request.fingerprint};
   return result;
  }catch(value){if(value instanceof Error&&"status" in value&&value.status===422)pendingWrite.current=null;throw value;}
 };
 const finishSave=async(calculated:Batch)=>{
  const nextItems=items.map(row=>draftItem(row.product,mode,calculated.items.find(value=>value.product_id===row.product_id)));
  setItems(nextItems);setSavedBatch(calculated);setSavedFingerprint(quoteFingerprint(customer,mode,nextItems));setKeepCost(false);setConfirmLow(false);setNotice("报价已保存，可继续确认采用");await onChanged();
 };
 const canSave=accessLevel>=3&&!customerInvalid&&!invalid&&!!(items.length||savedBatch?.items.some(row=>row.adopted));
 const saveQuote=async()=>{if(writing.current||!canSave)return;writing.current=true;setBusy(true);setSavedFingerprint(null);setNotice("");setError("");try{
   let current=savedBatch;
   if(pendingWrite.current){
    const pending=pendingWrite.current;current=await write(pending);
    if(pending.stage==="calculate"&&pending.fingerprint===fingerprint){await finishSave(current);return;}
   }
   if(!current) current=await write({path:"/batches",body:{request_id:createClientId(),name:`${customer.name.trim()} 报价 ${new Date().toLocaleString("zh-CN",{hour12:false})}`,mode},method:"POST",fingerprint,stage:"create"});
   const prior=savedDraft.current;
   const saved=prior?.id===current.id&&prior.revision===current.revision&&prior.fingerprint===fingerprint?current:await write({path:`/batches/${current.id}/draft`,body:{request_id:createClientId(),revision:current.revision,name:current.name,mode,customer_name:customer.name,customer_code:customer.code.trim(),uncoded:!customer.code.trim(),salesperson:customer.salesperson,items:quoteDraftItems(current.items,items)},method:"PUT",fingerprint,stage:"draft"});
   const ids=pendingProductIds(items);
   const calculated=ids.length?await write({path:`/batches/${saved.id}/calculate`,body:{request_id:createClientId(),revision:saved.revision,product_ids:ids,confirm_manual_prices:true},method:"POST",fingerprint,stage:"calculate"}):saved;
   await finishSave(calculated);
  }catch(value){setError(value instanceof Error?value.message:"保存失败，请重试");}finally{writing.current=false;setBusy(false);}};
 const adoptPendingItems=async()=>{if(writing.current||accessLevel<4||!pendingIds.length||!savedBatch||dirty||pendingWrite.current)return;writing.current=true;setBusy(true);setError("");try{
   const latest=(await fetchJson<{products:Product[]}>(base+"/products")).products;
   setLiveProducts(latest);
   const checks=adoptionExceptions(savedBatch.items,latest,pendingIds);
   if((checks.stale.length&&!keepCost)||(checks.belowBreakEven.length&&!confirmLow)){setNotice("请先核对采用前提示");return;}
   const result=(await send<{batch:Batch}>(`/batches/${savedBatch.id}/adopt`,{revision:savedBatch.revision,product_ids:pendingIds,keep_stale_cost:keepCost,confirm_below_break_even:confirmLow})).batch;
   const nextItems=items.map(row=>draftItem(row.product,mode,result.items.find(value=>value.product_id===row.product_id)));
   setItems(nextItems);setSavedBatch(result);setSavedFingerprint(quoteFingerprint(customer,mode,nextItems));setKeepCost(false);setConfirmLow(false);setNotice("报价已采用并成为当前有效报价");await onChanged();
  }catch(value){setError(value instanceof Error?value.message:"采用失败，请重试");}finally{writing.current=false;setBusy(false);}};
 const changeCostBasis=(id:string,basis:"latest"|"inventory")=>{const row=items.find(item=>item.product_id===id);if(!row)return;const defaults=defaultParameters(row.product,mode,basis);updateItem(row.product_id,{cost_basis:basis,parameters:{...row.parameters,allocation:row.product.special_allocation?row.parameters.allocation:defaults.allocation},result:null,trial_id:null});};
 const toggleItemDetails=(id:string)=>setItems(rows=>rows.map(row=>({...row,adjusting:row.product_id===id?!row.adjusting:false})));
 const addProduct=(product:Product,basis:"latest"|"inventory")=>{
  if(writing.current||savedBatch?.items.some(row=>row.adopted&&row.product_id===product.id))return;
  setItems(rows=>rows.some(row=>row.product_id===product.id)?rows:[...rows,draftItem(product,mode,undefined,basis)]);
 };
 const removeProduct=(id:string)=>{if(!writing.current)setItems(rows=>rows.filter(row=>row.product_id!==id||row.adopted));};
 const changeFinalPrice=(id:string,value:string)=>updateItem(id,{manual:!!value,final_price:value||null});
 const changeReferencePrice=(id:string,value:string)=>{const row=items.find(row=>row.product_id===id);if(row)updateItem(id,{reference_prices:{...row.reference_prices,customer:value}});};
 const changePricingReason=(id:string,reason:string,checked:boolean)=>{const row=items.find(row=>row.product_id===id);if(row)updateItem(id,{pricing_reasons:checked?[...row.pricing_reasons,reason]:row.pricing_reasons.filter(value=>value!==reason)});};
 const changePricingNote=(id:string,value:string)=>updateItem(id,{pricing_note:value});
 const confirmStaleCost=(checked:boolean)=>{if(!writing.current)setKeepCost(checked);};
 const confirmLowPrice=(checked:boolean)=>{if(!writing.current)setConfirmLow(checked);};
 return {customer,mode,items,savedBatch,dirty,busy,error,notice,customerLocked,fields,canSave,pendingIds,exceptions,keepCost,confirmLow,
  changeCustomer,changeMode,updateParameter,changeCostBasis,changeFinalPrice,changeReferencePrice,changePricingReason,changePricingNote,
  addProduct,removeProduct,toggleItemDetails,applyParameters,confirmStaleCost,confirmLowPrice,saveQuote,adoptPendingItems,
  requestClose:guard.request,confirmation:guard.confirmation};
}
