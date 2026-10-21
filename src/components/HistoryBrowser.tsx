import {useState, type ReactNode} from "react";
import {Search} from "lucide-react";
import {PriceDateRangeMenu} from "./WorkbenchMenus";
import {LedgerPagination} from "./LedgerPagination";
import {WorkbenchLoading} from "./WorkbenchLayout";
import p from "./WorkbenchSurface.module.css";
import s from "./HistoryBrowser.module.css";
export function HistoryBrowser<T>({items,date,text,children,empty}: {items:T[];date:(item:T)=>string;text:(item:T)=>string;children:(items:T[])=>ReactNode;empty:string}) {
  const [query,setQuery]=useState(""),[from,setFrom]=useState(""),[to,setTo]=useState(""),[limit,setLimit]=useState(10);
  const [preset,setPreset]=useState<"14d"|"1m"|"3m"|null>(null);
  const dates=items.map(item=>date(item).slice(0,10)).filter(Boolean).sort();
  const range={start:from||dates[0]||"",end:to||dates.at(-1)||""};
  const changeRange=(value:"14d"|"1m"|"3m"|{start:string;end:string})=>{
    if(typeof value==="string") {
      const end=dates.at(-1)!;
      const start=new Date(`${end}T00:00:00Z`);
      if(value==="14d")start.setUTCDate(start.getUTCDate()-13);
      else start.setUTCMonth(start.getUTCMonth()-(value==="1m"?1:3));
      setFrom(start.toISOString().slice(0,10));setTo(end);setPreset(value);
    } else {setFrom(value.start);setTo(value.end);setPreset(null);}
    setLimit(10);
  };
  const filtered=items.filter(item=>(!from||date(item).slice(0,10)>=from)&&(!to||date(item).slice(0,10)<=to)&&text(item).toLowerCase().includes(query.trim().toLowerCase()));
  const clear=()=>{setQuery("");setFrom("");setTo("");setPreset(null);setLimit(10);};
  if(!items.length)return <p className={s.empty}>{empty}</p>;
  return <div className={s.root}><div className={`${p.toolbar} ${s.filters}`}><label className={p.searchField}><Search size={15}/><input type="search" aria-label="查找记录" placeholder="搜索日期、版本或说明" value={query} onChange={e=>{setQuery(e.target.value);setLimit(10);}}/></label><PriceDateRangeMenu label="历史日期范围" allSelected={!from&&!to} onAll={()=>{setFrom("");setTo("");setPreset(null);setLimit(10);}} period={preset??range} range={range} onChange={changeRange}/></div><div className={s.count}><span>显示 {Math.min(limit,filtered.length)} / {filtered.length} 条 · 共 {items.length} 条</span>{(query||from||to)&&<button type="button" onClick={clear}>清除历史筛选</button>}</div>{filtered.length?children(filtered.slice(0,limit)):<p className={s.empty}>当前条件下没有历史记录，请调整或清除筛选。</p>}{limit<filtered.length&&<button type="button" className="secondary-button" onClick={()=>setLimit(value=>value+10)}>查看更多记录</button>}{limit>10&&<button type="button" className="secondary-button" onClick={()=>setLimit(10)}>收起记录</button>}</div>;
}

export type HistoryQuery = {search:string;start:string;end:string;page:number};
export function PagedHistoryBrowser<T>({items,total,scopeTotal,startDate,endDate,query,onQuery,loading=false,error="",onRetry,empty,children,pageSize=10}: {
  items:T[];total:number;scopeTotal?:number;startDate?:string;endDate?:string;query:HistoryQuery;onQuery:(query:HistoryQuery)=>void;
  loading?:boolean;error?:string;onRetry?:()=>void;empty:string;children:(items:T[])=>ReactNode;pageSize?:number;
}) {
  const [preset,setPreset]=useState<"14d"|"1m"|"3m"|null>(null);
  const range={start:query.start||startDate||"",end:query.end||endDate||new Date().toISOString().slice(0,10)};
  const clear=()=>{setPreset(null);onQuery({search:"",start:"",end:"",page:1});};
  const changeRange=(value:"14d"|"1m"|"3m"|{start:string;end:string})=>{
    if(typeof value==="string"){
      const end=endDate||range.end, start=new Date(`${end}T00:00:00Z`);
      if(value==="14d")start.setUTCDate(start.getUTCDate()-13);else start.setUTCMonth(start.getUTCMonth()-(value==="1m"?1:3));
      setPreset(value);onQuery({...query,start:start.toISOString().slice(0,10),end,page:1});
    }else{setPreset(null);onQuery({...query,...value,page:1});}
  };
  const filtered=Boolean(query.search||query.start||query.end);
  return <div className={s.root} aria-busy={loading}>
    <div className={`${p.toolbar} ${s.filters}`}><label className={p.searchField}><Search size={15}/><input type="search" aria-label="查找记录" placeholder="搜索日期、版本或说明" value={query.search} onChange={event=>onQuery({...query,search:event.target.value,page:1})}/></label><PriceDateRangeMenu label="历史日期范围" allSelected={!query.start&&!query.end} onAll={()=>{setPreset(null);onQuery({...query,start:"",end:"",page:1});}} period={preset??range} range={range} onChange={changeRange}/></div>
    <div className={s.count}><span>共 {total} 条{scopeTotal!=null&&filtered?` · 全部 ${scopeTotal} 条`:""}</span>{filtered&&<button type="button" onClick={clear}>清除历史筛选</button>}</div>
    {error&&<p role="alert">{error}{onRetry&&<button type="button" className="secondary-button" onClick={onRetry}>重试</button>}</p>}
    {items.length?children(items):loading?<WorkbenchLoading local title="正在读取历史记录"/>:!error?<p className={s.empty}>{filtered?"当前条件下没有历史记录，请调整或清除筛选。":empty}</p>:null}
    {total>pageSize&&<LedgerPagination total={total} page={query.page} pageSize={pageSize} onPageChange={page=>onQuery({...query,page})}/>}
  </div>;
}
