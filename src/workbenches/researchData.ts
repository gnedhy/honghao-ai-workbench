import {useCallback,useEffect,useRef,useState} from "react";
import {responseJson} from "../api";
import {compareCostPeriods} from "./researchAnalytics";
import {type Product,type Version,base,errorText} from "./researchModel";

export function useResearchData(active:boolean) {
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
   const response=await fetch(`${base}/overview?summary=true`,{signal,cache:"no-store",headers:state.etag?{"If-None-Match":state.etag}:{}});
   if(signal.aborted||!state.active)return;
   if(response.status===304){state.failed=false;setNotice("");return;}
   const data=await responseJson<{products:Product[];pending:boolean;versions:Version[];formulas:Product[];owners:string[];departments?:{id:string;name:string}[]}>(response);
   if(signal.aborted||!state.active)return;
   state.etag=response.headers.get("ETag");
   state.failed=false;setProducts(data.products);setPending(data.pending);setVersions(compareCostPeriods(data.versions));setFormulas(data.formulas);setOwners(data.owners);setCreationDepartments(data.departments??[]);setNotice("");
  }catch(error){if(!controller.signal.aborted&&state.active){state.failed=true;if(error instanceof Error && "status" in error && (error.status===401||error.status===403)){state.etag=null;setProducts(null);setVersions([]);setFormulas([]);setOwners([]);setCreationDepartments([]);setPending(false);}setNotice(timeout.aborted ? "数据读取超过15秒，请重试。" : errorText(error));}}
  finally{if(state.controller===controller){state.controller=null;if(!controller.signal.aborted&&state.active)setLoading(false);controller.abort();}}
 },[]);
 useEffect(()=>{
  const state=reads.current;state.active=active;if(!active)return;
  void load();const refresh=()=>{if(document.visibilityState!=="hidden")void load(false);};const timer=window.setInterval(refresh,60000);
  window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",refresh);window.addEventListener("activation-grants-changed",refresh);
  return()=>{state.active=false;state.controller?.abort();clearInterval(timer);window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",refresh);window.removeEventListener("activation-grants-changed",refresh);};
 },[active,load]);
 return {products,versions,formulas,owners,creationDepartments,pending,loading,notice,load};
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
