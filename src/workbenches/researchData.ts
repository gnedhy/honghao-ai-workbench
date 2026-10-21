import {useCallback,useEffect,useRef,useState} from "react";
import {responseJson} from "../api";
import {compareCostPeriods} from "./researchAnalytics";
import {type Product,type Version,base,errorText} from "./researchModel";

export type ResearchDashboardSummary={latest_date:string;metrics:{products:number;up:number;down:number;missing:number;warnings:number;failed:number;drafts:number;tasks:number;periods:number;recent:string|null}};

export function useResearchData(active:boolean) {
 const [dashboard,setDashboard]=useState<ResearchDashboardSummary|null>(null);
 const [products,setProducts]=useState<Product[]|null>(null),[versions,setVersions]=useState<Version[]>([]),[formulas,setFormulas]=useState<Product[]>([]),[owners,setOwners]=useState<string[]>([]);
 const [pending,setPending]=useState(false),[loading,setLoading]=useState(true),[notice,setNotice]=useState("");
 const [creationDepartments,setCreationDepartments]=useState<{id:string;name:string}[]>([]);
 const reads=useRef({active:false,failed:false,etag:null as string|null,controller:null as AbortController|null});
 const load=useCallback(async(force=true)=>{
  const state=reads.current;if(!state.active||(!force&&state.failed))return;
  if(state.controller&&!state.controller.signal.aborted){if(!force)return;state.controller.abort();}
  const controller=new AbortController();state.controller=controller;if(force)setLoading(true);
  const timeout=AbortSignal.timeout(15000);
  try{
   const signal=AbortSignal.any([controller.signal,timeout]);
   const response=await fetch(`${base}/dashboard`,{signal,cache:"no-store",headers:state.etag?{"If-None-Match":state.etag}:{}});
   if(signal.aborted||!state.active)return;
   if(response.status===304){state.failed=false;setNotice("");return;}
   const data=await responseJson<{products:Product[];pending:boolean;versions:Version[];formulas:Product[];owners:string[];departments?:{id:string;name:string}[];dashboard?:ResearchDashboardSummary}>(response);
   if(signal.aborted||!state.active)return;
   state.etag=response.headers.get("ETag");
   state.failed=false;setDashboard(data.dashboard??null);setProducts(data.products);setPending(data.pending);setVersions(compareCostPeriods(data.versions));setFormulas(data.formulas);setOwners(data.owners);setCreationDepartments(data.departments??[]);setNotice("");
  }catch(error){if(!controller.signal.aborted&&state.active){state.failed=true;if(error instanceof Error && "status" in error && (error.status===401||error.status===403)){state.etag=null;setDashboard(null);setProducts(null);setVersions([]);setFormulas([]);setOwners([]);setCreationDepartments([]);setPending(false);}setNotice(timeout.aborted ? "数据读取超过15秒，请重试。" : errorText(error));}}
  finally{if(state.controller===controller){state.controller=null;if(!controller.signal.aborted&&state.active)setLoading(false);controller.abort();}}
 },[]);
 useEffect(()=>{
  const state=reads.current;state.active=active;if(!active)return;
  void load();const refresh=()=>{if(document.visibilityState!=="hidden")void load(false);};const timer=window.setInterval(refresh,60000);
  window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",refresh);window.addEventListener("activation-grants-changed",refresh);
  return()=>{state.active=false;state.controller?.abort();clearInterval(timer);window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",refresh);window.removeEventListener("activation-grants-changed",refresh);};
 },[active,load]);
 return {products,versions,formulas,owners,creationDepartments,pending,loading,notice,load,dashboard};
}

export type ResearchPageData={items:Product[];total:number;scope_total:number;page:number;page_size:number;owners:string[];department_names:string[];departments:{id:string;name:string}[];creation_owners:string[];pending:boolean};
export function useResearchPage(kind:"products"|"formulas",query:URLSearchParams,revision:number) {
 const url=`${base}/pages/${kind}?${query.toString()}`;
 const [result,setResult]=useState<{url:string;data:ResearchPageData}|null>(null),[notice,setNotice]=useState("");
 const [loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let active=true,controller:AbortController|null=null,etag:string|null=null;
  const load=async()=>{
   if(controller||document.visibilityState==="hidden")return;
   const current=new AbortController();controller=current;setLoading(true);
   try{
    const signal=AbortSignal.any([current.signal,AbortSignal.timeout(15000)]);
    const response=await fetch(url,{signal,cache:"no-store",headers:etag?{"If-None-Match":etag}:{}});
    if(!active||signal.aborted)return;
    if(response.status!==304){
     const data=await responseJson<ResearchPageData>(response);
     if(!active||signal.aborted)return;
     etag=response.headers.get("ETag");setResult({url,data});
    }
    setNotice("");
   }catch(error){if(active&&!current.signal.aborted){if(error instanceof Error && "status" in error && (error.status===401||error.status===403)){setResult(null);etag=null;}setNotice(errorText(error));}}
   finally{if(active){controller=null;setLoading(false);}}
  };
  void load();const refresh=()=>void load();const timer=window.setInterval(refresh,60000);
  window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",refresh);window.addEventListener("activation-grants-changed",refresh);
  return()=>{active=false;controller?.abort();clearInterval(timer);window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",refresh);window.removeEventListener("activation-grants-changed",refresh);};
 },[url,revision,retry]);
 return {data:result?(result.url===url?result.data:{...result.data,items:[],page:Number(query.get("page")??1)}):null,notice,loading:loading||Boolean(result&&result.url!==url),reload:()=>setRetry(value=>value+1)};
}

export function useResearchRead<T>(url:string|null,revision:number|string=0) {
 const [result,setResult]=useState<{url:string;data:T}|null>(null),[error,setError]=useState("");
 const [status,setStatus]=useState(0);
 const [loading,setLoading]=useState(Boolean(url)),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  if(!url){setResult(null);setLoading(false);setError("");setStatus(0);return;}
  let active=true,controller:AbortController|null=null,etag:string|null=null;
  const load=async()=>{
   if(controller)return;
   const current=new AbortController();controller=current;setLoading(true);const timeout=AbortSignal.timeout(15000);
   try{
    const signal=AbortSignal.any([current.signal,timeout]);
    const response=await fetch(url,{signal,cache:"no-store",headers:etag?{"If-None-Match":etag}:{}});
    if(!active||signal.aborted)return;
    if(response.status!==304){const data=await responseJson<T>(response);if(!active||signal.aborted)return;etag=response.headers.get("ETag");setResult({url,data});}
    setError("");setStatus(0);
   }catch(reason){if(active&&!current.signal.aborted){if(reason instanceof Error&&"status" in reason&&[401,403,404].includes(Number(reason.status))){setResult(null);etag=null;}setStatus(reason instanceof Error&&"status" in reason?Number(reason.status):0);setError(timeout.aborted?"数据读取超过15秒，请重试。":errorText(reason));}}
   finally{if(active){controller=null;setLoading(false);}}
  };
  setError("");setStatus(0);setLoading(true);void load();
  const refresh=()=>{if(document.visibilityState!=="hidden")void load();};
  const timer=window.setInterval(refresh,60000);
  document.addEventListener("visibilitychange",refresh);window.addEventListener("focus",refresh);window.addEventListener("activation-grants-changed",refresh);
  return()=>{active=false;controller?.abort();clearInterval(timer);document.removeEventListener("visibilitychange",refresh);window.removeEventListener("focus",refresh);window.removeEventListener("activation-grants-changed",refresh);};
 },[url,revision,attempt]);
 return {data:result?.url===url?result.data:null,error,status,loading,reload:()=>setAttempt(value=>value+1)};
}
