import {useEffect,useState} from "react";
import {ArrowLeft,ChevronRight} from "lucide-react";
import {PagedHistoryBrowser,type HistoryQuery} from "../components/HistoryBrowser";
import {RecordFilters} from "../components/RecordFilters";
import {LedgerPagination} from "../components/LedgerPagination";
import {WorkbenchLoading} from "../components/WorkbenchLayout";
import {useResearchRead} from "./researchData";
import {base,date,recordDate,type Version,type RecordRow} from "./researchModel";
import {Drawer,HistoricalFormula,Money,Movement,ProductLink} from "./ResearchProductView";
import p from "../components/WorkbenchSurface.module.css";
import s from "./ResearchWorkbench.module.css";

const versionLabel=(version:Version)=>version.record_type==="backfill"?`采购 v${version.purchase_version??"—"} · 历史回算`:`成本 v${version.cost_version??"—"} · 正式记录`;
type Period=Version&{product_count:number;stats:{up:number;down:number;stable:number;missing:number}};
type HistoryPage={items:Period[];total:number;scope_total:number;min_date:string;max_date:string;page:number;version:string;counts:{all:number;formal:number;backfill:number}};

export function History({onOpen,onTrials,revision=0}:{versions?:Version[];onOpen:(id:string)=>void;onTrials:()=>void;revision?:number}) {
 const [query,setQuery]=useState<HistoryQuery>({search:"",start:"",end:"",page:1}),[kind,setKind]=useState("all"),[token,setToken]=useState("");
 const params=new URLSearchParams({...query,page:String(query.page),page_size:"10",record_type:kind});if(token)params.set("version",token);
 const read=useResearchRead<HistoryPage>(`${base}/history-page?${params}`,revision);
 useEffect(()=>{if(read.status===409&&token){setToken("");setQuery(value=>({...value,page:1}));}},[read.status,token]);
 const change=(next:HistoryQuery)=>{const same=next.search===query.search&&next.start===query.start&&next.end===query.end;setToken(same?read.data?.version??token:"");setQuery(next);};
 const counts=read.data?.counts??{all:0,formal:0,backfill:0};
 return <section className={s.historySection}><div className={s.sectionHeading}><div><h2>价格历史</h2><p className={s.explanation}>查看各期产品成本与取价依据，涨跌按行情优先成本与上一期比较。</p></div><button className="secondary-button" onClick={onTrials}>历史试算</button></div>
 <RecordFilters label="成本记录分类" value={kind} onChange={value=>{setKind(value);setToken("");setQuery(q=>({...q,page:1}));}} options={[{value:"all",label:"全部记录",count:counts.all},{value:"formal",label:"正式记录",count:counts.formal},{value:"backfill",label:"历史回算",count:counts.backfill}]}/>
 <PagedHistoryBrowser items={read.data?.items??[]} total={read.data?.total??0} scopeTotal={read.data?.scope_total} startDate={read.data?.min_date} endDate={read.data?.max_date} query={query} onQuery={change} loading={read.loading} error={read.status===409&&token?"":read.error} onRetry={read.reload} empty={read.data?.scope_total?"该分类或筛选范围暂无成本记录。":"正在建立第一期成本基线。"}>{items=><ol className={`${p.historyTimeline} ${s.researchTimeline}`}>{items.map((version,index)=>{
 const {up,down,stable,missing}=version.stats;
 return <li key={version.id}><i/><button onClick={()=>onOpen(version.id)}><span className={p.historyDate}><strong>{recordDate(version)}</strong>{query.page===1&&index===0&&<em>最新记录</em>}</span><span className={p.historySource}><strong>{versionLabel(version)}</strong><small title={version.reason}>{version.reason}</small></span><span className={p.historyBatchStats}><span>{version.product_count} 项</span>{stable===version.product_count?<span className={p.historyStable}>较上期无变化</span>:<>{up>0&&<span className={p.historyUp}>↑ {up}</span>}{down>0&&<span className={p.historyDown}>↓ {down}</span>}{stable>0&&<span className={p.historyStable}>持平 {stable}</span>}{missing>0&&<span>暂无对比 {missing}</span>}</>}</span><ChevronRight size={16}/></button></li>;
 })}</ol>}</PagedHistoryBrowser></section>;
}

type VersionPage=Version&{total:number;scope_total:number;page:number;version:string};
export function VersionDrawer({id,summary,onClose}:{id:string;summary?:Version;onClose:()=>void}) {
 const [query,setQuery]=useState({search:"",page:1}),[token,setToken]=useState(""),[selected,setSelected]=useState<RecordRow|null>(null);
 const params=new URLSearchParams({...query,page:String(query.page),page_size:"50"});if(token)params.set("version",token);
 const read=useResearchRead<VersionPage>(`${base}/history/${encodeURIComponent(id)}/products-page?${params}`);
 const productId=selected?.product_id??selected?.id;
 const frozen=useResearchRead<Version>(productId?`${base}/products/${encodeURIComponent(productId)}/history-record/${encodeURIComponent(id)}`:null);
 useEffect(()=>{if(read.status===409&&token){setToken("");setQuery(value=>({...value,page:1}));setSelected(null);}},[read.status,token]);
 const version=read.data,record=frozen.data?.products[0];
 const retry=()=>{read.reload();frozen.reload();};
 return <Drawer wide title={selected?.name??(version?versionLabel(version):summary?versionLabel(summary):"成本记录")} label={version?recordDate(version):"价格历史"} onClose={onClose}>{read.error?<div role="alert">{read.error}<button className="secondary-button" onClick={retry}>重试</button></div>:!version?<WorkbenchLoading local title="正在读取研发成本历史"/>:selected?<><button className={s.back} onClick={()=>setSelected(null)}><ArrowLeft size={14}/>返回版本明细</button>{frozen.error?<div role="alert">{frozen.error}<button className="secondary-button" onClick={frozen.reload}>重试</button></div>:record?<HistoricalFormula key={`${record.event_id}-${record.recorded_at}`} record={record}/>:<WorkbenchLoading local title="正在读取研发冻结明细"/>}</>:<>
 <div className={s.historySummary}><span>成本日期 <strong>{recordDate(version)}</strong></span><span>产品 <strong>{version.scope_total} 项</strong></span><span>{version.record_type==="backfill"?"历史回算":"正式记录"}</span></div><p className={s.explanation}>{version.reason}</p><p className={s.explanation}>记录时间：{date(version.recorded_at)}{version.record_type==="backfill"?"。按当期采购价格回算；当期缺价时使用的当前补位价在投料依据中标明。":""}</p>
 <label className={p.searchField}><input type="search" aria-label="搜索历史产品" placeholder="搜索产品内编" value={query.search} onChange={event=>{setToken("");setQuery({search:event.target.value,page:1});}}/></label>
 <div className={s.detailTable}><table className={p.table}><thead><tr><th>产品内编</th><th>行情优先 / 元/kg</th><th>库存优先 / 元/kg</th><th>较上期变化</th></tr></thead><tbody>{version.products.map(row=><tr key={row.product_id??row.id}><td><ProductLink name={row.name} onClick={()=>setSelected(row)}/></td><td><Money value={row.latest_cost}/></td><td><Money value={row.inventory_cost}/></td><td><Movement change={row.period_change??{percent:null,reason:"上期比较记录暂不可用"}}/></td></tr>)}</tbody></table>{!version.products.length&&<p className={s.empty}>没有符合条件的产品。</p>}</div>
 <LedgerPagination total={version.total} page={version.page} pageSize={50} onPageChange={page=>{setToken(version.version);setQuery(value=>({...value,page}));}}/>
 </>}</Drawer>;
}
