import {useTrendSelection} from "../components/useTrendSelection";
import {trendEligibleIds} from "../codeOrder";
import {HelpHint} from "../components/HelpHint";
import {FilterSummary} from "../components/FilterSummary";
import {SortHeading} from "../components/SortHeading";
import {useResearchData,useResearchPage} from "./researchData";
import {type Product, type Version, type RecordRow, type Formula, type Calculation, base, request, cost, numberText, yieldValue, yieldText, date, lineCount, errorText, recordDate} from "./researchModel";
import {ProductLink, Money, CostSource, Movement, Status, Menu, Options, OwnerMenu, Drawer, HistoricalFormula} from "./ResearchProductView";
import {ResearchProductDrawer} from "./ResearchProductDrawer";
import {WorkbenchLoading} from "../components/WorkbenchLayout";
import {DecimalInput} from "../components/DecimalInput";
import {LedgerFrame, LedgerToolbar, DashboardPanel} from "../components/WorkbenchLayout";
import {Switch} from "../components/Switch";

import {PriceDateRangeMenu, TrendMaterialMenu} from "../components/WorkbenchMenus";
import {useMoverPaging} from "../components/useMoverPaging";
import {useUnsavedChanges} from "../components/Interaction";
import {LedgerPagination} from "../components/LedgerPagination";
import {RecordFilters} from "../components/RecordFilters";
import {ResearchMaterialPrices} from "./ResearchMaterialPrices";
import {ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Columns3, Download, Plus, Search, SlidersHorizontal, TrendingUp, TrendingDown, X} from "lucide-react";
import {useEffect, useMemo, useRef, useState} from "react";
import {CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from "recharts";
import {fetchJson} from "../api";
import {PriceMovement} from "../components/PriceMovement";
import {focusedTrendAxis, moverDateRange} from "./procurementAnalytics";
import {indexCostHistory, researchDepartment, yieldNeedsReview, rankCostGaps, priceCents, priceChange, type CostGapDirection} from "./researchAnalytics";
import type { ResearchPage } from "../types";
import p from "../components/WorkbenchSurface.module.css";
import s from "./ResearchWorkbench.module.css";

const labels = { name: "产品内编", department: "部门", owner: "负责人", latest_cost: "产品成本（行情优先）", inventory_cost: "产品成本（库存优先）", change: "价格变化", yield: "收率", lines: "投料明细", status: "状态" };
type Column = keyof typeof labels;
const columns = Object.keys(labels) as Column[];
export function ResearchWorkbench({ accessLevel, userId, view, page, onPageChange, onEnter }: { accessLevel: number; userId: string; view: "preview" | "full"; page: ResearchPage; onPageChange: (page: ResearchPage) => void; onEnter: () => void }) {
  const materialPage = view === "full" && page === "materials";
  const pagedPage=view === "full" && (page === "products" || page === "formulas");
  const {products,versions,formulas,pending,loading,notice,load}=useResearchData(!materialPage&&!pagedPage);
  const [revision,setRevision]=useState(0);
  const changed=()=>{setRevision(value=>value+1);void load();};
  const [selected, setSelected] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [trialsOpen, setTrialsOpen] = useState(false);
  const [jumpFilter, setJumpFilter] = useState("");
  const previousView = useRef(view);
  useEffect(() => { if (previousView.current === "full" && view === "preview") { setSelected(null); setVersionId(null); setTrialsOpen(false); } previousView.current = view; }, [view]);
  const openFilter = (filter: string) => { setJumpFilter(filter); onPageChange(filter === "draft" ? "formulas" : "products"); };
  if (materialPage) return <ResearchMaterialPrices userId={userId}/>;
  if (!pagedPage && !products && loading) return <WorkbenchLoading title="正在读取产品成本" />;
  if (!pagedPage && !products) return <article className={`workbench-detail ${s.empty}`}><strong>{loading ? "正在读取产品成本…" : "研发工作台暂时不可用"}</strong>{notice && <p role="alert">{notice}</p>}{!loading && <button className="secondary-button" onClick={() => void load()}>重新加载</button>}</article>;
  return <article className={`workbench-detail ${p.root} ${p.full} ${s.root} ${view === "preview" ? p.summaryPage : ""} ${view === "full" && (page === "products" || page === "formulas") ? s.ledgerPage : ""}`}>
    <header className={p.header}><div><span className={p.eyebrow}>研发工作台 · 已启用</span><h1>产品成本计算</h1><p>分别按行情价格、库存价格优先核算原料成本，计入各层收率。</p></div>{view === "preview" ? <button className="primary-button" onClick={onEnter}>进入工作台<ArrowRight size={15}/></button> : null}</header>
    {!pagedPage && notice && <div role="alert" className={s.notice}>{notice}<button className="secondary-button" onClick={() => void load()}>重试</button></div>}
    {!pagedPage && pending && <div role="status" className={s.notice}>成本正在更新，相关产品暂不标记为最新。完成后自动刷新。</div>}
    {view === "preview" || page === "dashboard" ? <Dashboard userId={userId} products={products??[]} formulas={formulas} versions={versions} onOpen={setSelected} onFilter={openFilter} compact={view === "preview"} detailOpen={!!selected}/> : page === "products" ? <Ledger revision={revision} userId={userId} onOpen={setSelected} initialFilter={jumpFilter}/> : page === "formulas" ? <FormulaCatalog initialFilter={jumpFilter} revision={revision} accessLevel={accessLevel} onOpen={setSelected} onChanged={changed}/> : <History versions={versions} onOpen={setVersionId} onTrials={() => setTrialsOpen(true)}/>}
    {selected && <ResearchProductDrawer key={selected} id={selected} accessLevel={accessLevel} onClose={() => setSelected(null)} onChanged={changed}/>}
    {versionId && <VersionDrawer key={versionId} id={versionId} summary={versions.find(version => version.id === versionId)} onClose={() => setVersionId(null)}/>}
    {trialsOpen && <TrialsDrawer onClose={() => setTrialsOpen(false)}/>}
  </article>;
}

type Period = "14d" | "1m" | "3m" | { start: string; end: string };
function useResearchRange(versions: Version[], initial: "14d" | "1m" | "3m") {
  const [period, setPeriod] = useState<Period>(initial);
  const end = versions.map(recordDate).sort().at(-1) ?? new Date().toISOString().slice(0,10);
  return { period, setPeriod, range: typeof period === "string" ? moverDateRange(end, period) : period };
}
function DepartmentMenu({rows=[],names:provided,value,onChange}: {rows?: Product[];names?:string[];value:string;onChange:(value:string)=>void}) {
 const order:Record<string,number>={研发一部:1,研发二部:2,研发三部:3,研发四部:4,研发五部:5,研发六组:6,浙江实验室:7};
 const names=[...new Set(provided??rows.map(researchDepartment))].sort((a,b)=>(order[a]??99)-(order[b]??99)||a.localeCompare(b,"zh-CN"));
 return <Menu title={value || "全部部门"}><Options options={[{value:"",label:"全部部门"},...names.map(name=>({value:name,label:name}))]} value={value} onChange={onChange} close/></Menu>;
}
function Dashboard({ userId, products, formulas, versions, onOpen, onFilter, compact, detailOpen }: { userId:string; products: Product[]; formulas: Product[]; versions: Version[]; onOpen: (id: string) => void; onFilter: (filter: string) => void; compact: boolean; detailOpen: boolean }) {
  const histories = useMemo(() => indexCostHistory(versions), [versions]);
  const trend = useResearchRange(versions, "3m"), ranking = useResearchRange(versions, "1m");
  const eligible = useMemo(()=>trendEligibleIds([...histories].flatMap(([id,rows])=>rows.map(row=>({id,date:recordDate(row),values:[row.latest_cost,row.inventory_cost]}))),{start:trend.range.start,end:trend.range.end}),[histories,trend.range.start,trend.range.end]);
  const [selected,setSelected] = useTrendSelection(userId,"research",products.map(row=>({id:row.id,code:row.name})),eligible);
  const history = histories.get(selected) ?? [];
  const movements = products.filter(row => row.change?.percent != null && row.change.percent !== 0);
  const missing = products.filter(row => row.status === "missing");
  const warnings = products.filter(yieldNeedsReview);
  const drafts = formulas.filter(row => row.has_draft || row.lifecycle === "draft");
  const points = [...(history ?? [])].filter(row => recordDate(row) >= trend.range.start && recordDate(row) <= trend.range.end).sort((a,b) => recordDate(a).localeCompare(recordDate(b)) || Number(a.record_type !== "backfill")-Number(b.record_type !== "backfill") || a.recorded_at.localeCompare(b.recorded_at)).map(row => { const latest = priceCents(row.latest_cost), inventory = priceCents(row.inventory_cost); return { time: recordDate(row), latest: latest == null ? null : latest / 100, inventory: inventory == null ? null : inventory / 100, rawLatest: row.latest_cost, rawInventory: row.inventory_cost, missing: row.missing_materials ?? [], backfill: row.record_type === "backfill" }; });
  const axis = focusedTrendAxis([{values:points.map(point => point.latest)}, {values:points.map(point => point.inventory)}]);
  const [direction, setDirection] = useState("up");
  const rangeMovements = useMemo(() => products.flatMap(product => {
    const records = histories.get(product.id) ?? [];
    const before = records.filter(row => recordDate(row) <= ranking.range.start).at(-1), after = records.filter(row => recordDate(row) <= ranking.range.end).at(-1);
    if (!before || !after) return [];
    const percent = priceChange(after.latest_cost, before.latest_cost);
    if (percent == null) return [];
    return [{ ...product, latest_cost: after.latest_cost, before: before.latest_cost, change: { percent, reason: `${ranking.range.start} 截至成本 ${cost(before.latest_cost)} → ${ranking.range.end} 截至成本 ${cost(after.latest_cost)} 元/kg` } }];
  }), [products, histories, ranking.range.start, ranking.range.end]);
  const ranked = rangeMovements.filter(row => direction === "up" ? row.change.percent > 0 : row.change.percent < 0).sort((a,b) => (direction === "up" ? b.change.percent-a.change.percent : a.change.percent-b.change.percent) || a.name.localeCompare(b.name,"zh-CN",{numeric:true}));
  const rankingLimit = compact ? 10 : 30;
  const movers = ranked.slice(0,rankingLimit);
  const paging = useMoverPaging(Math.ceil(movers.length / 10), `${direction}-${ranking.range.start}-${ranking.range.end}`, detailOpen);
  const [gapDirection, setGapDirection] = useState<CostGapDirection>("all");
  const costGaps = useMemo(() => rankCostGaps(products, gapDirection), [products, gapDirection]);
  const trendCard = <DashboardPanel className={`${p.dashboardPanel} ${compact ? p.previewTrend : ""}`}><div className={`${p.panelHeading} ${s.heading}`}><div><span>产品成本记录 · 含历史回算</span><h2>产品成本趋势</h2></div><div className={p.chartActions}><PriceDateRangeMenu label="成本趋势日期范围" period={trend.period} range={trend.range} onChange={trend.setPeriod}/><TrendMaterialMenu materials={products.map(row => ({id:row.id,code:row.name}))} selected={products.find(row => row.id === selected)?.name ?? ""} onSelect={name => setSelected(products.find(row => row.name === name)?.id ?? selected)} label="趋势产品" placeholder="搜索产品内编"/></div></div>
        <div className={`${p.lineChart} ${s.trendPlot}`}>{points.length < 2 ? <div className={`${p.chartEmpty} ${s.trendEmpty}`}><strong>{points.length === 1 ? "当前范围仅有一期成本记录" : "当前范围没有成本记录"}</strong><span>可调整日期范围查看其它记录。</span>{points.length === 1 && <span>行情优先 {cost(points[0].rawLatest)} · 库存优先 {cost(points[0].rawInventory)} 元/kg</span>}</div> : <div className={s.chart}><ResponsiveContainer width="100%" height="100%"><LineChart data={points} accessibilityLayer margin={{top:8,right:12,bottom:4,left:0}}><CartesianGrid stroke="#edf0f1" vertical={false}/><XAxis dataKey="time" tick={{fill:"#858d94",fontSize:10}} axisLine={false} tickLine={false} tickFormatter={value => String(value).slice(5).replace("-","/")}/><YAxis domain={axis.domain} ticks={axis.ticks} interval="preserveStartEnd" minTickGap={6} tick={{fill:"#858d94",fontSize:10}} axisLine={false} tickLine={false} width={52} tickFormatter={value => Number(value).toFixed(2)}/><Tooltip filterNull={false} content={({active,payload}) => { const point = payload?.[0]?.payload as typeof points[number] | undefined; return active && point ? <div className={s.chartTooltip}><strong>{point.time}{point.backfill ? " · 历史回算" : ""}</strong><span>行情优先 <Money value={point.rawLatest}/></span><span>库存优先 <Money value={point.rawInventory}/></span>{(point.latest == null || point.inventory == null) && <small>{point.missing.length ? `缺价原料：${point.missing.join("、")}` : "该期未形成完整成本记录"}；缺失口径无法核算，曲线保留断点。</small>}</div> : null; }}/><Line name="行情优先（元/kg）" type="monotone" dataKey="latest" stroke="#2f3337" strokeWidth={2} dot={{r:3,fill:"#fff",strokeWidth:2}} activeDot={{r:4}} connectNulls={false}/><Line name="库存优先（元/kg）" type="monotone" dataKey="inventory" stroke="#708ba4" strokeWidth={2} dot={{r:3,fill:"#fff",strokeWidth:2}} activeDot={{r:4}} connectNulls={false}/>
          <Line dataKey={point => point.latest == null || point.inventory == null ? axis.domain[0] : null} stroke="none" activeDot={false} isAnimationActive={false} dot={({cx,cy,payload}) => payload.latest != null && payload.inventory != null ? <g/> : <g className={s.gapMarker} role="img" aria-label={`${payload.time} 成本缺失`}><circle cx={cx} cy={cy} r={6}/><text x={cx} y={cy} dy=".35em" textAnchor="middle">!</text></g>}/>
        </LineChart></ResponsiveContainer></div>}</div>
        {points.length >= 2 && points.some(point => point.latest == null || point.inventory == null) && <p className={s.gapHint}>! 缺失成本标记 · 悬停查看原因</p>}
      <div className={s.trendLegend} aria-label="成本趋势图例">{[{label:"行情优先",color:"#2f3337"},{label:"库存优先",color:"#708ba4"}].map(item => <span key={item.label}><svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true"><path d="M0 6H24" stroke={item.color} strokeWidth="2"/><circle cx="12" cy="6" r="3" fill="#fff" stroke={item.color} strokeWidth="2"/></svg>{item.label}（元/kg）</span>)}</div>
      </DashboardPanel>;
  const taskCard = <DashboardPanel className={`${p.dashboardPanel} ${s.tasksCard}`}><div className={`${p.panelHeading} ${s.heading}`}><div><span>核算与配方</span><h2>待处理事项</h2></div></div><button className={s.task} onClick={() => onFilter("missing")}><span>缺少核算价格<small>补齐后自动重新核算</small></span><strong>{missing.length}</strong><ChevronRight size={16}/></button><button className={s.task} onClick={() => onFilter("yield")}><span>收率待核对<small>保留原值，核对超过 100% 的收率</small></span><strong>{warnings.length}</strong><ChevronRight size={16}/></button><button className={s.task} onClick={() => onFilter("draft")}><span>待启用草稿<small>由有启用权的人员核对后启用</small></span><strong>{drafts.length}</strong><ChevronRight size={16}/></button>{products.some(row => row.status === "failed") && <p role="alert">有成本更新失败，系统将自动重试。</p>}</DashboardPanel>;
  const rankingCard = <DashboardPanel className={`${p.dashboardPanel} ${p.moversPanel} ${compact ? p.compactMovers : ""}`} aria-label="产品成本涨跌排行" aria-roledescription={compact ? undefined : "轮播"} {...paging.interaction}>
      <div className={`${p.panelHeading} ${s.heading}`}><div><span>区间首尾 · 行情优先成本</span><h2>产品成本涨跌排行</h2></div><div className={p.moverActions}><PriceDateRangeMenu label="成本排行日期范围" period={ranking.period} range={ranking.range} onChange={ranking.setPeriod}/><div className={p.moverSwitch} role="group" aria-label="排行方向"><button aria-pressed={direction === "up"} onClick={() => setDirection("up")}>涨幅</button><button aria-pressed={direction === "down"} onClick={() => setDirection("down")}>降幅</button></div></div></div>
      {movers.length ? <div key={`${direction}-${ranking.range.start}-${ranking.range.end}`} className={p.moverPages} data-instant={paging.instant || paging.reduced} aria-live={paging.rotating ? "off" : "polite"}>{Array.from({length: Math.ceil(movers.length / 10)}, (_, index) => <div key={index} className={p.moverList} data-active={paging.page === index} data-retiring={paging.previousPage === index} aria-hidden={paging.page !== index} inert={paging.page !== index} role="group" aria-label={`第 ${index + 1} 页，共 ${Math.ceil(movers.length / 10)} 页`}>{movers.slice(index * 10, (index + 1) * 10).map(row => { const Icon = row.change.percent > 0 ? TrendingUp : TrendingDown; return <div key={row.id}><Icon size={16}/><span><span className={p.moverLine}><strong><ProductLink name={row.name} onClick={() => onOpen(row.id)}/></strong><span className={p.moverPrices} title={row.change.reason}><span>{cost(row.before)}</span><ArrowRight size={12}/><b>{cost(row.latest_cost)}</b><PriceMovement value={row.change.percent}/></span></span><small className={p.moverVersions}>截至 {ranking.range.end}</small></span></div>; })}</div>)}</div> : <div className={p.chartEmpty}><strong>当前范围没有可比较的{direction === "up" ? "上涨" : "下降"}记录。</strong><span>可调整日期范围查看其它记录。</span></div>}
      <footer className={p.moverCaption}><span>本期{direction === "up" ? "上涨" : "下降"} {ranked.length} 项{ranked.length > movers.length && ` · 显示前 ${movers.length} 项`}</span>{paging.controls}</footer>
    </DashboardPanel>;
  const gapCard = <DashboardPanel className={`${p.dashboardPanel} ${p.moversPanel} ${s.gapCard}`} aria-label="双成本差异排行">
        <div className={`${p.panelHeading} ${s.heading}`}><div><span>行情优先与库存优先的成本差额</span><h2>双成本差异排行</h2></div>
        <div className={`${p.moverSwitch} ${s.gapSwitch}`} aria-label="差异方向">{([{value:"all",label:"全部"},{value:"latest",label:"行情优先"},{value:"inventory",label:"库存优先"}] as const).map(option => <button key={option.value} aria-pressed={gapDirection === option.value} onClick={() => setGapDirection(option.value)}>{option.label}</button>)}</div></div>
        {costGaps.length ? <div className={s.gapRows}>{costGaps.slice(0,5).map(row => <button key={row.id} onClick={() => onOpen(row.id)}><span className={s.gapHeading}><strong>{row.name}</strong><strong className={s.gapAmount} title={`行情优先 ${cost(row.latest_cost)} − 库存优先 ${cost(row.inventory_cost)} = ${row.gap.toFixed(2)} 元/kg`}>{row.gap > 0 ? "+" : "−"}¥{Math.abs(row.gap).toLocaleString("zh-CN", {minimumFractionDigits:2,maximumFractionDigits:2})}<small>/kg</small></strong></span><span className={s.gapCosts}><span>行情优先 <Money value={row.latest_cost}/></span><span>库存优先 <Money value={row.inventory_cost}/></span></span></button>)}</div> : <div className={s.chartEmpty}><strong>{gapDirection === "all" ? "当前没有双成本差异" : `暂无${gapDirection === "latest" ? "行情" : "库存"}优先成本较高的产品`}</strong><span>仅比较两种成本均已完成核算的产品。</span></div>}
        <p className={p.moverCaption}>符合条件 {costGaps.length} 项 · 显示前 5 项</p>
      </DashboardPanel>;
  return <>
    <div className={`${p.metrics} workbench-metrics`}><div><small>在用产品</small><strong>{products.length}</strong><span>各部门在用产品内编</span></div><div><small>本期成本变动</small><strong>{movements.filter(row => row.change.percent! > 0).length} 涨 / {movements.filter(row => row.change.percent! < 0).length} 降</strong><span>与最近一次不同价格比较</span></div><div><small>待处理事项</small><strong>{new Set([...missing,...warnings,...drafts].map(row => row.id)).size}</strong><span>缺价、收率核对及草稿</span></div><div><small>最近核算</small><strong>{versions.filter(row => row.record_type !== "backfill").length} 期</strong><span>{date(versions.find(row => row.record_type !== "backfill")?.recorded_at)}</span></div></div>
    {compact ? <>{trendCard}{rankingCard}</> : <div className={`${p.dashboardGrid} ${s.dashboardGrid}`}>{trendCard}{taskCard}<div className={`${p.dashboardGrid} ${s.comparisonGrid}`}>{rankingCard}{gapCard}</div></div>}
  </>;
}

function Ledger({ revision, userId, onOpen, initialFilter }: { revision: number; userId: string; onOpen: (id: string) => void; initialFilter: string }) {
  const preferenceKey = `research-ledger:${userId}`;
  const [preferences, setPreferences] = useState<{ columns: Column[]; pageSize: number; sort: Column; asc: boolean; view: "scroll" | "paged" }>(() => {
    try { const saved = JSON.parse(localStorage.getItem(preferenceKey) || "null"); if (saved) return { columns: columns.filter(key => key === "name" || saved.columns?.includes(key)), pageSize: Number.isInteger(saved.pageSize) && saved.pageSize >= 10 && saved.pageSize <= 200 ? saved.pageSize : 50, sort: "change", asc: false, view: saved.view === "scroll" ? "scroll" : "paged" }; } catch { /* Invalid personal preferences fall back to the confirmed ledger defaults. */ }
    return { columns, pageSize:50, sort:"change", asc:false, view:"paged" };
  });
  const [search, setSearch] = useState(""); const [owner, setOwner] = useState(""); const [department, setDepartment] = useState(""); const [movement, setMovement] = useState(""); const [status, setStatus] = useState(""); const [draft, setDraft] = useState(""); const [yieldWarning, setYieldWarning] = useState(false); const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false); const [exportError, setExportError] = useState("");
  const exportController=useRef<AbortController|null>(null);
  useEffect(()=>()=>{exportController.current?.abort();},[]);
  const exportCosts = async () => {
    if(exportController.current&&!exportController.current.signal.aborted)return;
    const controller=new AbortController();exportController.current=controller;
    setExporting(true); setExportError("");
    try {
      const response = await fetch(`${base}/products/export`,{signal:controller.signal});
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(payload?.detail || `导出失败（${response.status}）`);
      }
      const blob=await response.blob();if(controller.signal.aborted)return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `产品成本-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (error) {if(!controller.signal.aborted)setExportError(errorText(error)); }
    finally {if(exportController.current===controller)exportController.current=null;if(!controller.signal.aborted)setExporting(false); }
  };
  useEffect(() => { setStatus(initialFilter === "missing" ? "missing" : ""); setDraft(initialFilter === "draft" ? "yes" : ""); setYieldWarning(initialFilter === "yield"); }, [initialFilter]);
  useEffect(() => { try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* table remains usable when browser storage is unavailable */ } }, [preferenceKey, preferences]);
  const filterKey=JSON.stringify([search,owner,department,movement,status,draft,yieldWarning,preferences.pageSize,preferences.sort,preferences.asc]);
  const [previousFilterKey,setPreviousFilterKey]=useState(filterKey);
  if(previousFilterKey!==filterKey){setPreviousFilterKey(filterKey);setPage(1);}
  const {data,notice:pageError,loading:pageLoading,reload}=useResearchPage("products",new URLSearchParams({page:String(page),page_size:String(preferences.pageSize),search,owner,department,movement,status,draft,yield_warning:String(yieldWarning),sort:preferences.sort,asc:String(preferences.asc)}),revision);
  const filtered=data?.items??[];const total=data?.total??0;const current=data?.page??page;
  const activeFilters = Boolean(owner || department || movement || status || draft || yieldWarning || search);
  const filterCount = Number(Boolean(movement)) + Number(Boolean(status)) + Number(Boolean(draft)) + Number(yieldWarning);
  const filterFields = [
    {label:"价格变化",value:movement,setValue:setMovement,options:[{value:"",label:"全部"},{value:"up",label:"上涨"},{value:"down",label:"下降"},{value:"flat",label:"持平"},{value:"none",label:"暂无对比"}]},
    {label:"核算状态",value:status,setValue:setStatus,options:[{value:"",label:"全部"},{value:"ready",label:"可核算"},{value:"missing",label:"成本待完善"},{value:"updating",label:"更新中"},{value:"failed",label:"更新失败"}]},
    {label:"配方草稿",value:draft,setValue:setDraft,options:[{value:"",label:"全部"},{value:"yes",label:"有草稿"},{value:"no",label:"无草稿"}]},
  ];
  return <section className={s.ledgerSection}><div className={s.sectionHeading}><div className={s.costHeadingText}><h2>产品成本</h2><span>{total} / {data?.scope_total??0} 项 · 元/kg · 含历史回算</span></div><button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportCosts()}><Download size={14}/>{exporting ? "正在导出…" : "导出成本"}</button></div>{pageError && <p role="alert" className={s.notice}><span>{pageError}</span><button className="secondary-button" onClick={reload}>重试</button></p>}{data?.pending && <p role="status">成本正在更新，相关产品暂不标记为最新。</p>}{exportError && <p className={s.notice} role="alert">{exportError}</p>}<LedgerFrame className={s.frame}><LedgerToolbar className={s.toolbar}>
    <label className={p.searchField}><Search size={15}/><input aria-label="搜索产品内编" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索产品内编"/></label>
    <OwnerMenu owners={data?.owners??[]} value={owner} onChange={setOwner}/><DepartmentMenu names={data?.department_names??[]} value={department} onChange={setDepartment}/>
    <Menu title="筛选" icon={<SlidersHorizontal size={14}/>} className={`${p.filterMenu} ${s.filterMenu}`} chevron={false} count={filterCount}>
      {filterFields.map(field => <div key={field.label} className={s.filterField}><span>{field.label}</span><Menu title={field.options.find(option => option.value === field.value)?.label ?? "全部"} className={p.personMenu}><Options options={field.options} value={field.value} onChange={field.setValue} close/></Menu></div>)}
      <label><input type="checkbox" checked={yieldWarning} onChange={event => setYieldWarning(event.target.checked)}/>收率待核对</label><button className="secondary-button" type="button" onClick={() => { setMovement(""); setStatus(""); setDraft(""); setYieldWarning(false); }}>重置筛选</button>
    </Menu>
    <Menu title="显示" icon={<Columns3 size={14}/>} className={p.displayMenu} chevron={false}><span className={p.menuLabel}>显示字段</span><div className={p.columnGrid}>{columns.map(key => <label key={key}><input type="checkbox" disabled={key === "name"} checked={preferences.columns.includes(key)} onChange={event => setPreferences({...preferences, columns:columns.filter(item => item === key ? event.target.checked : preferences.columns.includes(item))})}/>{key === "latest_cost" ? "行情优先成本" : key === "inventory_cost" ? "库存优先成本" : labels[key]}</label>)}</div><span className={p.menuLabel}>每页条数</span><div className={p.pageSizeControl}>{[20,50,100].map(n => <button key={n} aria-pressed={preferences.pageSize === n} onClick={() => setPreferences({...preferences,pageSize:n})}>{n}</button>)}<DecimalInput key={preferences.pageSize} aria-label="自定义每页条目数" type="number" min="10" max="200" defaultValue={preferences.pageSize} onBlur={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 10 && value <= 200) setPreferences({...preferences,pageSize:value}); else event.target.value = String(preferences.pageSize); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}/></div></Menu>
  </LedgerToolbar>{activeFilters && <div className={s.filterBar}><span>已筛选 {total} 项{search && ` · 搜索：${search}`}{owner && ` · 负责人：${owner}`}{department && ` · 部门：${department}`}{filterFields.filter(field => field.value).map(field => <button key={field.label} type="button" onClick={() => field.setValue("")} aria-label={`清除${field.label}筛选`}>{field.label}：{field.options.find(option => option.value === field.value)?.label}<X size={12}/></button>)}{yieldWarning ? " · 收率待核对" : ""}</span><button onClick={() => { setSearch(""); setOwner(""); setDepartment(""); setMovement(""); setStatus(""); setDraft(""); setYieldWarning(false); }}>清除筛选</button></div>}
    <div className={`${p.ledgerTableWrap} ${s.tableScroll}`}><table className={`${p.table} ${p.decisionTable} ${s.table}`}><colgroup>{preferences.columns.map(key => <col key={key} style={{width:({name:168,department:110,owner:92,latest_cost:182,inventory_cost:182,change:126,yield:90,lines:94,status:114})[key]}}/>)}</colgroup><thead><tr>{preferences.columns.map(key => <th key={key} aria-sort={preferences.sort === key ? preferences.asc ? "ascending" : "descending" : undefined}>{["name","department","owner","status"].includes(key) ? labels[key] : <SortHeading label={labels[key]} direction={preferences.sort === key ? preferences.asc ? "ascending" : "descending" : undefined} onClick={() => setPreferences({ ...preferences, sort: key, asc: preferences.sort === key ? !preferences.asc : true })}/>}{key === "change" && <HelpHint detail="行情优先成本与最近一次不同价格比较，金额先四舍五入到两位；相同价格延续上次变化。首次、缺价或零基数暂无对比。"/>}</th>)}</tr></thead><tbody>{filtered.map(row => <tr key={row.id}>{preferences.columns.map(key => <td key={key}>{key === "name" ? <ProductLink name={row.name} onClick={() => onOpen(row.id)}/> : key === "latest_cost" || key === "inventory_cost" ? <><Money value={row[key]}/><CostSource result={row.cost_details?.[key === "latest_cost" ? "latest" : "inventory"]}/></> : key === "change" ? <Movement change={row.change} comparisonBasis={row.comparison_basis}/> : key === "yield" ? <span title={`${yieldValue(row.yield)}%${yieldNeedsReview(row) ? " · 原表收率超过100%，请核对" : ""}`}>{yieldText(row.yield)}{yieldNeedsReview(row) ? " · 待核对" : ""}</span> : key === "lines" ? `${lineCount(row)} 条` : key === "status" ? <Status row={row}/> : key === "department" ? <span title={!row.department ? "原部门未记录，沿用研发五部数据范围。" : undefined}>{researchDepartment(row)}</span> : row.owner}</td>)}</tr>)}{!filtered.length && <tr><td colSpan={preferences.columns.length}><div className={s.empty}>{pageLoading ? "正在读取产品…" : pageError ? "读取失败，请重试。" : "没有符合条件的产品。"}</div></td></tr>}</tbody></table></div>
    <LedgerPagination total={total} page={current} pageSize={preferences.pageSize} onPageChange={setPage}/>
  </LedgerFrame></section>;
}

function FormulaCatalog({ revision, accessLevel, onOpen, onChanged, initialFilter = "" }: { revision:number; accessLevel: number; onOpen: (id: string) => void; onChanged: () => void; initialFilter?: string }) {
  const [search,setSearch] = useState(""), [owner,setOwner] = useState(""), [department,setDepartment] = useState(""), [status,setStatus] = useState(initialFilter === "draft" ? "draft" : "");
  const [creating,setCreating] = useState(false), [name,setName] = useState(""), [newOwner,setNewOwner] = useState(""), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const [newDepartment,setNewDepartment]=useState("");

  const mounted=useRef(false),working=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const unsaved=useUnsavedChanges(creating&&Boolean(name||newOwner),busy,"本次尚未创建的配方填写将被放弃。","research-before-leave");
  useEffect(() => { setStatus(initialFilter === "draft" ? "draft" : ""); },[initialFilter]);
  const [page, setPage] = useState(1);
  const filterKey=JSON.stringify([search,owner,department,status]);
  const [previousFilterKey,setPreviousFilterKey]=useState(filterKey);
  if(previousFilterKey!==filterKey){setPreviousFilterKey(filterKey);setPage(1);}
  const {data,notice:pageError,loading:pageLoading,reload}=useResearchPage("formulas",new URLSearchParams({page:String(page),page_size:"50",search,owner,department,status}),revision);
  const filtered=data?.items??[],owners=data?.creation_owners??[],departments=data?.departments??[];
  const currentPage=data?.page??page;
  const selectedDepartment=departments.find(row=>row.id===newDepartment)?.id??departments[0]?.id;
  const lifecycle = (row: Product) => row.lifecycle === "inactive" ? "已停用" : row.lifecycle === "draft" ? "待启用" : row.has_draft ? "在用 · 有草稿" : "在用";
  const create = async () => {if(working.current||!mounted.current||!name.trim())return;working.current=true; setBusy(true); setError(""); try { const result = await request<{id:string}>(`${base}/formulas`,"POST",{name:name.trim(),owner:newOwner,department_id:selectedDepartment});if(!mounted.current)return; setCreating(false); setName(""); onChanged(); onOpen(result.id); } catch(error) {if(mounted.current)setError(errorText(error)); } finally {working.current=false;if(mounted.current)setBusy(false); } };
  return <section className={s.ledgerSection}><div className={s.sectionHeading}><div><h2>配方管理</h2><p className={s.explanation}>维护产品内编与配方，试算后保存草稿，由有启用权的人员启用。</p></div>{accessLevel >= 3 && <button className="primary-button" onClick={() => {setCreating(true);setError("");}}><Plus size={15}/>新增配方</button>}</div>{pageError && <p role="alert" className={s.notice}><span>{pageError}</span><button className="secondary-button" onClick={reload}>重试</button></p>}<LedgerFrame className={s.frame}><LedgerToolbar className={s.toolbar}><label className={p.searchField}><Search size={15}/><input aria-label="搜索配方内编" placeholder="搜索产品内编" value={search} onChange={event => setSearch(event.target.value)}/></label><OwnerMenu owners={owners} value={owner} onChange={setOwner}/><DepartmentMenu names={data?.department_names??[]} value={department} onChange={setDepartment}/><Menu title={({active:"在用",draft:"待启用 / 有草稿",inactive:"已停用"} as Record<string,string>)[status] || "全部状态"} className={p.personMenu}><Options options={[{value:"",label:"全部状态"},{value:"active",label:"在用"},{value:"draft",label:"待启用 / 有草稿"},{value:"inactive",label:"已停用"}]} value={status} onChange={setStatus} close/></Menu></LedgerToolbar><FilterSummary count={data?.total??0} items={[search && `搜索：${search}`,owner && `负责人：${owner}`,department && `部门：${department}`,status && `状态：${({active:"在用",draft:"待启用 / 有草稿",inactive:"已停用"} as Record<string,string>)[status]}`]} onClear={()=>{setSearch("");setOwner("");setDepartment("");setStatus("");setPage(1);}}/><div className={`${p.ledgerTableWrap} ${s.tableScroll}`}><table className={`${p.table} ${p.decisionTable} ${s.formulaTable}`}><thead><tr><th>产品内编</th><th>负责人</th><th>部门</th><th>收率</th><th>投料明细</th><th>配方版本</th><th>状态</th></tr></thead><tbody>{filtered.map(row => <tr key={row.id}><td><ProductLink name={row.name} onClick={() => onOpen(row.id)}/></td><td>{row.owner}</td><td>{<span title={!row.department ? "原部门未记录，沿用研发五部数据范围。" : undefined}>{researchDepartment(row)}</span>}</td><td title={`${yieldValue(row.yield)}%`}>{yieldText(row.yield)}</td><td>{lineCount(row)} 条</td><td>{row.revision ? `v${row.revision}` : "尚未启用"}</td><td><span className={`${s.status} ${row.lifecycle !== "active" ? s.attention : ""}`}>{lifecycle(row)}</span></td></tr>)}{!filtered.length && <tr><td colSpan={7}><div className={s.empty}>{pageLoading ? "正在读取配方…" : pageError ? "读取失败，请重试。" : "没有符合条件的配方。"}</div></td></tr>}</tbody></table></div><LedgerPagination total={data?.total??0} page={currentPage} pageSize={50} onPageChange={setPage}/></LedgerFrame>
    {creating && <Drawer busy={busy} title="新增配方" label="先创建内编，再补充投料和收率" onClose={() => setCreating(false)} beforeClose={unsaved.request}>{unsaved.confirmation}<form className={s.createForm} onSubmit={event => {event.preventDefault();void create();}}><fieldset disabled={busy} inert={busy}><label>产品内编<input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="填写完整产品内编"/></label><div className={s.ownerField} role="group" aria-label="负责人"><span>负责人</span><OwnerMenu emptyLabel="请选择负责人" owners={owners} value={newOwner} onChange={setNewOwner}/></div>{departments.length>0 && <div className={s.ownerField} role="group" aria-label="所属部门"><span>所属部门</span>{departments.length===1 ? <span>{departments[0].name}</span> : <Menu title={departments.find(row=>row.id===selectedDepartment)?.name||"请选择部门"}><Options options={departments.map(row=>({value:row.id,label:row.name}))} value={selectedDepartment||""} onChange={setNewDepartment} close/></Menu>}</div>}<p className={s.explanation}>新配方只保存为草稿，试算并启用后才进入产品成本台账。</p>{error && <p role="alert" className={s.notice}>{error}</p>}<button className="primary-button" disabled={busy || !name.trim() || !newOwner}>创建草稿并编辑</button></fieldset></form></Drawer>}
  </section>;
}

const versionLabel = (version: Version) => version.record_type === "backfill" ? `采购 v${version.purchase_version ?? "—"} · 历史回算` : `成本 v${version.cost_version ?? "—"} · 正式记录`;

function History({ versions, onOpen, onTrials }: { versions: Version[]; onOpen: (id: string) => void; onTrials: () => void }) {
  const [recordFilter, setRecordFilter] = useState("all");
  const visibleVersions = versions.filter(row => recordFilter === "all" || (row.record_type === "backfill" ? recordFilter === "backfill" : recordFilter === "formal"));
  const backfill = versions.filter(row => row.record_type === "backfill").length;
  return <section className={s.historySection}><div className={s.sectionHeading}><div><h2>价格历史</h2><p className={s.explanation}>查看各期产品成本与取价依据，涨跌按行情优先成本与上一期比较。</p></div><button className="secondary-button" onClick={onTrials}>历史试算</button></div><RecordFilters label="成本记录分类" value={recordFilter} onChange={setRecordFilter} options={[{value:"all",label:"全部记录",count:versions.length},{value:"formal",label:"正式记录",count:versions.length-backfill},{value:"backfill",label:"历史回算",count:backfill}]}/><ol className={`${p.historyTimeline} ${s.researchTimeline}`}>{visibleVersions.map(version => {
    const up = version.products.filter(row => row.period_change?.direction === "up").length, down = version.products.filter(row => row.period_change?.direction === "down").length, stable = version.products.filter(row => row.period_change?.direction === "stable").length;
    const missing = version.products.length-up-down-stable;
    return <li key={version.id}><i/><button onClick={() => onOpen(version.id)}><span className={p.historyDate}><strong>{recordDate(version)}</strong>{version.id === versions[0]?.id && <em>最新记录</em>}</span><span className={p.historySource}><strong>{versionLabel(version)}</strong><small title={version.reason}>{version.reason}</small></span><span className={p.historyBatchStats}><span>{version.products.length} 项</span>{stable === version.products.length ? <span className={p.historyStable}>较上期无变化</span> : <>{up > 0 && <span className={p.historyUp}>↑ {up}</span>}{down > 0 && <span className={p.historyDown}>↓ {down}</span>}{stable > 0 && <span className={p.historyStable}>持平 {stable}</span>}{missing > 0 && <span>暂无对比 {missing}</span>}</>}</span><ChevronRight size={16}/></button></li>;
  })}</ol>{!visibleVersions.length && <div className={s.empty}>{versions.length ? "该分类暂无成本记录。" : "正在建立第一期成本基线。"}</div>}</section>;
}

function VersionDrawer({ id, summary, onClose }: { id: string; summary?: Version; onClose: () => void }) {
  const [version, setVersion] = useState<Version | null>(null); const [error, setError] = useState(""); const [record, setRecord] = useState<RecordRow | null>(null); const [attempt,setAttempt]=useState(0);
  useEffect(() => { const controller = new AbortController(); fetchJson<Version>(`${base}/history/${encodeURIComponent(id)}?summary=true`, { signal: AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]) }).then(data=>{if(!controller.signal.aborted)setVersion(data);}).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }); return () => controller.abort(); }, [id,attempt]);
  const recordId=record?.product_id ?? record?.id;
  const recordLoaded=Boolean(record?.formula);
  useEffect(()=>{
    if(!recordId||recordLoaded)return;
    const controller=new AbortController();
    fetchJson<Version>(`${base}/history/${encodeURIComponent(id)}?product_id=${encodeURIComponent(recordId)}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])}).then(data=>{if(!controller.signal.aborted)setRecord(data.products[0]);}).catch(error=>{if(!controller.signal.aborted)setError(errorText(error));});
    return()=>controller.abort();
  },[id,recordId,recordLoaded,attempt]);
  return <Drawer wide title={record?.name ?? (summary ? versionLabel(summary) : "成本记录")} label={version ? recordDate(version) : "价格历史"} onClose={onClose}>{error ? <div role="alert">{error}<button className="secondary-button" onClick={()=>{setError("");setAttempt(value=>value+1);}}>重试</button></div> : !version ? <WorkbenchLoading local title="正在读取研发成本历史"/> : record ? <><button className={s.back} onClick={() => setRecord(null)}><ArrowLeft size={14}/>返回版本明细</button>{!record.formula ? <WorkbenchLoading local title="正在读取研发冻结明细"/> : <HistoricalFormula key={`${record.event_id}-${record.recorded_at}`} record={record}/>}</> : <><div className={s.historySummary}><span>成本日期 <strong>{recordDate(version)}</strong></span><span>产品 <strong>{version.products.length} 项</strong></span><span>{version.record_type === "backfill" ? "历史回算" : "正式记录"}</span></div><p className={s.explanation}>{version.reason}</p><p className={s.explanation}>记录时间：{date(version.recorded_at)}{version.record_type === "backfill" ? "。按当期采购价格回算；当期缺价时使用的当前补位价在投料依据中标明。" : ""}</p><div className={s.detailTable}><table className={p.table}><thead><tr><th>产品内编</th><th>行情优先 / 元/kg</th><th>库存优先 / 元/kg</th><th>较上期变化</th></tr></thead><tbody>{version.products.map((row,index) => <tr key={`${row.id}-${index}`}><td><ProductLink name={row.name} onClick={() => setRecord(row)}/></td><td><Money value={row.latest_cost}/></td><td><Money value={row.inventory_cost}/></td><td><Movement change={summary?.products.find(item => item.id === row.id)?.period_change ?? {percent:null,reason:"上期比较记录暂不可用"}}/></td></tr>)}</tbody></table></div></>}</Drawer>;
}
function TrialsDrawer({ onClose }: { onClose: () => void }) {
  const [recipes, setRecipes] = useState<(Formula & { latest: Calculation })[] | null>(null); const [selected, setSelected] = useState<number | null>(null); const [error, setError] = useState(""); const [attempt,setAttempt]=useState(0);
  useEffect(() => { const controller = new AbortController(); fetchJson<{ recipes: (Formula & { latest: Calculation })[] }>(`${base}/trials`, { signal: AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]) }).then(data => {if(!controller.signal.aborted)setRecipes(data.recipes);}).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }); return () => controller.abort(); }, [attempt]);
  const recipe = selected == null ? null : recipes?.[selected];
  return <Drawer wide title="历史试算" label="原表留存 · 不参与当前核算" onClose={onClose}><p className={s.explanation}>以下三组旧试算按原表保留，仅供追溯；当前使用已确认的 CF401B 复配方案。</p>{error && <div role="alert">{error}<button className="secondary-button" onClick={()=>{setError("");setAttempt(value=>value+1);}}>重试</button></div>}{!recipes ? error ? null : <WorkbenchLoading local title="正在读取研发历史试算"/> : recipe ? <><button className={s.back} onClick={() => setSelected(null)}><ArrowLeft size={15}/>返回试算列表</button><h3>{recipe.name}</h3><p>原表试算成本：<Money value={recipe.latest.cost}/> 元/kg · 收率 <span title={`${yieldValue(recipe.yield)}%`}>{yieldText(recipe.yield)}</span></p><div className={s.detailTable}><table className={p.table}><thead><tr><th>顺序</th><th>投料</th><th>数量 / kg</th><th>原表单价</th></tr></thead><tbody>{recipe.latest.lines.map((line,index) => <tr key={index}><td>{index+1}</td><td>{line.code}</td><td title={`${line.quantity} kg`}>{numberText(line.quantity)}</td><td><Money value={line.unit_cost}/></td></tr>)}</tbody></table></div><p className={s.explanation}>{recipe.sheet} · 原表第 {recipe.source_row} 行</p></> : recipes.map((item,index) => <button key={item.id} className={s.historyRow} onClick={() => setSelected(index)}><span>{item.name}<small>{item.sheet} · 第 {item.source_row} 行</small></span><ChevronRight size={15}/></button>)}</Drawer>;
}
