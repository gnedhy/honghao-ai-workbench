import { ProcurementMaterials } from "./ProcurementMaterials";
import { useUnsavedChanges } from "../components/Interaction";
import { ProcurementMaterialDrawer } from "./ProcurementMaterialDrawer";
import { ReadOnlyMaterialDrawer, ChartEmpty, ChangePrices, price, formatDate, formatShanghaiDateTime, formatPriceDate, shortDate, focusWithoutScroll, recordDialogKeys, updateEventLabel} from "./ProcurementMaterialView";
import { ReasonSelect } from "./procurementPriceEditing";
import { DashboardPanel, WorkbenchLoading } from "../components/WorkbenchLayout";
import { DecimalInput } from "../components/DecimalInput";
import { PriceMovement as Movement } from "../components/PriceMovement";
import { Drawer } from "../components/Drawer";
import { TrendMaterialMenu, PriceDateRangeMenu } from "../components/WorkbenchMenus";
import { useMoverPaging } from "../components/useMoverPaging";
import { RecordFilters } from "../components/RecordFilters";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, CalendarDays, Check, ChevronRight, Clock3, FileUp, PackageCheck, RefreshCw, TrendingDown, TrendingUp, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { createProcurementMaterial, cancelProcurementSchedule, confirmProcurementImport, fetchProcurementBatch, fetchProcurementMaterial, fetchProcurementOverview, previewProcurementImport, publishProcurementUpdate} from "../api";
import type { ProcurementBatchDetail, ProcurementImportPreview, ProcurementMaterialDetail, ProcurementOverview, ProcurementPage, ProcurementUpdate} from "../types";
import { buildPriceMovement, buildRangeDistribution, buildPublishedPriceMovement, buildVersionMovers, focusedTrendAxis, moverDateRange, sortBatchPrices } from "./procurementAnalytics";
import { defaultProcurementPage } from "./procurementWorkflow";
import { summarizeUpdate } from "./procurementLedger";
import { PRICE_REASONS, resolveReason, type ReasonSelection } from "./procurementReasons";
import styles from "../components/WorkbenchSurface.module.css";
import { previewProcurementExcel, type ExcelPreview } from "../api";
import { ProcurementDistribution, type DepartmentLedger } from "./ProcurementDistribution";
import { ProcurementNews, type NewsData } from "./ProcurementNews";

type MoverHistoryCache = { key: string; history: ProcurementBatchDetail[] } | null;

