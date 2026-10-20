import {useEffect,useState} from "react";
import {preferredTrendId} from "../codeOrder";

export function useTrendSelection(account:string, workbench:string, items:{id:string;code:string}[], eligible:ReadonlySet<string>) {
  const key=`trend-selection:${account}:${workbench}`;
  const read=()=>{try{return sessionStorage.getItem(key)??"";}catch{return "";}};
  const [saved,setSaved]=useState(()=>({key,id:read()}));
  const remembered=saved.key===key?saved.id:read();
  const visible=items.some(item=>item.id===remembered);
  const selected=visible?remembered:preferredTrendId(items,eligible);
  useEffect(()=>{
    if(saved.key===key&&(!remembered||visible))return;
    if(!visible){try{sessionStorage.removeItem(key);}catch{/* Memory remains usable when storage is unavailable. */}}
    setSaved({key,id:visible?remembered:""});
  },[key,saved.key,remembered,visible]);
  const select=(id:string)=>{
    if(!items.some(item=>item.id===id))return;
    setSaved({key,id});
    try{sessionStorage.setItem(key,id);}catch{/* Keep the selection in component memory. */}
  };
  return [selected,select] as const;
}
