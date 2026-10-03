import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProcurementMaterial, ProcurementOverview } from "../types";
import { buildLedgerRows, filterLedgerRows } from "./procurementLedger";

export function useProcurementMaterialQuery(materials:ProcurementMaterial[],data:ProcurementOverview,current:ProcurementOverview["current_update"],edit:Parameters<typeof filterLedgerRows>[1]["edit"],values:Record<string,string>,pageSize:number,ledgerView:string,focusPending:boolean,locateCode:string,selecting:boolean) {
  const [query,setQuery]=useState("");
  const [movement,setMovement]=useState("all");
  const [editor,setEditor]=useState("");
  const [scope,setScope]=useState("all");
  const [sort,setSort]=useState("change");
  const [sortDirection,setSortDirection]=useState<"ascending"|"descending">("descending");
  const [page,setPage]=useState(1);
  const [filterNotice,setFilterNotice]=useState("");
  const resetSort=useCallback(()=>{setSort("code");setSortDirection("ascending");},[]);
  const allRows=useMemo(()=>buildLedgerRows(materials,current),[materials,current]);
  const formalComparison=data.ledger_comparison??data.batches[0]?.comparison;
  const editors=data.editors??[];
  const selectedPerson=editors.find(person=>person.id===editor)?.name??"";
  const rows=useMemo(()=>filterLedgerRows(allRows,{query,movement,scope,editor,selectedPerson,current,comparison:formalComparison,sort,sortDirection,edit,values}),[allRows,query,movement,scope,editor,selectedPerson,current,formalComparison,sort,sortDirection,edit,values]);
  useEffect(()=>{setPage(1);},[query,editor,movement,scope,sort,sortDirection,pageSize,selecting]);
  useEffect(()=>{setScope(focusPending?"involved":"all");setMovement("all");setQuery("");},[focusPending]);
  useEffect(()=>{if(locateCode)setQuery(locateCode);},[locateCode]);
  const currentId=current?.id;
  const previousId=useRef(currentId);
  useEffect(()=>{if(previousId.current!==currentId){previousId.current=currentId;if(!currentId&&scope!=="all"){setScope("all");setFilterNotice("本轮已结束，已恢复全部原料");}}},[currentId,scope]);
  const pageCount=Math.max(1,Math.ceil(rows.length/pageSize));
  const safePage=Math.min(page,pageCount);
  const visibleRows=ledgerView==="paged"?rows.slice((safePage-1)*pageSize,safePage*pageSize):rows;
  return {query,movement,editor,scope,sort,sortDirection,page,safePage,rows,allRows,visibleRows,selectedPerson,formalComparison,filterNotice,
    actions:{setQuery,setMovement,setEditor,setScope,setSort,setSortDirection,setPage,setFilterNotice,resetSort,
      filterTasks:(next:string)=>{setScope(next);setQuery("");setMovement("all");setPage(1);}}};
}