export function ProcurementWorkbench({ accessLevel, view, page, onPageChange, onEnter }: { accessLevel: number; view: "preview" | "full"; page: ProcurementPage; onPageChange: (page: ProcurementPage) => void; onEnter: () => void }) {
  const moverHistory = useRef<MoverHistoryCache>(null);
  const [data, setData] = useState<ProcurementOverview | null>(null);
  const reads = useRef(0);
  const acceptOverview = useCallback((overview: ProcurementOverview) => { reads.current++; setData(overview); }, []);
  const newsCache = useRef<NewsData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [importOpen, setImportOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const publishTrigger = useRef<HTMLElement | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState("");
  const [locateCode, setLocateCode] = useState("");
  const [distributionMaterial, setDistributionMaterial] = useState<string | null>(null);
  const [distributionRevision, setDistributionRevision] = useState(0);
  const distributionTrigger = useRef<HTMLElement | null>(null);
  const closeDistributionMaterial = () => { setDistributionMaterial(null); requestAnimationFrame(() => distributionTrigger.current?.focus({ preventScroll: true })); };
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [editFromDashboard, setEditFromDashboard] = useState(false);
  const previousView = useRef(view);
  useEffect(() => { if (previousView.current === "full" && view === "preview") { setImportOpen(false); setPublishOpen(false); setCatalogOpen(false); setDistributionMaterial(null); setEditFromDashboard(false); } previousView.current = view; }, [view]);

  const load = useCallback((signal?: AbortSignal) => {
    const sequence = ++reads.current;
    setState(current => current === "ready" ? "ready" : "loading");
    return fetchProcurementOverview(signal)
      .then((overview) => { if (!signal?.aborted && sequence === reads.current) { setData(overview); setState("ready"); } })
      .catch((error: unknown) => {
        if (!signal?.aborted && sequence === reads.current && !(error instanceof DOMException && error.name === "AbortError")) {
          setState(current => current === "ready" ? "ready" : "error");
          setNotice("采购数据刷新失败，请重试。");
        }
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, page]);
  useEffect(() => { if (page !== "materials") setLocateCode(""); }, [page]);

  if (state === "loading") return <WorkbenchLoading title="正在读取采购数据" />;
  if (state === "error" || !data) return <ModuleState title="采购工作台暂时不可用" retry={() => void load()} />;

  const renderLedger = (ledgerData: ProcurementOverview, department?: DepartmentLedger) => <ProcurementMaterials startInEdit={editFromDashboard} onEditStarted={() => setEditFromDashboard(false)} locateCode={locateCode} data={ledgerData} accessLevel={accessLevel} onRefresh={() => load()} onSaved={acceptOverview} onCreate={() => setCatalogOpen(true)} onImport={() => setImportOpen(true)} onPublish={() => {publishTrigger.current = document.activeElement as HTMLElement; setPublishOpen(true);}} onPageChange={onPageChange} focusPending={page === "updates"} department={department} onOpenDepartmentMaterial={id => { distributionTrigger.current = document.activeElement as HTMLElement; setDistributionMaterial(id); }} />;

  if (view === "preview") return <ProcurementPreview data={data} moverHistory={moverHistory} onEnter={() => { onPageChange(defaultProcurementPage(data.current_update)); onEnter(); }} />;

  return (
    <article className={`workbench-detail ${styles.root} ${styles.full}${page === "materials" || page === "updates" || page === "distribution" ? ` ${styles.ledgerPage}` : ""}`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>采购部 · 已启用</span>
          <h1>原料价格管理</h1>
          <p>归集采购价格，确认异常波动后启用可追溯的原料成本基线。</p>
        </div>
      </header>
      {catalogOpen && <CreateMaterialDialog data={data} onClose={() => setCatalogOpen(false)} onCreated={(code, hasPrice) => { setCatalogOpen(false); setLocateCode(code); setNotice(hasPrice ? "原料已新增，价格已保存为待发布价；启用后生效。" : "原料已新增，尚未定价。"); void load(); }} />}

      {notice && <div className={styles.notice}><Check size={14} />{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}

      {page === "dashboard" && <Dashboard data={data} moverHistory={moverHistory} newsCache={newsCache} onOpenUpdate={() => { setEditFromDashboard(true); onPageChange("materials"); }} />}
      {(page === "materials" || page === "updates") && renderLedger(data)}
      {page === "distribution" && <ProcurementDistribution revision={distributionRevision} renderLedger={renderLedger} />}
      {page === "distribution" && distributionMaterial && <ProcurementMaterialDrawer batches={data.batches} materialId={distributionMaterial} canEdit={accessLevel >= 3} canManage={Boolean(data.capabilities?.can_manage_catalog)} currentPriceDate={data.current_update?.price_date} onClose={closeDistributionMaterial} onChanged={() => { closeDistributionMaterial(); setDistributionRevision(value => value + 1); void load(); }} />}
      {(page === "history" || page === "batches") && <Batches data={data} accessLevel={accessLevel} onRefresh={() => void load()} onNotice={setNotice} onOpenUpdate={() => onPageChange("updates")} />}
      {importOpen && <ImportPanel current={data.current_update} onClose={() => setImportOpen(false)} onImported={(overview) => { acceptOverview(overview); setImportOpen(false); onPageChange("materials"); setNotice("价格数据已加入本轮更新，请在台账内处理并启用。"); }} />}
      {publishOpen && data.current_update && <PublishConfirm update={data.current_update} publishing={publishing} onClose={() => {setPublishOpen(false); requestAnimationFrame(() => publishTrigger.current?.focus({preventScroll:true}));}} onConfirm={async (mode, activateAt) => {
        setPublishing(true);
        const published = await publish(data.current_update!, data.batches[0]?.id ?? null, mode, activateAt, acceptOverview, setNotice);
        setPublishing(false);
        setPublishOpen(false);
        if (!published) await load();
      }} />}
    </article>
  );
}

function ModuleState({ title, retry }: { title: string; retry?: () => void }) {
  return <article className="workbench-detail workspace-detail-empty"><RefreshCw size={22} /><strong>{title}</strong>{retry && <button className="secondary-button" type="button" onClick={retry}>重新加载</button>}</article>;
}

function ProcurementMetrics({ data, movement }: { data: ProcurementOverview; movement: ReturnType<typeof buildPublishedPriceMovement> }) {
  const latestBatch = data.batches[0];
  const metrics = [
    ["跟踪原料", data.metrics.material_count, "当前台账"],
    ["最新价格变动", movement.comparable ? `${movement.counts.rising} 涨 / ${movement.counts.falling} 降` : "暂无对比", movement.comparable ? "较上一版本" : "暂无可比较价格"],
    ["待处理异常", data.metrics.open_issue_count, data.metrics.open_issue_count ? "需要进入工作台处理" : "当前无异常"],
    ["最新价格版本", latestBatch ? `v${latestBatch.version}` : "—", latestBatch ? (latestBatch.price_date ?? "—") : "尚未形成价格基线"],
  ] as const;
  return <div className={`${styles.metrics} workbench-metrics`}>{metrics.map(([label, value, note]) => <div key={label}><small>{label}</small><strong>{value}</strong><span>{note}</span></div>)}</div>;
}

function ProcurementPreview({ data, moverHistory, onEnter }: { data: ProcurementOverview; moverHistory: React.RefObject<MoverHistoryCache>; onEnter: () => void }) {
  const movement = buildPublishedPriceMovement(data.materials, data.batches[0]?.comparison);

  return <article className={`workbench-detail ${styles.root} ${styles.summaryPage}`}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>采购部 · 已启用</span><h1>原料价格管理</h1><p>快速查看采购价格、异常和最新成本基线，需要处理业务时再进入完整工作台。</p></div>
      <button className="primary-button" type="button" onClick={onEnter}>进入工作台<ArrowRight size={15} /></button>
    </header>
    <ProcurementMetrics data={data} movement={movement} />
    <PriceTrendPanel data={data} className={styles.previewTrend} />
    <PriceMovers batches={data.batches} cache={moverHistory} compact />
  </article>;
}

function PriceTrendPanel({ data, className = "" }: { data: ProcurementOverview; className?: string }) {
  const [history, setHistory] = useState<ProcurementMaterialDetail["official_history"] | null>(null);
  const { period, range, setPeriod } = usePriceDateRange(data.batches, "3m");
  const [failed, setFailed] = useState(false);
  const movement = buildPriceMovement(data.materials);
  const materialMap = new Map(data.materials.map((material) => [material.code, material]));
  const defaultMaterial = movement.ranked[0]?.code ?? data.materials[0]?.code ?? "";
  const [selectedMaterial, setSelectedMaterial] = useState(defaultMaterial);
  const trend = (history ?? []).filter(item => item.version_date.slice(0, 10) >= range.start && item.version_date.slice(0, 10) <= range.end && item.latest_price != null && Number.isFinite(Number(item.latest_price))).map(item => ({recordedAt: item.version_date, value: Number(item.latest_price)}));
  const axis = focusedTrendAxis([{ values: trend.map(item => item.value) }]);
  useEffect(() => {
    const material = data.materials.find(item => item.code === selectedMaterial);
    if (!material) return;
    const controller = new AbortController(); setHistory(null); setFailed(false);
    fetchProcurementMaterial(material.id, controller.signal).then(item => setHistory(item.official_history)).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [selectedMaterial, data.batches[0]?.id]);

  useEffect(() => {
    if (selectedMaterial && data.materials.some((material) => material.code === selectedMaterial)) return;
    setSelectedMaterial(defaultMaterial);
  }, [data.materials, defaultMaterial, selectedMaterial]);

  return <DashboardPanel className={`${styles.dashboardPanel} ${styles.trendPanel}${className ? ` ${className}` : ""}`}>
    <div className={styles.panelHeading}><div><span>历史价格记录</span><h2>原料价格走势</h2></div><div className={styles.chartActions}><PriceDateRangeMenu label="走势日期范围" period={period} range={range} onChange={setPeriod} /><TrendMaterialMenu materials={data.materials} selected={selectedMaterial} onSelect={setSelectedMaterial} /></div></div>
    {failed ? <ChartEmpty title="价格历史暂时不可用" detail="稍后重新进入该页面。" /> : history === null ? <WorkbenchLoading local title="正在读取采购价格趋势" /> : trend.length < 2 ? <ChartEmpty title="暂无可比较周期" detail="至少需要两期单值价格才会生成趋势线。" /> : <div className={styles.lineChart} aria-label={`${selectedMaterial}价格趋势`}><ResponsiveContainer width="100%" height="100%"><LineChart data={trend} accessibilityLayer margin={{ top: 8, right: 12, bottom: 4, left: 0 }}><CartesianGrid stroke="#edf0f1" vertical={false} /><XAxis dataKey="recordedAt" tickFormatter={shortDate} tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis domain={axis.domain} ticks={axis.ticks} interval="preserveStartEnd" minTickGap={6} tickFormatter={value => Number(value).toFixed(2)} tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} width={52} /><Tooltip labelFormatter={(value) => formatPriceDate(String(value))} formatter={(value) => [price(String(value)), "最新价"]} /><Line type="monotone" dataKey="value" stroke="#2f3337" strokeWidth={2} dot={{ r: 3, fill: "#fff", strokeWidth: 2 }} activeDot={{ r: 4 }} /></LineChart></ResponsiveContainer></div>}
  </DashboardPanel>;
}


function Dashboard({ data, moverHistory, newsCache, onOpenUpdate }: { data: ProcurementOverview; moverHistory: React.RefObject<MoverHistoryCache>; newsCache: React.RefObject<NewsData | null>; onOpenUpdate: () => void }) {
  const movement = buildPublishedPriceMovement(data.materials, data.batches[0]?.comparison);
  const editable = Boolean(data.capabilities?.can_edit) && (!data.current_update || ["draft", "returned"].includes(data.current_update.status));
  return <>
    <section className={styles.taskCard}>
      <div><span>价格更新提醒</span><h2>及时更新采购价格</h2><p>收到最新报价后，请及时更新价格台账。</p></div>
      <button className="primary-button" type="button" onClick={onOpenUpdate}>{editable ? "更新价格" : "查看台账"}<ArrowRight size={15} /></button>
    </section>
    <ProcurementMetrics data={data} movement={movement} />
    <div className={styles.dashboardGrid}>
      <PriceTrendPanel data={data} />
      <PriceDistributionPanel data={data} />
      <PriceMovers batches={data.batches} cache={moverHistory} />
      <ProcurementNews cache={newsCache} />
    </div>
  </>;
}



function PriceDistributionPanel({ data }: { data: ProcurementOverview }) {
  const { period, range, setPeriod } = usePriceDateRange(data.batches);
  const [history, setHistory] = useState<ProcurementBatchDetail[] | null>(null);
  const [failed, setFailed] = useState(false);
  const selectedBatches = [range.start, range.end].map(date => [...data.batches].sort((a, b) => (b.price_date || b.published_at).localeCompare(a.price_date || a.published_at) || b.version - a.version).find(batch => (batch.price_date || batch.published_at).slice(0, 10) <= date));
  const ids = [...new Set(selectedBatches.flatMap(batch => batch ? [batch.id] : []))];
  useEffect(() => {
    const controller = new AbortController();
    setHistory(null); setFailed(false);
    Promise.all(ids.map(id => fetchProcurementBatch(id, controller.signal))).then(value => { if (!controller.signal.aborted) setHistory(value); }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ids.join("|")]);
  const movement = history ? buildRangeDistribution(history, range) : null;
  const surgeCount = movement?.ranked.filter(item => item.changePercent >= 10).length ?? 0;
  const pieData = [
    { name: "大幅上涨", value: surgeCount, color: "#d03730" },
    { name: "上涨", value: (movement?.counts.rising ?? 0) - surgeCount, color: "#c97732" },
    { name: "下降", value: movement?.counts.falling ?? 0, color: "#3f7d68" },
    { name: "持平", value: movement?.counts.stable ?? 0, color: "var(--price-stable)" },
    { name: "无期初价", value: movement?.counts.first ?? 0, color: "#8b99a6" },
    { name: "缺价", value: movement?.counts.unavailable ?? 0, color: "#d7dbde" },
    { name: "不可比较", value: movement?.counts.incomparable ?? 0, color: "#a8a1ab" },
  ].filter(item => item.value > 0);
  return <DashboardPanel className={styles.dashboardPanel}>
        <div className={styles.panelHeading}><div><span>原料数量占比</span><h2>价格变动分布</h2></div><PriceDateRangeMenu label="分布日期范围" period={period} range={range} onChange={setPeriod} /></div>
        {failed ? <ChartEmpty title="价格分布读取失败" detail="请重新加载页面。" /> : history === null ? <WorkbenchLoading local title="正在读取采购价格分布" /> : !movement ? <ChartEmpty title="暂无价格版本统计" detail="所选截止日期之前没有价格版本。" /> : <><div className={styles.pieChart}><ResponsiveContainer width="100%" height="100%"><PieChart accessibilityLayer><Pie data={pieData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={72} paddingAngle={2}>{pieData.map((item) => <Cell key={item.name} fill={item.color} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer><strong>{movement.comparable}</strong><span>项可比较</span></div><div className={styles.chartLegend}>{pieData.map((item) => <span key={item.name} className={item.name === "持平" ? styles.stableText : undefined}><i style={{ background: item.color }} />{item.name}<strong>{item.value}</strong></span>)}</div></>}
      </DashboardPanel>;
}

function PriceMovers({ batches, cache, compact = false }: { batches: ProcurementOverview["batches"]; cache: React.RefObject<MoverHistoryCache>; compact?: boolean }) {
  const [selectedMaterial, setSelectedMaterial] = useState<string | null>(null);
  const materialTrigger = useRef<HTMLButtonElement | null>(null);
  const [history, setHistory] = useState<ProcurementBatchDetail[] | null>(() => cache.current?.history ?? null);
  const historyKey = JSON.stringify(batches);
  const { period, range, setPeriod } = usePriceDateRange(batches);
  const rows = useMemo(() => history ? buildVersionMovers(history, { start: range.start, end: range.end }) : null, [history, range.start, range.end]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [ranking, setRanking] = useState<"up" | "down">("up");
  const matchingRows = rows?.filter(row => ranking === "up" ? row.changePercent > 0 : row.changePercent < 0) ?? [];
  const rankedRows = matchingRows.slice(0, compact ? 10 : 30);
  const pageSize = 10;
  const pages = Math.ceil(rankedRows.length / pageSize);
  const { page, previousPage, instant, reduced, rotating, controls, interaction, setPage, setPreviousPage, setInstant } = useMoverPaging(pages, `${ranking}-${range.start}-${range.end}`, !!selectedMaterial);

  useEffect(() => {
    if (cache.current?.key === historyKey && retry === 0) return;
    const controller = new AbortController();
    setFailed(false);
    Promise.all(batches.map(batch => fetchProcurementBatch(batch.id, controller.signal))).then(details => {
      if (controller.signal.aborted) return;
      cache.current = { key: historyKey, history: details };
      setHistory(details);
      setPage(0); setPreviousPage(null); setInstant(true);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [historyKey, retry]);



  return <DashboardPanel className={`${styles.dashboardPanel} ${styles.moversPanel}${compact ? ` ${styles.compactMovers}` : ""}`} aria-label="价格变动排行" aria-roledescription={compact ? undefined : "轮播"} {...interaction}>
    <div className={styles.panelHeading}><div><span>区间涨跌幅</span><h2>价格变动排行</h2></div><div className={styles.moverActions}><PriceDateRangeMenu period={period} range={range} onChange={value => { setPeriod(value); setPage(0); setPreviousPage(null); setInstant(true); }} /><div className={styles.moverSwitch} role="group" aria-label="排行方向">{(["up", "down"] as const).map(value => <button key={value} type="button" aria-pressed={ranking === value} onClick={() => { setRanking(value); setPage(0); setPreviousPage(null); setInstant(true); }}>{value === "up" ? "涨幅" : "降幅"}</button>)}</div></div></div>
    {failed && history !== null && <p role="status">排行刷新失败，暂显示上次结果。<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {failed && history === null ? <div className={styles.chartEmpty}><strong>价格排行读取失败</strong><button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>重新加载</button></div> : rows === null ? <WorkbenchLoading local title="正在读取采购价格排行" /> : !rankedRows.length ? <ChartEmpty title={ranking === "up" ? "暂无涨价原料" : "暂无降价原料"} detail="该范围内暂无符合条件的原料；缺少期初价格不参与排行。" /> : <>
      <div key={`${ranking}-${range.start}-${range.end}`} className={styles.moverPages} data-instant={instant || reduced} aria-live={rotating ? "off" : "polite"}>
        {Array.from({ length: pages }, (_, index) => <div key={index} data-active={page === index} data-retiring={previousPage === index} aria-hidden={page !== index} inert={page !== index} className={styles.moverList} role="group" aria-roledescription={compact ? undefined : "排行页"} aria-label={compact ? "排行结果" : `第 ${index + 1} 页，共 ${pages} 页`}>
          {rankedRows.slice(index * pageSize, (index + 1) * pageSize).map((row, rowIndex) => { const Icon = row.changePercent > 0 ? TrendingUp : TrendingDown; return <div key={`${row.batchId}-${row.materialId}`} style={{ transitionDelay: `${Math.floor(rowIndex / 2) * 30}ms` }}><Icon size={16} /><span><span className={styles.moverLine}><strong><button type="button" className={styles.materialLink} onClick={event => { materialTrigger.current = event.currentTarget; setSelectedMaterial(row.materialId); }}><span><strong title={row.item.code}>{row.item.code}</strong></span><ChevronRight size={16} aria-hidden="true"/></button></strong><span className={styles.moverPrices} title={`比较日期：${formatPriceDate(row.previousDate)} → ${formatPriceDate(row.date)}`}><span>{price(row.previous)}</span><ArrowRight size={12} /><b>{price(row.item.latest_price)}</b><Movement value={row.changePercent} /></span></span><small className={styles.moverVersions}><span>v{row.version}</span>{" · "}<span>{formatPriceDate(row.date)}</span></small></span></div>; })}
        </div>)}
      </div>
      <footer className={styles.moverCaption}><span>本期{ranking === "up" ? "上涨" : "下降"} {matchingRows.length} 项{compact && matchingRows.length > rankedRows.length && ` · 显示前 ${rankedRows.length} 项`}</span>{controls}</footer>
    </>}
    {selectedMaterial && createPortal(<ReadOnlyMaterialDrawer batches={batches} materialId={selectedMaterial} loadMaterial={fetchProcurementMaterial} onClose={() => { setSelectedMaterial(null); requestAnimationFrame(() => materialTrigger.current?.focus({preventScroll:true})); }}/>, document.body)}
  </DashboardPanel>;
}


function usePriceDateRange(batches: ProcurementOverview["batches"], defaultPeriod: "14d" | "1m" | "3m" = "14d") {
  const [period, setPeriod] = useState<"14d" | "1m" | "3m" | { start: string; end: string }>(defaultPeriod);
  const end = batches.map(batch => (batch.price_date || batch.published_at).slice(0, 10)).sort().at(-1) ?? today();
  const range = typeof period === "string" ? moverDateRange(end, period) : period;
  return { period, range, setPeriod };
}


function CreateMaterialDialog({ data, onClose, onCreated }: { data: ProcurementOverview; onClose: () => void; onCreated: (code: string, hasPrice: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const working = useRef(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const [basis, setBasis] = useState(data);
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(data.current_update?.price_date ?? today());
  const [reason, setReason] = useState<ReasonSelection>({ selected: "", custom: "" });
  const [departments, setDepartments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshed, setRefreshed] = useState(false);
  const [discard, setDiscard] = useState(false);
  const hasPrice = amount.trim() !== "";
  const dirty = Boolean(code || amount || departments.length || reason.selected);
  const unknownDepartments = departments.some(id => !basis.departments?.some(group => group.id === id));
  const canSave = Boolean(code.trim()) && !unknownDepartments && (!hasPrice || Boolean(basis.capabilities?.can_edit && /^\d+(\.\d+)?$/.test(amount.trim()) && date && resolveReason(reason)));
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); trigger?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (discard) keepEditing.current?.focus(); }, [discard]);
  useEffect(() => {
    const protect = (event: Event) => { if (dirty || working.current) event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    window.addEventListener("procurement-before-leave", protect);
    return () => { window.removeEventListener("beforeunload", protect); window.removeEventListener("procurement-before-leave", protect); };
  }, [dirty]);
  const close = () => { if (!working.current) { if (dirty) setDiscard(true); else onClose(); } };
  const refresh = async () => {
    if (working.current) return;
    working.current = true; setBusy(true); setRefreshed(false);
    try { setBasis(await fetchProcurementOverview()); setError(""); setRefreshed(true); }
    catch (failure) { setError((failure as Error).message); }
    finally { working.current = false; setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (working.current || !canSave) return;
    working.current = true; setBusy(true); setError("");
    try {
      await createProcurementMaterial({ code: code.trim(), name: code.trim(), department_ids: departments, price: hasPrice ? amount.trim() : null, effective_date: hasPrice ? date : null, reason: hasPrice ? resolveReason(reason) : "", update_id: basis.current_update?.id ?? null, updated_at: basis.current_update?.updated_at ?? null, baseline_id: basis.batches[0]?.id ?? null });
      onCreated(code.trim(), hasPrice);
    } catch (failure) { setError((failure as Error).message); }
    finally { working.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className={`settings-dialog ${styles.materialCreate}`} aria-labelledby="material-create-title" onCancel={event => { event.preventDefault(); if (discard) { setDiscard(false); dialog.current?.querySelector<HTMLButtonElement>("header button")?.focus(); } else close(); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }} onMouseDown={event => {
    if (event.target !== event.currentTarget) return;
      event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }}>
    <header><h2 id="material-create-title">新增原料</h2><button className="icon-button" type="button" aria-label="关闭新增原料" disabled={busy} onClick={close}><X size={18} /></button></header>
    {discard && <section className={styles.materialDiscard} role="alertdialog" aria-labelledby="material-discard-title"><h3 id="material-discard-title">放弃本次填写？</h3><p>原料和价格尚未保存，关闭后需要重新填写。</p><div><button ref={keepEditing} className="secondary-button" onClick={() => { setDiscard(false); dialog.current?.querySelector<HTMLInputElement>("input")?.focus(); }}>继续填写</button><button className="primary-button" onClick={onClose}>放弃并关闭</button></div></section>}
    <form onSubmit={submit} hidden={discard} inert={discard} aria-busy={busy}>
      <div className={styles.materialCreateBody}>
        <div className={styles.materialIdentity}>
        <label className={styles.materialCreateField}>原料编号<input autoFocus required maxLength={64} disabled={busy} value={code} onChange={event => setCode(event.target.value)} placeholder="输入唯一编号（必填）" /></label>
        </div>
        <label className={styles.materialCreateField}>原料价格<span className={styles.materialPriceField}><DecimalInput inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" disabled={busy} value={amount} onChange={event => setAmount(event.target.value)} placeholder="选填，留空为未定价" /><small>元/kg</small></span><span className={styles.materialCreateHint}>保存为待发布价</span></label>
        {hasPrice && <div className={styles.materialPriceMeta}>
          <label className={styles.materialCreateField}>价格日期<input type="date" required disabled={busy} value={date} onChange={event => setDate(event.target.value)} /></label>
          <div><span>录入说明</span><ReasonSelect label="新增原料录入说明" options={PRICE_REASONS} placeholder="请选择录入说明" value={reason} disabled={busy} onChange={setReason} /></div>
          <p className={styles.materialCreateHint}>{basis.current_update ? `本轮价格日期：${basis.current_update.price_date}。价格需加入同一轮更新。` : "保存后会建立本轮更新，不会直接启用价格。"}</p>
        </div>}
        <fieldset className={styles.materialDepartments} disabled={busy}><legend>数据分流 <small>可多选</small></legend><div>{basis.departments?.map(group => <label key={group.id}><input type="checkbox" checked={departments.includes(group.id)} onChange={event => setDepartments(values => event.target.checked ? [...values, group.id] : values.filter(id => id !== group.id))} />{group.name}</label>)}</div><p className={styles.materialCreateHint}>{basis.departments?.length ? "未选择时仅加入总台账，之后也可调整。" : "暂无分流部门，本次仅加入总台账。"}</p></fieldset>
        {unknownDepartments && <p role="alert" className={styles.error}>部分部门已不存在。<button type="button" disabled={busy} onClick={() => setDepartments(values => values.filter(id => basis.departments?.some(group => group.id === id)))}>移除失效选择</button></p>}
        {refreshed && <p role="status" className={styles.materialCreateHint}>已刷新本轮概况和部门，填写内容已保留，请核对后保存。</p>}
        {error && <div role="alert" className={styles.materialCreateError}><p>{error}</p><button className="secondary-button" type="button" disabled={busy} onClick={() => void refresh()}>刷新概况，保留输入</button></div>}
      </div>
      <footer><button className="secondary-button" type="button" disabled={busy} onClick={close}>取消</button><button className="primary-button" type="submit" disabled={busy || !canSave}>{busy ? "正在处理…" : "新增原料"}</button></footer>
    </form>
  </dialog>;
}

function PriceHistory({ published }: { published: ProcurementOverview["batches"] }) {
  const [recordFilter, setRecordFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const rows = published.filter(row => recordFilter === "all" || (recordFilter === "active" ? row.status === "active" : row.status !== "active")).sort((a, b) => b.version - a.version);
  const close = () => { setSelected(null); window.requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); };
  return <>
    <RecordFilters label="价格版本分类" value={recordFilter} onChange={setRecordFilter} options={[{value:"all",label:"全部版本",count:published.length},{value:"active",label:"当前生效",count:published.filter(row => row.status === "active").length},{value:"history",label:"历史版本",count:published.filter(row => row.status !== "active").length}]}/>
    {!rows.length && <Empty title="该分类暂无价格版本" detail="启用价格后，版本及其修改记录将在这里显示。" />}
    <ol className={styles.historyTimeline}>{rows.map(row => <li key={row.id}>
      <i aria-hidden="true" />
      <button type="button" aria-label={`v${row.version} · 价格日期 ${row.price_date || "未记录"}`} onClick={event => { trigger.current = event.currentTarget; setSelected(row.id); }}>
        <span className={styles.historyDate}><strong>{row.price_date ? formatPriceDate(row.price_date) : "日期未记录"}</strong>{row.status === "active" && <em>当前生效</em>}</span>
        <span className={styles.historySource}><strong>v{row.version}</strong><small>{row.comparison?.added_material_ids?.length ? `补充 ${row.comparison.added_material_ids.length} 项原料价格` : `覆盖 ${row.item_count} 项`} · {row.status === "active" ? "当前生效" : "历史版本"} · {row.provenance ? "历史迁入 · 原表未记录启用时间" : `启用 ${formatShanghaiDateTime(row.activated_at ?? row.published_at)} · ${row.published_by_name ?? "未记录启用人"}`}</small>{row.provenance && <small>本期已报 {row.provenance.reported_count} · 本期未报 {row.item_count-row.provenance.reported_count}（此前有价则沿用）</small>}</span>
        <VersionSummary comparison={row.comparison} />
        <ChevronRight size={17} aria-hidden="true" />
      </button>
    </li>)}</ol>
    {selected && <PublishedBatchDrawer batchId={selected} onClose={close} />}
  </>;
}

function VersionSummary({ comparison, hideZeroFirst = false }: { comparison: ProcurementOverview["batches"][number]["comparison"]; hideZeroFirst?: boolean }) {
  if (!comparison) return <span className={styles.historyBatchStats}>版本统计暂不可用</span>;
  if (comparison.added_material_ids?.length) return <span className={styles.historyBatchStats}><small>补充原料价格</small><span>{comparison.added_material_ids.length} 项首次定价</span><span className={styles.historyStable}>{comparison.unchanged} 项保留原价与比较</span></span>;
  return <span className={styles.historyBatchStats}><small>{comparison.previous_version === null ? "首次建立基线" : `较 v${comparison.previous_version}`}</small><span className={styles.historyUp}>↑ {comparison.up} 上涨</span><span className={styles.historyDown}>↓ {comparison.down} 下降</span><span className={styles.historyStable}>— {comparison.unchanged} 未变</span>{(!hideZeroFirst || comparison.first > 0) && <span>{comparison.first} 首次定价</span>}{comparison.missing > 0 && <span>{comparison.missing} 未定价</span>}{Boolean(comparison.incomparable) && <span>{comparison.incomparable} 不可比较</span>}</span>;
}

function PriceRecordDrawer({ title, label, loading, failed, onClose, children, fixedBody = false }: { fixedBody?: boolean; title: string; label: string; loading: boolean; failed: boolean; onClose: () => void; children: React.ReactNode }) {
  return <Drawer title={title} label={label} onClose={onClose} className={styles.batchDrawer} bodyClassName={fixedBody ? styles.versionBody : ""}>
    {failed ? <div className={styles.drawerLoading} role="alert">详情读取失败，请关闭后重试。</div> : loading ? <WorkbenchLoading local title="正在读取采购价格明细" /> : children}
  </Drawer>;
}

function Batches({ data, onRefresh, onNotice, onOpenUpdate }: { data: ProcurementOverview; accessLevel: number; onRefresh: () => void; onNotice: (message: string) => void; onOpenUpdate: () => void }) {
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const scheduled = data.scheduled_update;
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleTrigger = useRef<HTMLButtonElement | null>(null);
  const [scheduleClosing, setScheduleClosing] = useState(false);
  const scheduleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (scheduleTimer.current) clearTimeout(scheduleTimer.current); }, []);
  const closeSchedule = () => {
    if (scheduleTimer.current) return;
    setScheduleClosing(true);
    scheduleTimer.current = setTimeout(() => { setScheduleOpen(false); setScheduleClosing(false); scheduleTimer.current = null; scheduleTrigger.current?.focus(); }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140);
  };
  const cancel = async (copyToDraft: boolean) => {
    if (!scheduled) return;
    setBusy(true);
    try { await cancelProcurementSchedule(scheduled.id, cancelReason, copyToDraft); onNotice(copyToDraft ? "排期已撤销，并复制为新的本轮草稿。" : "排期已撤销，最新价格未受影响。"); closeSchedule(); onRefresh(); }
    catch (reason) { onNotice(reason instanceof Error ? reason.message : "撤销排期失败"); }
    finally { setBusy(false); }
  };
  return <section className={`${styles.section} ${styles.subpageSection}`}><div className={`${styles.sectionHeading} ${styles.ledgerHeading}`}><div><h2>价格历史</h2><p className={styles.sectionDescription}>查看价格版本，以及各版本的价格变化与修改过程。</p></div></div>
    {data.current_update?.status === "revalidation_required" && <div className={styles.ledgerSchedule}><AlertTriangle size={15} /><span>{formatPriceDate(data.current_update.price_date)} 排期需要重新确认，暂不自动启用。</span><button type="button" onClick={onOpenUpdate}>前往台账重新确认</button></div>}
    {scheduled && <div className={styles.ledgerSchedule}><Clock3 size={15} /><span>待启用 · 价格日期 {formatPriceDate(scheduled.price_date)} · 将于 {formatShanghaiDateTime(scheduled.activate_at)} 启用</span><button ref={scheduleTrigger} type="button" onClick={() => setScheduleOpen(true)}>查看排期</button></div>}
    <PriceHistory published={data.batches} />
    {scheduleOpen && scheduled && <div className={`${styles.drawerLayer} ${scheduleClosing ? styles.closing : ""}`} onKeyDown={recordDialogKeys} onMouseDown={event => { if (event.target === event.currentTarget) closeSchedule(); }}><aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="待启用排期"><header className={styles.drawerHeader}><h2>待启用排期</h2><button ref={focusWithoutScroll} className="icon-button" type="button" aria-label="关闭详情" onClick={closeSchedule}><X size={17} /></button></header><div className={styles.drawerBody}><p>启用前，最新价格保持不变。</p>
    {scheduled && <div className={styles.scheduledCard}><Clock3 size={18} /><span><strong>待启用：{formatPriceDate(scheduled.price_date)}</strong><small>{formatShanghaiDateTime(scheduled.activate_at)} · {scheduled.summary.coverage_count} 项原料</small></span><em>定时启用</em>{data.capabilities?.can_activate && <label><input value={cancelReason} maxLength={200} onChange={(event) => setCancelReason(event.target.value)} placeholder="撤销原因（4–200字）" /><button className="secondary-button" type="button" disabled={busy || cancelReason.trim().length < 4} onClick={() => void cancel(false)}>撤销排期</button><button className="secondary-button" type="button" disabled={busy || cancelReason.trim().length < 4} onClick={() => void cancel(true)}>撤销并复制草稿</button></label>}</div>}
    </div></aside></div>}
  </section>;
}

function PublishedBatchDrawer({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const [sort, setSort] = useState("change");
  const [direction, setDirection] = useState<"ascending" | "descending">("descending");
  useEffect(() => { setSort("change"); setDirection("descending"); }, [batchId]);
  const header = (column: string, label: string) => <th key={column} aria-sort={sort === column ? direction : undefined}><button type="button" className={styles.sortHeading} onClick={() => { setSort(column); setDirection(sort === column ? direction === "ascending" ? "descending" : "ascending" : column === "code" ? "ascending" : "descending"); }}>{label}{sort === column && (direction === "ascending" ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}</button></th>;
  const [detail, setDetail] = useState<ProcurementBatchDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<"prices" | "changes">("prices");
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setFailed(false);
    fetchProcurementBatch(batchId, controller.signal).then(setDetail).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [batchId]);
  const additions = detail?.comparison?.added_material_ids;
  const priceItems = detail ? sortBatchPrices(detail, sort, direction).filter(item => !additions?.length || additions.includes(item.material_id)) : [];
  return <PriceRecordDrawer fixedBody title={detail ? `价格基线 v${detail.version}` : "正在读取"} label="价格基线详情" loading={!detail} failed={failed} onClose={onClose}>
    {detail && <>
      <div className={styles.versionOverview}><VersionSummary comparison={detail.comparison} hideZeroFirst /></div>
      <div className={styles.detailMetrics}><div><span>价格日期</span><strong>{detail.price_date ? formatPriceDate(detail.price_date) : "—"}</strong></div><div><span>启用时间</span><strong>{detail.provenance ? "原表未记录" : formatDate(detail.activated_at ?? detail.published_at)}</strong></div><div><span>{additions?.length ? "本次补充" : "原料数量"}</span><strong>{additions?.length || detail.item_count}</strong></div><div><span>版本状态</span><strong>{detail.status === "active" ? "当前生效" : "历史版本"}</strong></div></div>
      <p className={styles.batchMeta}>{detail.provenance ? `历史迁入 · ${detail.provenance.filename} · 迁入操作人 ${detail.provenance.imported_by} · 迁入时间 ${formatShanghaiDateTime(detail.provenance.imported_at)}；原表未记录历史启用人及逐次修改。` : `${detail.source_name ?? "未记录来源"} · 启用人 ${detail.published_by_name ?? "未记录"}${detail.activation_mode === "scheduled" ? " · 系统定时启用" : ""}`}</p>
      {detail.provenance && <p className={styles.batchMeta}>本期已报 {detail.provenance.reported_count} 项 · 本期未报 {detail.item_count-detail.provenance.reported_count} 项（此前有价则沿用，不代表价格未变）</p>}
      <div className={styles.versionTabs} role="tablist" aria-label="版本内容">
        {(["prices", "changes"] as const).map(value => <button key={value} id={`version-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`version-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "prices" : event.key === "End" ? "changes" : tab === "prices" ? "changes" : "prices"; setTab(next); document.getElementById(`version-tab-${next}`)?.focus({ preventScroll: true }); } }}>{value === "prices" ? "价格" : "修改记录"}<span>{value === "prices" ? priceItems.length : detail.changes?.length ?? 0}</span></button>)}
      </div>
      <div className={styles.versionPane} id="version-panel-prices" role="tabpanel" aria-labelledby="version-tab-prices" tabIndex={0} hidden={tab !== "prices"}>
      <div className={styles.changePrices}><table className={styles.table}><thead><tr>{header("code", "原料编号 / 来源")}{header("previous", "上版价格")}{header("current", "本版价格")}{header("change", "涨跌变化")}</tr></thead><tbody>{priceItems.map(item => { const comparison = detail.comparison?.items[item.material_id]; const source=detail.snapshot_sources?.[item.material_id]; return <tr key={item.material_id}><td><strong>{item.code} · {item.unit}</strong><span>{source?.price_date ?? "未定价"}{source?.sheet ? ` · ${source.sheet}!${source.cell ?? "—"}` : ""}</span></td><td>{price(comparison?.previous_raw ?? comparison?.previous)}</td><td><strong>{price(source?.raw_price ?? item.latest_price)}</strong>{source && source.price_kind!=="number" && source.price_kind!=="missing" && <small>原文异常，不参与精确涨跌</small>}</td><td><Movement value={comparison?.change == null ? null : comparison.change * 100} /></td></tr>; })}</tbody></table></div>
      </div>
      <div className={styles.versionPane} id="version-panel-changes" role="tabpanel" aria-labelledby="version-tab-changes" tabIndex={0} hidden={tab !== "changes"}>
        {!detail.changes?.length ? <p className={styles.batchMeta}>此版本没有可关联的逐次修改记录。</p> : <ol className={styles.changeTimeline}>{detail.changes.map(change => <li key={change.id}><div><strong>{updateEventLabel(change.event)}</strong><time>{formatShanghaiDateTime(change.created_at)}</time></div><p>{change.actor}</p>{change.reason && <p>{change.reason}</p>}<ChangePrices items={change.items ?? []} /></li>)}</ol>}
      </div>
    </>}
  </PriceRecordDrawer>;
}

function ImportPanel({ current, onClose, onImported }: { current: ProcurementUpdate | null; onClose: () => void; onImported: (data: ProcurementOverview) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const busyRef = useRef(false);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    alive.current = true;
    element?.showModal();
    return () => { alive.current = false; element?.close(); trigger?.focus({ preventScroll: true }); };
  }, []);
  const [source, setSource] = useState("采购价格导入");
  const [effectiveDate, setEffectiveDate] = useState(current?.price_date ?? today());
  const [revision, setRevision] = useState({update_id: current?.id ?? null, updated_at: current?.updated_at ?? null});
  const [excelFile,setExcelFile] = useState<File | null>(null);
  const [excel,setExcel] = useState<ExcelPreview | null>(null);
  const [sheet,setSheet] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<ProcurementImportPreview | null>(null);
  const [importReason, setImportReason] = useState<ReasonSelection>({ selected: "", custom: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");


  const initial = useRef({ source, effectiveDate });
  const dirty = !!(content.trim() || excelFile || source !== initial.current.source || effectiveDate !== initial.current.effectiveDate || resolveReason(importReason));
  const unsaved = useUnsavedChanges(dirty, busy, "导入文件和输入尚未保存。", "procurement-before-leave");

  const readFile = async (file?: File) => {
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setSource(file.name); setPreview(null); setExcel(null); setContent(""); setError("");
    try {
      if (file.name.toLowerCase().endsWith(".xlsx")) {
        setExcelFile(file);
        const result = await previewProcurementExcel(file);
        if (!alive.current) return;
        setExcel(result); setSheet(result.default_sheet);
        setEffectiveDate(result.sheets.find(s => s.name === result.default_sheet)?.dates.at(-1) ?? today());
      } else { setExcelFile(null); const text = await file.text(); if (alive.current) setContent(text); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "读取文件失败"); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  const run = async (confirm: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError("");
    try {
      if (confirm) {
        if (!preview || !resolveReason(importReason)) return;
        await confirmProcurementImport(source, effectiveDate, content, revision, resolveReason(importReason));
        if (!alive.current) return;
        const overview = await fetchProcurementOverview();
        if (alive.current) onImported(overview);
      } else {
        let text = content;
        if (excelFile) { const result = await previewProcurementExcel(excelFile,sheet,effectiveDate); if (!alive.current) return; setExcel(result); if (!result.selection || result.selection.blocked) {setPreview(null); return;} text=result.selection.content; setContent(text); }
        const result = await previewProcurementImport(source, effectiveDate, text);
        if (alive.current) setPreview(result);
      }
    } catch (reason) {
      if (!alive.current) return;
      setError(reason instanceof Error ? reason.message : "导入失败");
      if (confirm) setPreview(null);
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  const close = async () => { if (!busyRef.current && await unsaved.request()) onClose(); };
  return <dialog ref={dialog} className={`settings-dialog ${styles.materialCreate} ${styles.importPanel}`} aria-labelledby="import-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <header><h2 id="import-title">导入价格</h2><button className="icon-button" type="button" aria-label="关闭导入" disabled={busy} onClick={close}><X size={17} /></button></header>
    <div className={styles.materialCreateBody}>
    <p className={styles.importIntro}>先检查数据，再保存为待发布价。</p>
    <label>来源名称<input disabled={busy} value={source} onChange={(event) => setSource(event.target.value)} /></label>
    <label>价格日期<div className={styles.dateField} onClick={(event) => { const input = event.currentTarget.querySelector("input"); input?.focus(); try { input?.showPicker?.(); } catch { /* Native input remains usable. */ } }}><input type="date" disabled={busy} value={effectiveDate} onChange={(event) => { setEffectiveDate(event.target.value); setPreview(null); }} /><CalendarDays size={15} /></div></label>
    <label className={styles.filePicker}><FileUp size={14} />选择 Excel、CSV 或 TXT<input type="file" accept=".xlsx,.csv,.txt" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} /></label>
    {excel && <><label>工作表<select disabled={busy} value={sheet} onChange={e=>{setSheet(e.target.value); setPreview(null); setExcel({...excel,selection:undefined});}}>{excel.sheets.map(item=><option key={item.name}>{item.name}</option>)}</select></label><label>表内价格日期<select disabled={busy} value={effectiveDate} onChange={e=>{setEffectiveDate(e.target.value);setPreview(null);}}>{excel.sheets.find(s=>s.name===sheet)?.dates.map(date=><option key={date}>{date}</option>)}</select></label>{excel.selection && <><p>有效 {excel.selection.valid} · 空白 {excel.selection.unreported} · 异常或冲突 {excel.selection.blocked}。空白不清除现价。</p><div className={styles.previewRows}>{excel.selection.rows.map(row=><div key={row.row}><span>第{row.row}行 · {row.code} · {row.raw_price || "—"}</span><em>{({number:"有效",missing:"空白",range:"区间价，须更正",invalid:"异常，须更正",duplicate:"重复编号",unknown:"未知编号"} as Record<string,string>)[row.state] ?? row.state}</em></div>)}</div></>}</>}
    {!excelFile && <label>CSV、TXT 或粘贴表格<textarea rows={8} disabled={busy} value={content} onChange={(event) => { setContent(event.target.value); setPreview(null); }} placeholder={'编号,名称,单位,最新价,库存价,在途价\nCF004,示例原料,kg,12.2,13,12.4'} /></label>}
    {error && <p className={styles.error}>{error}<button type="button" disabled={busy} onClick={async () => {const fresh=await fetchProcurementOverview();if (!alive.current) return;setRevision({update_id:fresh.current_update?.id ?? null,updated_at:fresh.current_update?.updated_at ?? null});setPreview(null);setError("已刷新本轮，请重新检查数据；文件和输入已保留。");}}>读取最新本轮</button></p>}
    {preview && <><div className={styles.preview}><strong>{preview.received_count} 行 · {preview.importable_count} 行可导入 · {preview.skipped_count} 行冲突</strong><span>空白保留现价；保存后仍需由有启用权的人员确认异常波动。</span></div><div className={styles.previewRows}>{preview.rows.map((row) => <div key={`${row.code}-${row.name}`}><span><strong>{row.code}</strong>{price(row.reference_price)} → {price(row.latest_price)} <Movement value={row.change == null ? null : row.change * 100} /></span><em>{row.issues.length ? row.issues.map(importIssueLabel).join("、") : "可导入"}</em></div>)}</div><ReasonSelect label="录价说明" options={PRICE_REASONS} placeholder="请选择说明" value={importReason} disabled={busy} onChange={setImportReason} /></>}
    {unsaved.confirmation}
    </div>
    <footer className={styles.importActions}><button className="secondary-button" type="button" disabled={busy || (!excelFile && !content.trim()) || !effectiveDate} onClick={() => void run(false)}>检查数据</button><button className="primary-button" type="button" disabled={busy || !preview || preview.importable_count === 0 || preview.skipped_count > 0 || Boolean(excel?.selection?.blocked) || !effectiveDate || !resolveReason(importReason)} onClick={() => void run(true)}>确认并导入</button></footer>
  </dialog>;
}

function PublishConfirm({ update, publishing, onClose, onConfirm }: { update: ProcurementUpdate; publishing: boolean; onClose: () => void; onConfirm: (mode: "immediate" | "scheduled", activateAt?: string) => Promise<void> }) {
  const [mode, setMode] = useState<"immediate" | "scheduled">("immediate");
  const [activateAt, setActivateAt] = useState(futureLocalInput());
  const initialTime = useRef(activateAt);
  const unsaved = useUnsavedChanges(mode !== "immediate" || activateAt !== initialTime.current, publishing, "启用方式和时间尚未确认。", "procurement-before-leave");
  const close = async () => { if (await unsaved.request()) onClose(); };
  const counts = summarizeUpdate(update.input_items);
  const risks = update.issues.filter(issue => issue.kind === "price_spike" && issue.status !== "resolved");
  return <div className={styles.confirmLayer} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !publishing) void close(); }}>
    <section onKeyDown={event => {if(event.key === "Escape" && !publishing)void close();else recordDialogKeys(event);}} className={`${styles.confirmDialog} ${styles.publishDialog}`} role="dialog" aria-modal="true" aria-labelledby="publish-confirm-title">
      <div className={styles.panelHeading}><h2 id="publish-confirm-title">启用价格</h2><button className="icon-button" type="button" aria-label="关闭启用确认" ref={focusWithoutScroll} disabled={publishing} onClick={() => void close()}><X size={17} /></button></div>
      <p>价格日期：{formatPriceDate(update.price_date)} · 来源：{update.source_name}</p>
      <div className={styles.publishOverview}>
        <strong>本次调整 {update.input_items.length} 项</strong>
        <p>上涨 {counts.up} 项 · 下降 {counts.down} 项 · <span className={styles.stableText}>持平 {counts.flat} 项</span></p>
        {counts.incomparable > 0 && <p>{counts.incomparable} 项暂无可比较价格，不计入持平。</p>}
        {counts.missing > 0 && <p className={styles.riskText}>{counts.missing} 项缺价</p>}
        <p>{risks.length ? `高波动 ${risks.length} 项，${risks.every(issue => issue.status === "reviewed") ? "均已确认" : "仍有待确认事项"}` : "无高波动"}</p>
        <details className={styles.publishDetails}><summary>查看调整明细</summary><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>原料</th><th>最新价格</th><th>待启用价</th><th>价格变化</th></tr></thead><tbody>{update.input_items.map(item => <tr key={item.material_id}><td>{item.code}</td><td>{price(item.published_price)}</td><td>{price(item.draft_price)}</td><td><span className={styles.updateChange}>{item.comparison_basis === "previous_inquiry" && <small>较上期询价</small>}<Movement value={item.change == null ? null : item.change * 100} /></span></td></tr>)}</tbody></table></div></details>
      </div>
      <p>启用后形成包含 <strong>{update.summary.coverage_count} 项原料</strong> 的完整价格基线，未调整原料沿用最新价格。</p>
      <div className={styles.activateModes}><button type="button" disabled={publishing} aria-pressed={mode === "immediate"} onClick={() => setMode("immediate")}><strong>立即启用</strong><span>确认后立刻生效</span></button><button type="button" disabled={publishing} aria-pressed={mode === "scheduled"} onClick={() => setMode("scheduled")}><strong>定时启用</strong><span>在指定时间生效</span></button></div>
      {mode === "scheduled" && <><label className={styles.scheduleField}>启用时间<input type="datetime-local" disabled={publishing} value={activateAt} onChange={(event) => setActivateAt(event.target.value)} /></label><p>启用前如价格基线变化，排期会暂停并提示重新核对。</p></>}
      <div className={styles.panelActions}><button className="secondary-button" type="button" disabled={publishing} onClick={() => void close()}>返回台账</button><button className="primary-button" type="button" disabled={publishing || counts.missing > 0 || risks.some(issue => issue.status !== "reviewed") || (mode === "scheduled" && !activateAt)} onClick={() => void onConfirm(mode, mode === "scheduled" ? activateAt : undefined)}>{publishing ? "正在处理" : mode === "scheduled" ? "确认排期" : "确认启用"}</button></div>
      {unsaved.confirmation}
    </section>
  </div>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className={styles.empty}><PackageCheck size={21} /><strong>{title}</strong><p>{detail}</p></div>;
}

async function publish(update: ProcurementUpdate, baseline_id: string | null, mode: "immediate" | "scheduled", activateAt: string | undefined, onUpdated: (data: ProcurementOverview) => void, onNotice: (message: string) => void) {
  try {
    const result = await publishProcurementUpdate(update.id, { mode, activate_at: activateAt, updated_at: update.updated_at, baseline_id });
    onUpdated(await fetchProcurementOverview());
    onNotice(mode === "scheduled" ? "本轮价格已安排定时启用。" : `价格基线 v${"version" in result ? result.version : "—"} 已发布并启用。`);
    return true;
  } catch (reason) {
    onNotice(reason instanceof Error ? reason.message : "发布失败");
    return false;
  }
}

function formatPercent(value: number) { return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`; }
function today() { const value = new Date(); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function futureLocalInput() { const value = new Date(Date.now() + 60 * 60 * 1000); value.setMinutes(Math.ceil(value.getMinutes() / 5) * 5, 0, 0); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`; }
function importIssueLabel(issue: string) { return ({ missing_price: "缺价", duplicate_code: "重复编码", unit_conflict: "单位冲突", price_spike: "价格波动" } as Record<string, string>)[issue] ?? issue; }
