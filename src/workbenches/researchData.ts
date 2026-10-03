import {useCallback,useEffect,useRef,useState} from "react";
import {fetchJson} from "../api";
import {compareCostPeriods} from "./researchAnalytics";
import {type Product,type Version,base,errorText} from "./researchModel";

export function useResearchData(active:boolean) {
 const [products,setProducts]=useState<Product[]|null>(null),[versions,setVersions]=useState<Version[]>([]),[formulas,setFormulas]=useState<Product[]>([]),[owners,setOwners]=useState<string[]>([]);
 const [pending,setPending]=useState(false),[loading,setLoading]=useState(true),[notice,setNotice]=useState("");
 const reads=useRef({active:false,controller:null as AbortController|null});
 const load=useCallback(async(force=true)=>{
  const state=reads.current;if(!state.active)return;
  if(state.controller&&!state.controller.signal.aborted){if(!force)return;state.controller.abort();}
  const controller=new AbortController();state.controller=controller;setLoading(true);
  try{
   const signal=controller.signal;
   const [data,history,catalog]=await Promise.all([fetchJson<{products:Product[];pending:boolean}>(`${base}/products`,{signal}),fetchJson<{versions:Version[]}>(`${base}/history`,{signal}),fetchJson<{formulas:Product[];owners:string[]}>(`${base}/formulas`,{signal})]);
   if(signal.aborted||!state.active)return;
   setProducts(data.products);setPending(data.pending);setVersions(compareCostPeriods(history.versions));setFormulas(catalog.formulas);setOwners(catalog.owners);setNotice("");
  }catch(error){if(!controller.signal.aborted&&state.active)setNotice(errorText(error));}
  finally{if(state.controller===controller){state.controller=null;if(!controller.signal.aborted&&state.active)setLoading(false);controller.abort();}}
 },[]);
 useEffect(()=>{
  const state=reads.current;state.active=active;if(!active)return;
  void load();const refresh=()=>void load(false);const timer=window.setInterval(refresh,10000);
  window.addEventListener("focus",refresh);
  return()=>{state.active=false;state.controller?.abort();clearInterval(timer);window.removeEventListener("focus",refresh);};
 },[active,load]);
 return {products,versions,formulas,owners,pending,loading,notice,load};
}
