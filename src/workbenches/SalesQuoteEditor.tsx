import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Drawer } from "../components/Drawer";
import { DecimalInput } from "../components/DecimalInput";
import { FormFooter } from "../components/WorkbenchLayout";
import { WorkbenchOptionMenu } from "../components/WorkbenchMenus";
import type { CurrentUser } from "../types";
import { canEditQuoteItem, decimalText, modes, money, parameterLabels, productSourceText, quoteValue, reasons, type DraftItem, type Item, type Mode, type Parameters } from "./salesModel";
import { useSalesQuoteSession, type SalesQuoteSessionOptions } from "./salesQuoteSession";
import { SalesProductPicker } from "./SalesProductPicker";
import s from "./SalesWorkbench.module.css";

export function SalesQuoteEditor(props:SalesQuoteSessionOptions & {currentUser:CurrentUser;onClose:()=>void;onChanged:()=>Promise<void>}) {
 const {catalog,currentUser,accessLevel,onClose}=props;
 const {customer,mode,items,savedBatch,dirty,busy,error,notice,customerLocked,fields,canSave,pendingIds,exceptions,keepCost,confirmLow,
  changeCustomer,changeMode,updateParameter,changeCostBasis,changeFinalPrice,changeReferencePrice,changePricingReason,changePricingNote,
  addProduct,removeProduct,toggleItemDetails,applyParameters,confirmStaleCost,confirmLowPrice,saveQuote,adoptPendingItems,requestClose,confirmation}=useSalesQuoteSession(props);
 const [bulkOpen,setBulkOpen]=useState(false),[bulk,setBulk]=useState<Parameters>({});
 const productNames=(rows:Item[])=>rows.map(row=>row.product?.code??row.product_id).join("、");
 const quoteCard=(row:DraftItem)=>{
  const current=quoteValue(row.product,mode,row.cost_basis,row.parameters);
  return <article className={s.editorRow} key={row.product_id}>
   <div className={s.editorRowMain}>
    <div className={s.editorIdentity}><div className={s.editorNameRow}><strong>{row.product.code}</strong><button type="button" className={s.removeProduct} disabled={row.adopted} title={row.adopted?"已采用产品请在报价历史中作废":"从本次报价移除"} aria-label={`移除 ${row.product.code}`} onClick={()=>removeProduct(row.product_id)}><Trash2 size={13}/>移除</button></div>{row.product.name!==row.product.code&&<span>{row.product.name}</span>}<small>{row.product.department} · {productSourceText(row.product)}</small></div>
    <div className={s.editorQuote}>
     <div className={s.basisSwitch} role="group" aria-label={`${row.product.code}成本口径`}><button type="button" disabled={!canEditQuoteItem(row)} aria-pressed={row.cost_basis==="latest"} onClick={()=>changeCostBasis(row.product_id,"latest")}>最新优先</button><button type="button" disabled={!canEditQuoteItem(row)} aria-pressed={row.cost_basis==="inventory"} onClick={()=>changeCostBasis(row.product_id,"inventory")}>库存优先</button></div>
     <strong className={s.editorPrice}>{money(row.adopted&&!row.adjustment_reason?row.final_price:row.manual?row.final_price:current)}<small>元/kg</small></strong>
    </div>
   </div>
   <button type="button" className={s.adjustToggle} aria-expanded={row.adjusting} onClick={()=>toggleItemDetails(row.product_id)}>{row.adjusting?"收起调整":"报价调整"}<ChevronRight size={14}/></button>
   {row.adjusting&&<fieldset disabled={!canEditQuoteItem(row)} className={s.adjustmentPanel}>
    <h4>费用与系数</h4>
    <div className={`${s.fieldGrid} ${s.adjustFields}`}>{fields.map(key=><label key={key}>{row.product.special_allocation&&key==="allocation"?"特殊公摊（元）":parameterLabels[key]}<DecimalInput value={decimalText(row.parameters[key])} onChange={event=>updateParameter(row.product_id,key,event.target.value)}/></label>)}</div>
    <div className={s.outcomeFields}><label>最终报价（元/kg）<DecimalInput value={row.manual?row.final_price??"":""} placeholder={money(current)} onChange={event=>changeFinalPrice(row.product_id,event.target.value)}/></label><label>客户参考价（选填）<DecimalInput value={row.reference_prices?.customer??""} onChange={event=>changeReferencePrice(row.product_id,event.target.value)}/></label></div>
    <fieldset className={s.reasonChoices}><legend>定价依据</legend>{reasons.map(reason=><label key={reason}><input type="checkbox" checked={row.pricing_reasons.includes(reason)} onChange={event=>changePricingReason(row.product_id,reason,event.target.checked)}/>{reason}</label>)}</fieldset>
    {row.pricing_reasons.includes("其他")&&<label className={s.fullField}>其它说明<textarea value={row.pricing_note} onChange={event=>changePricingNote(row.product_id,event.target.value)}/></label>}
   </fieldset>}
  </article>;
 };
 return <><Drawer className={s.quoteDrawer} title="报价明细" label={`${items.length} 个产品`} busy={busy} beforeClose={requestClose} onClose={onClose}>
 <div inert={busy} style={{display:"contents"}}>
 <section className={s.customerSection}>
  <div className={s.sectionHeading}><h3>客户信息</h3><span className={s.quoteActor}>报价人 · <strong>{currentUser.display_name}</strong></span></div>
  <div className={s.customerGrid}>
   <div className={s.customerMode}><span>客户类型</span><WorkbenchOptionMenu label="客户类型" value={mode} options={Object.entries(modes).map(([value,label])=>({value,label,disabled:customerLocked}))} onSelect={value=>changeMode(value as Mode)} className={s.quoteModeMenu}/></div>
   <label>客户名称<input disabled={customerLocked} value={customer.name} onChange={event=>changeCustomer({name:event.target.value})}/></label>
   <label>客户编码<input placeholder="K / SWA / WA" disabled={customerLocked} value={customer.code} onChange={event=>changeCustomer({code:event.target.value})}/></label>
   <label>业务员<input disabled={customerLocked} value={customer.salesperson} onChange={event=>changeCustomer({salesperson:event.target.value})}/></label>
  </div>
 </section>
 <section className={s.drawerSection}><div className={s.sectionHeading}><div><h3>报价参考</h3><p>{modes[mode]}</p></div>{items.length>1&&<button className="secondary-button" onClick={()=>setBulkOpen(value=>!value)}>{bulkOpen?"收起批量调整":"批量报价调整"}</button>}</div>{bulkOpen&&<div className={s.bulkPanel}><div className={s.fieldGrid}>{fields.map(key=><label key={key}>{parameterLabels[key]}<DecimalInput value={bulk[key]??""} placeholder="保持各产品原值" onChange={event=>setBulk({...bulk,[key]:event.target.value})}/></label>)}</div><button className="secondary-button" onClick={()=>{if(applyParameters(bulk)){setBulk({});setBulkOpen(false);}}}>应用到全部产品</button></div>}<div className={s.editorCards}>{items.map(quoteCard)}</div>{!items.length&&<p className={s.empty}>尚未加入产品，请从下方选择。</p>}<SalesProductPicker add products={catalog} excludeIds={[...new Set([...items.map(row=>row.product_id),...(savedBatch?.items.filter(row=>row.adopted).map(row=>row.product_id)??[])])]} onSelect={addProduct}/></section>
 {error&&<p className={s.error} role="alert">{error}</p>}{savedBatch&&!dirty&&accessLevel>=4&&(exceptions.stale.length>0||exceptions.belowBreakEven.length>0)&&<section className={s.adoptChecks} aria-label="采用前确认">
  {exceptions.stale.length>0&&<label><input type="checkbox" checked={keepCost} onChange={event=>confirmStaleCost(event.target.checked)}/><span><strong>保留本次成本依据</strong><small>{productNames(exceptions.stale)}的产品成本或状态已更新；确认后沿用保存时的依据并留痕。</small></span></label>}
  {exceptions.belowBreakEven.length>0&&<label><input type="checkbox" checked={confirmLow} onChange={event=>confirmLowPrice(event.target.checked)}/><span><strong>确认低于盈亏平衡参考价</strong><small>{productNames(exceptions.belowBreakEven)}的最终报价低于参考价；请核对定价依据后确认。</small></span></label>}
 </section>}
 </div><FormFooter className={s.drawerFooter} status={busy?"处理中…":dirty?"尚未保存":notice||(savedBatch?"报价已保存":"尚未保存")}><button className="secondary-button" disabled={busy} onClick={()=>void requestClose().then(allowed=>{if(allowed)onClose();})}>{savedBatch&&!dirty?"稍后处理":"取消"}</button>{dirty||!savedBatch?<button className="primary-button" disabled={busy||!canSave} onClick={()=>void saveQuote()}>{busy?"保存中…":"保存报价"}</button>:accessLevel>=4&&pendingIds.length>0?<button className="primary-button" disabled={busy||(exceptions.stale.length>0&&!keepCost)||(exceptions.belowBreakEven.length>0&&!confirmLow)} onClick={()=>void adoptPendingItems()}>{busy?"处理中…":"确认采用"}</button>:null}</FormFooter></Drawer>{confirmation}</>;
}
