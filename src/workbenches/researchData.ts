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
   const response=await fetch(`${base}/overview`,{signal,cache:"no-store",headers:!force&&state.etag?{"If-None-Match":state.etag}:{}});
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
  void load();const refresh=()=>void load(false);const timer=window.setInterval(refresh,10000);
  window.addEventListener("focus",refresh);
  return()=>{state.active=false;state.controller?.abort();clearInterval(timer);window.removeEventListener("focus",refresh);};
 },[active,load]);
 return {products,versions,formulas,owners,creationDepartments,pending,loading,notice,load};
}
