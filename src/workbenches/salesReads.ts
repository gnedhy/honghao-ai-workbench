import {useEffect,useState,useRef} from "react";
import {fetchJson} from "../api";
import {base,type Batch,type QuoteListStatus} from "./salesModel";
export type SalesOverview={counts:Partial<Record<QuoteListStatus,number>>;active:number;pending:{batch:Batch;status:QuoteListStatus}[];recent:{batch:Batch;status:QuoteListStatus}[];hot:{product_id:string;batches:number;adopted:number}[];eligible:string[]};
export type SalesPageResult<T>={items:T[];total:number;page:number;page_size:number;version:string;reset:boolean};
export function useSalesRead<T>(path:string|null,revision=0){
 const [data,setData]=useState<T|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();setData(null);setError("");if(!path){setLoading(false);return;}setLoading(true);void fetchJson<T>(base+path,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setData(value);}).catch(value=>{if(!controller.signal.aborted)setError(value instanceof Error?value.message:"读取失败");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[path,revision,retry]);
 return {data,error,loading,retry:()=>setRetry(v=>v+1)};
}
export function useSalesPage<T>(kind:string,query:Record<string,string|number>,revision=0){
 const token=useRef("");const filter=JSON.stringify({...query,page:0});const previous=useRef(filter);
 if(previous.current!==filter){token.current="";previous.current=filter;}
 const params=new URLSearchParams(Object.entries(query).map(([key,value])=>[key,String(value)]));if(token.current)params.set("token",token.current);
 const result=useSalesRead<SalesPageResult<T>>(`/read/pages/${kind}?${params}`,revision);
 useEffect(()=>{if(result.data)token.current=result.data.version;},[result.data]);
 return result;
}

export type SalesCatalog={products:import("./salesModel").Product[];total:number;page:number;departments:string[]};
export const selectedSalesProducts=(ids:string[])=>fetchJson<{products:import("./salesModel").Product[]}>(base+"/read/products",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids})});
