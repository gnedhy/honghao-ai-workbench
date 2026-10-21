import {fetchJson} from "../api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProcurementMaterial, ProcurementOverview } from "../types";
import { buildLedgerRows, filterLedgerRows } from "./procurementLedger";

export function useProcurementMaterialQuery(materials:ProcurementMaterial[],data:ProcurementOverview,current:ProcurementOverview["current_update"],edit:Parameters<typeof filterLedgerRows>[1]["edit"],values:Record<string,string>,pageSize:number,ledgerView:string,focusPending:boolean,locateCode:string,selecting:boolean,source="all") {
  const [query,setQuery]=useState("");
  const [movement,setMovement]=useState("all");
  const [editor,setEditor]=useState("");
  const [scope,setScope]=useState("all");
  const [sort,setSort]=useState("change");
  const [sortDirection,setSortDirection]=useState<"ascending"|"descending">("descending");
  const [page,setPage]=useState(1);
  const [filterNotice,setFilterNotice]=useState("");
  const resetSort=useCallback(()=>{setSort("code");setSortDirection("ascending");},[]);
  const serverMode=Boolean(data.read_page)&&!edit;
  const [remote,setRemote]=useState<ProcurementOverview|null>(null);
  const [loadError,setLoadError]=useState("");
  const versionRef=useRef<string|undefined>(undefined);
  const version=page>1?versionRef.current:undefined;
  const filters=JSON.stringify({search:query,movement,scope,editor,sort,direction:sortDirection,source,...(version?{version}:{})});
  const criteria=JSON.stringify({query,movement,scope,editor,sort,sortDirection,source,pageSize,selecting});
  const previousCriteria=useRef(criteria);
  useEffect(()=>{
    const changed=previousCriteria.current!==criteria;previousCriteria.current=criteria;
    if(!serverMode||(changed&&page>1))return;
    const controller=new AbortController();setLoadError("");if(ledgerView!=="scroll"||page===1)setRemote(null);
    fetchJson<ProcurementOverview>(`/api/workbenches/procurement/overview?read_mode=ledger&page=${page}&page_size=${pageSize}&filters=${encodeURIComponent(filters)}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){versionRef.current=value.read_page?.version;setRemote(previous=>{
      if(ledgerView!=="scroll"||page===1||!previous||value.read_page?.page!==page)return value;
      const ids=new Set(value.materials.map(item=>item.id));
      const update=value.current_update&&previous.current_update?.id===value.current_update.id?{...value.current_update,
        input_items:[...previous.current_update.input_items.filter(item=>!ids.has(item.material_id)),...value.current_update.input_items],
        items:[...previous.current_update.items.filter(item=>!ids.has(item.material_id)),...value.current_update.items],
        issues:[...previous.current_update.issues.filter(item=>!ids.has(item.material_id)),...value.current_update.issues]}:value.current_update;
      return {...value,current_update:update,materials:[...previous.materials.filter(item=>!ids.has(item.id)),...value.materials],ledger_comparison:value.ledger_comparison?{...value.ledger_comparison,items:{...previous.ledger_comparison?.items,...value.ledger_comparison.items}}:value.ledger_comparison};
    });}}).catch(error=>{if(!controller.signal.aborted){if(error?.status===409){setRemote(null);setPage(1);return;}if(error?.status===401||error?.status===403)setRemote(null);setLoadError("原料台账读取失败，请重新读取。");}});
    return()=>controller.abort();
  },[serverMode,page,pageSize,filters,data,ledgerView,criteria]);
  const effective=serverMode?remote:data;
  const pageMaterials=serverMode?(remote?.materials??materials):materials;
  const allRows=useMemo(()=>buildLedgerRows(pageMaterials,effective?.current_update??null),[pageMaterials,effective]);
  const formalComparison=effective?.ledger_comparison??effective?.batches[0]?.comparison;
  const editors=data.editors??[];
  const selectedPerson=editors.find(person=>person.id===editor)?.name??"";
  const filtered=useMemo(()=>serverMode?allRows:filterLedgerRows(allRows,{query,movement,scope,editor,selectedPerson,current,comparison:formalComparison,sort,sortDirection,edit,values}),[serverMode,allRows,query,movement,scope,editor,selectedPerson,current,formalComparison,sort,sortDirection,edit,values]);
  const rows=serverMode?allRows:filtered;
  const total=serverMode?(remote?.read_page?.total??0):rows.length;
  useEffect(()=>{setPage(1);},[query,editor,movement,scope,sort,sortDirection,pageSize,selecting,source]);
  useEffect(()=>{setScope(focusPending?"involved":"all");setMovement("all");setQuery("");},[focusPending]);
  useEffect(()=>{if(locateCode)setQuery(locateCode);},[locateCode]);
  const currentId=current?.id;
  const previousId=useRef(currentId);
  useEffect(()=>{if(previousId.current!==currentId){previousId.current=currentId;if(!currentId&&scope!=="all"){setScope("all");setFilterNotice("本轮已结束，已恢复全部原料");}}},[currentId,scope]);
  const pageCount=Math.max(1,Math.ceil(total/pageSize));
  const safePage=Math.min(page,pageCount);
  const visibleRows=serverMode?rows:ledgerView==="paged"?rows.slice((safePage-1)*pageSize,safePage*pageSize):rows;
  return {displayedUpdate:effective?.current_update??null,total,scopeTotal:serverMode?(remote?.read_page?.scope_total??data.metrics.material_count):materials.length,loading:serverMode&&!remote&&!loadError,loadError,serverMode,query,movement,editor,scope,sort,sortDirection,page,safePage,rows,allRows,visibleRows,selectedPerson,formalComparison,filterNotice,
    actions:{setQuery,setMovement,setEditor,setScope,setSort,setSortDirection,setPage,setFilterNotice,resetSort,
      filterTasks:(next:string)=>{setScope(next);setQuery("");setMovement("all");setPage(1);}}};
}
