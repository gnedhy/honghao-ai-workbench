import {useState,useEffect,useRef} from "react";
import {ChevronRight} from "lucide-react";
import {PagedHistoryBrowser,type HistoryQuery} from "../components/HistoryBrowser";
import {WorkbenchLoading} from "../components/WorkbenchLayout";
import {useResearchRead} from "./researchData";
import {HistoricalFormula,Money,Movement} from "./ResearchProductView";
import {type RecordRow,type Version,productPath,recordDate,date} from "./researchModel";
import s from "./ResearchWorkbench.module.css";

type HistoryPage={version:string;items:RecordRow[];total:number;scope_total:number;min_date:string;max_date:string};
function RecordDetail({productId,eventId,policy,busy,onClose}:{productId:string;eventId:string;policy:"latest"|"inventory";busy:boolean;onClose:()=>void}) {
 const read=useResearchRead<Version>(`${productPath(productId)}/history-record/${encodeURIComponent(eventId)}`);
 return <div className={s.expandedRecord}>{read.error?<p role="alert">{read.error}<button className="secondary-button" onClick={read.reload}>重试</button></p>:read.data?.products[0]?<HistoricalFormula busy={busy} record={read.data.products[0]} initialPolicy={policy}/>:<WorkbenchLoading local title="正在读取本期核算明细"/>}<button className={s.back} onClick={onClose}>收起本期明细</button></div>;
}
export function ResearchProductHistory({id,policy,revision,busy}:{id:string;policy:"latest"|"inventory";revision:number;busy:boolean}) {
 const [query,setQuery]=useState<HistoryQuery>({search:"",start:"",end:"",page:1});
 const [expanded,setExpanded]=useState<string|null>(null);
 const version=useRef("");
 const params=new URLSearchParams({...query,page:String(query.page),page_size:"10"});
 if(query.page>1&&version.current)params.set("version",version.current);
 const read=useResearchRead<HistoryPage>(`${productPath(id)}/history-page?${params}`,revision);
 useEffect(()=>{if(read.status===409){version.current="";setQuery(value=>({...value,page:1}));setExpanded(null);}},[read.status]);
 return <section className={s.historySection}><div className={s.sectionHeading}><h3>成本历史</h3><span title="按价格所属日期倒序，同日正式记录优先；涨跌保留原核算基准">行情优先 · {read.data?.scope_total??0} 条</span></div><PagedHistoryBrowser items={read.data?.items??[]} total={read.data?.total??0} scopeTotal={read.data?.scope_total} startDate={read.data?.min_date} endDate={read.data?.max_date} query={query} onQuery={next=>{version.current=next.page>1?(read.data?.version??version.current):"";setQuery(next);setExpanded(null);}} loading={read.loading} error={read.error} onRetry={read.reload} empty="尚未建立成本记录；配方启用并完成核算后可查看。">{items=>items.map(item=>{
  const eventId=item.event_id!,open=expanded===eventId;
  return <div key={eventId} className={s.inlineRecord}><button className={s.historyRow} aria-expanded={open} onClick={()=>setExpanded(open?null:eventId)}><span title={`记录时间：${date(item.recorded_at)}`}>{recordDate(item)}<small>{item.record_type==="backfill"?"历史回算 · ":""}{item.reason??"成本核算"}{item.purchase_version!=null&&item.record_type==="formal"&&` · 采购 v${item.purchase_version}`}</small></span><Money value={item.latest_cost}/><Movement change={item.change} comparisonBasis={item.comparison_basis}/><ChevronRight size={15} style={{transform:open?"rotate(90deg)":undefined}}/></button>{open&&<RecordDetail key={`${eventId}-${revision}`} productId={id} eventId={eventId} policy={policy} busy={busy} onClose={()=>setExpanded(null)}/>}</div>;
 })}</PagedHistoryBrowser></section>;
}
