import type {ReactNode} from "react";
import s from "./PriceCards.module.css";

type Item<K extends string> = {key:K;label:string;amount:ReactNode;unit?:string;description?:ReactNode};

export function PriceCards<K extends string>({items,label,value,onChange,panelId,disabled=false}:{items:Item<K>[];label:string;value?:K;onChange?:(value:K)=>void;panelId?:string;disabled?:boolean}) {
 const interactive=!!onChange&&items.length>1;
 return <div className={s.cards} role={interactive?"tablist":"group"} aria-label={label}>{items.map((item,index)=>{
  const content=<><span className={s.label}>{item.label}</span><div className={s.amount}>{item.amount}</div>{item.unit&&<small className={s.unit}>{item.unit}</small>}</>;
  return <div className={s.item} key={item.key}>{interactive?<button type="button" role="tab" className={s.card} id={panelId?`${panelId}-${item.key}`:undefined} aria-controls={panelId} aria-selected={value===item.key} tabIndex={value===item.key?0:-1} disabled={disabled} onClick={()=>onChange?.(item.key)} onKeyDown={event=>{
   if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
   event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowRight"?1:-1)+items.length)%items.length;
   onChange?.(items[next].key);event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({preventScroll:true});
  }}>{content}</button>:<div className={s.card}>{content}</div>}{item.description&&<div className={s.description}>{item.description}</div>}</div>;
 })}</div>;
}
