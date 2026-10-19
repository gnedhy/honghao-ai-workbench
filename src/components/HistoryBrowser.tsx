import {useState, type ReactNode} from "react";
import {Search} from "lucide-react";
import {PriceDateRangeMenu} from "./WorkbenchMenus";
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
