import {useEffect,useState} from "react";
import {ChevronRight} from "lucide-react";
import {CartesianGrid,Line,LineChart,ResponsiveContainer,Tooltip,XAxis,YAxis} from "recharts";
import {fetchJson} from "../api";
import type {ProcurementMaterialDetail} from "../types";
import {PagedHistoryBrowser,type HistoryQuery} from "../components/HistoryBrowser";
import {PriceDateRangeMenu} from "../components/WorkbenchMenus";
import {WorkbenchLoading} from "../components/WorkbenchLayout";
import {moverDateRange,type PriceSeries} from "./procurementAnalytics";
import {ChartEmpty,Price,price,formatPriceDate,shortDate} from "./ProcurementPriceDisplay";
import styles from "../components/WorkbenchSurface.module.css";
type Record=ProcurementMaterialDetail["official_history"][number];
type Page={items:Record[];total:number;scope_total:number;start_date:string;end_date:string;version:string;page:number};
export function ProcurementMaterialHistory({read}:{read:NonNullable<ProcurementMaterialDetail["history_read"]>}) {
  const [query,setQuery]=useState<HistoryQuery>({search:"",start:"",end:"",page:1});
  const [page,setPage]=useState<Page|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
  const [period,setPeriod]=useState<"14d"|"1m"|"3m"|{start:string;end:string}>("3m");
  const range=typeof period==="string"?moverDateRange(read.end_date??new Date().toISOString().slice(0,10),period):period;
  const [trend,setTrend]=useState<PriceSeries[]|null>(null),[trendError,setTrendError]=useState("");
  const version=query.page>1?page?.version:undefined;
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError("");
    const params=new URLSearchParams({search:query.search,start:query.start,end:query.end,page:String(query.page),...(version?{version}:{})});
    fetchJson<Page>(`${read.base}/official-history?${params}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setPage(value);}).catch(error=>{
      if(controller.signal.aborted)return;
      if(error?.status===409){setPage(null);setQuery(value=>({...value,page:1}));}
      else {setError(error instanceof Error?error.message:"历史记录读取失败");if([401,403,404].includes(error?.status))setPage(null);}
    }).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[read.base,read.end_date,read.version,query.search,query.start,query.end,query.page,retry,version]);
  useEffect(()=>{
    const controller=new AbortController();setTrend(null);setTrendError("");
    fetchJson<{batches:PriceSeries[]}>(`${read.base}/trend?start=${range.start}&end=${range.end}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setTrend(value.batches);}).catch(error=>{if(!controller.signal.aborted)setTrendError(error instanceof Error?error.message:"趋势读取失败");});
    return()=>controller.abort();
  },[read.base,read.version,range.start,range.end,retry]);
  const points=[...(trend??[])].reverse().map(batch=>({date:batch.price_date||batch.published_at,value:batch.items[0]?.latest_price==null?null:Number(batch.items[0].latest_price)}));
  return <>
    <section className={styles.drawerSection}><div className={styles.panelHeading}><h3>行情价格走势</h3><PriceDateRangeMenu label="走势日期范围" period={period} range={range} onChange={setPeriod}/></div>
      {trendError?<p role="alert">{trendError}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></p>:trend===null?<WorkbenchLoading local title="正在读取价格走势"/>:points.filter(point=>point.value!==null).length<2?<ChartEmpty title="暂无可比较周期" detail="至少需要两期有效价格。"/>:<div className={styles.detailChart}><ResponsiveContainer width="100%" height="100%"><LineChart data={points}><CartesianGrid stroke="#edf0f1" vertical={false}/><XAxis dataKey="date" tickFormatter={shortDate} axisLine={false} tickLine={false}/><YAxis axisLine={false} tickLine={false} width={42}/><Tooltip labelFormatter={value=>formatPriceDate(String(value))} formatter={value=>[price(String(value)),"行情价格"]}/><Line isAnimationActive={false} type="monotone" dataKey="value" stroke="#2f3337" strokeWidth={2} dot={{r:2.5}}/></LineChart></ResponsiveContainer></div>}
    </section>
    <section className={styles.drawerSection}><h3>行情历史<small>{read.total} 期价格记录</small></h3><div className={styles.priceHistory}><PagedHistoryBrowser items={page?.items??[]} total={page?.total??read.total} scopeTotal={page?.scope_total??read.total} startDate={page?.start_date??read.start_date??undefined} endDate={page?.end_date??read.end_date??undefined} query={query} onQuery={setQuery} loading={loading} error={error} onRetry={()=>setRetry(value=>value+1)} empty="尚无行情历史。">{items=><><div className={styles.priceHistoryHeading} aria-hidden="true"><span>版本日期</span><span>价格</span><span>修改人</span><span/></div>{items.map(item=><OfficialRecord key={item.id} item={item} base={read.base}/>)}</>}</PagedHistoryBrowser></div></section>
  </>;
}
function OfficialRecord({item,base}:{item:Record;base:string}) {
  const [detail,setDetail]=useState<Record|null>(null),[error,setError]=useState(""),[open,setOpen]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!open)return;const controller=new AbortController();setError("");
    fetchJson<Record>(`${base}/official-history/${encodeURIComponent(item.id)}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setDetail(value);}).catch(error=>{if(!controller.signal.aborted){setError(error instanceof Error?error.message:"记录读取失败");setDetail(null);}});
    return()=>controller.abort();
  },[base,item.id,open,retry]);
  return <details className={styles.priceHistoryRecord} onToggle={event=>setOpen(event.currentTarget.open)}><summary aria-label={`v${item.version} ${formatPriceDate(item.version_date)}，价格 ${item.latest_price==null?item.raw_price??"未定价":price(item.latest_price)}，修改人 ${item.modifier?.name||"未记录"}`}><span className={styles.historyDate}>{formatPriceDate(item.version_date)}<small>v{item.version}</small></span><strong>{item.latest_price==null?item.raw_price??"未定价":<Price value={item.latest_price}/>}</strong><span>{item.modifier?.name||"未记录"}</span><ChevronRight size={13}/></summary>{error?<p role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></p>:detail?<dl className={styles.historySource}><div><dt>价格来源日期</dt><dd>{detail.price_date?formatPriceDate(detail.price_date):"未记录"}</dd></div><div><dt>数据位置</dt><dd>{[detail.sheet,detail.cell].filter(Boolean).join(" · ")||"未记录"}</dd></div></dl>:<WorkbenchLoading local title="正在读取历史来源"/>}</details>;
}
