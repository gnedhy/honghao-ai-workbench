import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Columns3, Ellipsis, FileUp, Info, Minus, PackageCheck, Pencil, Plus, RefreshCw, Search, SlidersHorizontal, TrendingDown, TrendingUp, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { createProcurementMaterial, bulkAdjustProcurementPrices, cancelProcurementUpdate, adjustProcurementPrice, cancelProcurementSchedule, confirmProcurementImport, fetchProcurementBatch, fetchProcurementMaterial, fetchProcurementOverview, fetchProcurementPreferences, previewProcurementImport, publishProcurementUpdate, reviewProcurementIssue, saveProcurementPreferences, updateProcurementMaterial } from "../api";
import type { ProcurementBatchDetail, ProcurementImportPreview, ProcurementMaterial, ProcurementMaterialDetail, ProcurementOverview, ProcurementPage, ProcurementPreferences, ProcurementUpdate } from "../types";
import { buildPriceMovement, buildRangeDistribution, buildPublishedPriceMovement, buildVersionMovers, moverDateRange, sortBatchPrices } from "./procurementAnalytics";
import { defaultProcurementPage } from "./procurementWorkflow";
import { buildLedgerRows, collectPriceEdits, draftLedgerChange, filterLedgerRows, formalLedgerChange, summarizeUpdate } from "./procurementLedger";
import { PRICE_REASONS, REVIEW_REASONS, resolveReason, type ReasonSelection } from "./procurementReasons";
import styles from "./ProcurementWorkbench.module.css";
import { previewPriceAdjustments, type PricePreview } from "../api";
import { previewProcurementExcel, type ExcelPreview } from "../api";
import { ProcurementDistribution } from "./ProcurementDistribution";
import { ProcurementNews, type NewsData } from "./ProcurementNews";

function usePricePreview(enabled: boolean, date: string, items: Array<{ material_id: string; price: string }>) {
  const key = enabled && date && items.length && items.every(item => /^\d+(\.\d+)?$/.test(item.price)) ? JSON.stringify({ date, items }) : "";
  const [result, setResult] = useState<{ key: string; data?: PricePreview; error?: string }>({ key: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const input = JSON.parse(key) as { date: string; items: Array<{ material_id: string; price: string }> };
      previewPriceAdjustments(input.date, input.items, controller.signal).then(data => setResult({ key, data })).catch(error => { if (!controller.signal.aborted) setResult({ key, error: error.message }); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, revision]);
  return { data: key && result.key === key ? result.data : undefined, error: result.key === key ? result.error : undefined, refresh: () => { setResult({ key: "" }); setRevision(value => value + 1); } };
}

function PriceReview({ preview }: { preview: PricePreview }) {
  const sameBasis = new Set(preview.rows.map(row => row.comparison_basis)).size === 1;
  const basis = preview.rows[0]?.comparison_basis === "published" ? "最新价格" : "上期询价";
  return <div className={styles.priceReview}><div className={styles.priceReviewHeading}><strong>价格核对</strong><span>{preview.rows.filter(row => row.high_risk).length} 项高波动</span></div><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>原料</th><th>{sameBasis ? basis : "参考价"}</th><th>新价格</th><th>价格变化</th><th>提示</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.material_id}><td>{row.code}</td><td>{price(row.reference_price)}{!sameBasis && <span>{row.comparison_basis === "published" ? "最新价格" : "上期询价"}</span>}</td><td>{price(row.price)}</td><td><Movement value={row.change == null ? null : row.change * 100} /></td><td>{row.high_risk ? <span className={styles.riskText}>高波动</span> : "—"}</td></tr>)}</tbody></table></div></div>;
}

type MoverHistoryCache = { key: string; history: ProcurementBatchDetail[] } | null;

export function ProcurementWorkbench({ accessLevel, view, page, onPageChange, onEnter }: { accessLevel: number; view: "preview" | "full"; page: ProcurementPage; onPageChange: (page: ProcurementPage) => void; onEnter: () => void }) {
  const moverHistory = useRef<MoverHistoryCache>(null);
  const [data, setData] = useState<ProcurementOverview | null>(null);
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

  const load = useCallback((signal?: AbortSignal) => {
    setState(current => current === "ready" ? "ready" : "loading");
    return fetchProcurementOverview(signal)
      .then((overview) => { setData(overview); setState("ready"); })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
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

  if (state === "loading") return <ModuleState title="正在读取采购数据" />;
  if (state === "error" || !data) return <ModuleState title="采购工作台暂时不可用" retry={() => void load()} />;

  if (view === "preview") return <ProcurementPreview data={data} onEnter={() => { onPageChange(defaultProcurementPage(data.current_update)); onEnter(); }} />;

  return (
    <article className={`workbench-detail ${styles.root} ${styles.full}${page === "materials" || page === "updates" ? ` ${styles.ledgerPage}` : ""}`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>采购部 · 已启用</span>
          <h1>原料成本管理</h1>
          <p>归集采购价格，确认异常波动后启用可追溯的原料成本基线。</p>
        </div>
      </header>
      {catalogOpen && <CreateMaterialDialog data={data} onClose={() => setCatalogOpen(false)} onCreated={(code, hasPrice) => { setCatalogOpen(false); setLocateCode(code); setNotice(hasPrice ? "原料已新增，价格已保存为待发布价；启用后生效。" : "原料已新增，尚未定价。"); void load(); }} />}

      {notice && <div className={styles.notice}><Check size={14} />{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}

      {page === "dashboard" && <Dashboard data={data} moverHistory={moverHistory} newsCache={newsCache} onOpenUpdate={() => { setEditFromDashboard(true); onPageChange("materials"); }} />}
      {(page === "materials" || page === "updates") && <Materials startInEdit={editFromDashboard} onEditStarted={() => setEditFromDashboard(false)} locateCode={locateCode} data={data} accessLevel={accessLevel} onRefresh={() => load()} onSaved={setData} onCreate={() => setCatalogOpen(true)} onImport={() => setImportOpen(true)} onPublish={() => {publishTrigger.current = document.activeElement as HTMLElement; setPublishOpen(true);}} onPageChange={onPageChange} focusPending={page === "updates"} />}
      {page === "distribution" && <ProcurementDistribution revision={distributionRevision} onOpenMaterial={id => { distributionTrigger.current = document.activeElement as HTMLElement; setDistributionMaterial(id); }} />}
      {page === "distribution" && distributionMaterial && <MaterialDrawer materialId={distributionMaterial} canEdit={accessLevel >= 3} canManage={Boolean(data.capabilities?.can_manage_catalog)} currentPriceDate={data.current_update?.price_date} onClose={closeDistributionMaterial} onChanged={() => { closeDistributionMaterial(); setDistributionRevision(value => value + 1); void load(); }} />}
      {(page === "history" || page === "batches") && <Batches data={data} accessLevel={accessLevel} onRefresh={() => void load()} onNotice={setNotice} onOpenUpdate={() => onPageChange("updates")} />}
      {importOpen && <ImportPanel current={data.current_update} onClose={() => setImportOpen(false)} onImported={(overview) => { setData(overview); setImportOpen(false); onPageChange("materials"); setNotice("价格数据已加入本轮更新，请在台账内处理并启用。"); }} />}
      {publishOpen && data.current_update && <PublishConfirm update={data.current_update} publishing={publishing} onClose={() => {setPublishOpen(false); requestAnimationFrame(() => publishTrigger.current?.focus({preventScroll:true}));}} onConfirm={async (mode, activateAt) => {
        setPublishing(true);
        const published = await publish(data.current_update!, data.batches[0]?.id ?? null, mode, activateAt, setData, setNotice);
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

function ProcurementPreview({ data, onEnter }: { data: ProcurementOverview; onEnter: () => void }) {
  const movement = buildPublishedPriceMovement(data.materials, data.batches[0]?.comparison);
  const materialMap = new Map(data.materials.map((material) => [material.code, material]));

  return <article className={`workbench-detail ${styles.root} ${styles.summaryPage}`}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>采购部 · 已启用</span><h1>原料成本管理</h1><p>快速查看采购价格、异常和最新成本基线，需要处理业务时再进入完整工作台。</p></div>
      <button className="primary-button" type="button" onClick={onEnter}>进入工作台<ArrowRight size={15} /></button>
    </header>
    <ProcurementMetrics data={data} movement={movement} />
    <PriceTrendPanel data={data} className={styles.previewTrend} />
    <section className={styles.section}>
      <div className={styles.sectionHeading}><div><span>管理摘要</span><h2>价格关注</h2></div><small>{movement.comparable ? `${movement.comparable} 项可比较` : "暂无可比较周期"}</small></div>
      {movement.ranked.length
        ? <div className={styles.previewMovers}>{movement.ranked.slice(0, 4).map((item) => { const material = materialMap.get(item.code); return <div key={item.code}><span><strong>{item.code}</strong><small>{item.code} · 当前 {price(material?.published_price)}</small></span><Movement value={item.changePercent} /></div>; })}</div>
        : <div className={styles.inlineEmpty}><strong>暂无价格变动</strong><span>价格版本出现可比较的价格变化后，这里将显示变动最大的原料。</span></div>}
    </section>
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

  return <section className={`${styles.dashboardPanel} ${styles.trendPanel}${className ? ` ${className}` : ""}`}>
    <div className={styles.panelHeading}><div><span>历史价格记录</span><h2>原料价格走势</h2></div><div className={styles.chartActions}><PriceDateRangeMenu label="走势日期范围" period={period} range={range} onChange={setPeriod} /><TrendMaterialMenu materials={data.materials} selected={selectedMaterial} onSelect={setSelectedMaterial} /></div></div>
    {failed ? <ChartEmpty title="价格历史暂时不可用" detail="稍后重新进入该页面。" /> : history === null ? <ChartEmpty title="正在读取价格趋势" detail="正在整理价格版本。" /> : trend.length < 2 ? <ChartEmpty title="暂无可比较周期" detail="至少需要两期单值价格才会生成趋势线。" /> : <div className={styles.lineChart} aria-label={`${selectedMaterial}价格趋势`}><ResponsiveContainer width="100%" height="100%"><LineChart data={trend} accessibilityLayer margin={{ top: 8, right: 12, bottom: 4, left: 0 }}><CartesianGrid stroke="#edf0f1" vertical={false} /><XAxis dataKey="recordedAt" tickFormatter={shortDate} tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} width={44} /><Tooltip labelFormatter={(value) => formatPriceDate(String(value))} formatter={(value) => [price(String(value)), "最新价"]} /><Line type="monotone" dataKey="value" stroke="#2f3337" strokeWidth={2} dot={{ r: 3, fill: "#fff", strokeWidth: 2 }} activeDot={{ r: 4 }} /></LineChart></ResponsiveContainer></div>}
  </section>;
}

function TrendMaterialMenu({ materials, selected, onSelect }: { materials: ProcurementMaterial[]; selected: string; onSelect: (code: string) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const matches = materials.filter(item => item.code.toLowerCase().includes(query.trim().toLowerCase()));
  const close = (focus = false) => { if (menu.current) menu.current.open = false; if (focus) menu.current?.querySelector("summary")?.focus(); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return <details ref={menu} className={`${styles.columnMenu} ${styles.personMenu} ${styles.trendMaterialMenu}`} onToggle={event => { if (event.currentTarget.open) { setQuery(""); search.current?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (menu.current?.open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const options = Array.from(menu.current.querySelectorAll<HTMLButtonElement>("button[data-material-option]"));
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : index < 0 ? options.length - 1 : index - 1;
      if (next < 0) search.current?.focus(); else options[next]?.focus();
    }
  }}>
    <summary aria-label="选择趋势原料"><span>{selected || "选择原料"}</span><ChevronRight size={14} /></summary>
    <div>
      <label className={styles.trendMaterialSearch}><Search size={14} /><input ref={search} aria-label="搜索趋势原料编号" placeholder="搜索原料编号" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className={`${styles.filterGroup} ${styles.trendMaterialOptions}`}>
        {matches.map(item => <button key={item.id} data-material-option type="button" aria-pressed={selected === item.code} onClick={event => { event.preventDefault(); onSelect(item.code); close(true); }}>{item.code}{selected === item.code && <Check size={14} />}</button>)}
        {!matches.length && <p role="status">没有匹配的原料</p>}
      </div>
    </div>
  </details>;
}

function Dashboard({ data, moverHistory, newsCache, onOpenUpdate }: { data: ProcurementOverview; moverHistory: React.RefObject<MoverHistoryCache>; newsCache: React.RefObject<NewsData | null>; onOpenUpdate: () => void }) {
  const movement = buildPublishedPriceMovement(data.materials, data.batches[0]?.comparison);
  const editable = Boolean(data.capabilities?.can_edit) && (!data.current_update || ["draft", "returned"].includes(data.current_update.status));
  return <>
    <section className={styles.taskCard}>
      <div><span>价格更新提醒</span><h2>及时更新采购价格</h2><p>收到最新报价后，请及时更新原料台账。</p></div>
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
  return <section className={styles.dashboardPanel}>
        <div className={styles.panelHeading}><div><span>原料数量占比</span><h2>价格变动分布</h2></div><PriceDateRangeMenu label="分布日期范围" period={period} range={range} onChange={setPeriod} /></div>
        {failed ? <ChartEmpty title="价格分布读取失败" detail="请重新加载页面。" /> : history === null ? <ChartEmpty title="正在读取价格分布" detail="正在核对价格。" /> : !movement ? <ChartEmpty title="暂无价格版本统计" detail="所选截止日期之前没有价格版本。" /> : <><div className={styles.pieChart}><ResponsiveContainer width="100%" height="100%"><PieChart accessibilityLayer><Pie data={pieData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={72} paddingAngle={2}>{pieData.map((item) => <Cell key={item.name} fill={item.color} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer><strong>{movement.comparable}</strong><span>项可比较</span></div><div className={styles.chartLegend}>{pieData.map((item) => <span key={item.name} className={item.name === "持平" ? styles.stableText : undefined}><i style={{ background: item.color }} />{item.name}<strong>{item.value}</strong></span>)}</div></>}
      </section>;
}

function PriceMovers({ batches, cache }: { batches: ProcurementOverview["batches"]; cache: React.RefObject<MoverHistoryCache> }) {
  const [history, setHistory] = useState<ProcurementBatchDetail[] | null>(() => cache.current?.history ?? null);
  const historyKey = JSON.stringify(batches);
  const { period, range, setPeriod } = usePriceDateRange(batches);
  const rows = useMemo(() => history ? buildVersionMovers(history, { start: range.start, end: range.end }) : null, [history, range.start, range.end]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(0);
  const [instant, setInstant] = useState(true);
  const [previousPage, setPreviousPage] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const keyboardInteraction = useRef(false);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [hidden, setHidden] = useState(document.hidden);
  const [ranking, setRanking] = useState<"up" | "down">("up");
  const matchingRows = rows?.filter(row => ranking === "up" ? row.changePercent > 0 : row.changePercent < 0) ?? [];
  const rankedRows = matchingRows.slice(0, 30);
  const pages = Math.ceil(rankedRows.length / 10);
  const rotating = pages > 1 && !hovered && !focused && !reduced && !hidden;

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

  useEffect(() => {
    const pointer = () => { keyboardInteraction.current = false; setFocused(false); };
    const keyboard = () => { keyboardInteraction.current = true; };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(media.matches);
    const visibility = () => setHidden(document.hidden);
    media.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    return () => { media.removeEventListener("change", motion); document.removeEventListener("visibilitychange", visibility); document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", keyboard, true); };
  }, []);

  return <section className={`${styles.dashboardPanel} ${styles.moversPanel}`} aria-label="价格变动排行" aria-roledescription="轮播" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(keyboardInteraction.current)} onKeyDownCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className={styles.panelHeading}><div><span>区间涨跌幅</span><h2>价格变动排行</h2></div><div className={styles.moverActions}><PriceDateRangeMenu period={period} range={range} onChange={value => { setPeriod(value); setPage(0); setPreviousPage(null); setInstant(true); }} /><div className={styles.moverSwitch} role="group" aria-label="排行方向">{(["up", "down"] as const).map(value => <button key={value} type="button" aria-pressed={ranking === value} onClick={() => { setRanking(value); setPage(0); setPreviousPage(null); setInstant(true); }}>{value === "up" ? "涨幅" : "降幅"}</button>)}</div></div></div>
    {failed && history !== null && <p role="status">排行刷新失败，暂显示上次结果。<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {failed && history === null ? <div className={styles.chartEmpty}><strong>价格排行读取失败</strong><button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>重新加载</button></div> : rows === null ? <ChartEmpty title="正在读取价格排行" detail="正在核对各版本价格快照。" /> : !rankedRows.length ? <ChartEmpty title={ranking === "up" ? "暂无涨价原料" : "暂无降价原料"} detail="该范围内暂无符合条件的原料；缺少期初价格不参与排行。" /> : <>
      <div key={`${ranking}-${range.start}-${range.end}`} className={styles.moverPages} data-instant={instant || reduced} aria-live={rotating ? "off" : "polite"}>
        {Array.from({ length: pages }, (_, index) => <div key={index} data-active={page === index} data-retiring={previousPage === index} aria-hidden={page !== index} inert={page !== index} className={styles.moverList} role="group" aria-roledescription="排行页" aria-label={`第 ${index + 1} 页，共 ${pages} 页`}>
          {rankedRows.slice(index * 10, index * 10 + 10).map((row, rowIndex) => { const Icon = row.changePercent > 0 ? TrendingUp : TrendingDown; return <div key={`${row.batchId}-${row.materialId}`} style={{ transitionDelay: `${Math.floor(rowIndex / 2) * 30}ms` }}><Icon size={16} /><span><span className={styles.moverLine}><strong>{row.item.code}</strong><span className={styles.moverPrices} title={`比较日期：${formatPriceDate(row.previousDate)} → ${formatPriceDate(row.date)}`}><span>{price(row.previous)}</span><ArrowRight size={12} /><b>{price(row.item.latest_price)}</b><Movement value={row.changePercent} /></span></span><small className={styles.moverVersions}><span>v{row.version}</span>{" · "}<span>{formatPriceDate(row.date)}</span></small></span></div>; })}
        </div>)}
      </div>
      <footer className={styles.moverCaption}><span>本期{ranking === "up" ? "上涨" : "下降"} {matchingRows.length} 项</span>{pages > 1 && <div key={`${ranking}-${range.start}-${range.end}`} className={styles.moverControls} aria-label="排行分页" data-paused={!rotating} data-reduced={reduced}>
      {Array.from({ length: pages }, (_, index) => <button key={index} type="button" className={styles.moverDot} aria-label={`查看排行第 ${index + 1} 页`} aria-current={page === index ? "page" : undefined} title="每 8 秒切换，悬停暂停" onClick={event => { if (index !== page) { setInstant(event.detail === 0); setPreviousPage(page); setPage(index); } }} onAnimationEnd={() => { if (page === index && !reduced) { setInstant(false); setPreviousPage(index); setPage((index + 1) % pages); } }}><i /></button>)}
    </div>}</footer>
    </>}
  </section>;
}


function usePriceDateRange(batches: ProcurementOverview["batches"], defaultPeriod: "14d" | "1m" | "3m" = "14d") {
  const [period, setPeriod] = useState<"14d" | "1m" | "3m" | { start: string; end: string }>(defaultPeriod);
  const end = batches.map(batch => (batch.price_date || batch.published_at).slice(0, 10)).sort().at(-1) ?? today();
  const range = typeof period === "string" ? moverDateRange(end, period) : period;
  return { period, range, setPeriod };
}

function PriceDateRangeMenu({ period, range, onChange, label = "排行日期范围" }: {
  label?: string;
  period: "14d" | "1m" | "3m" | { start: string; end: string };
  range: { start: string; end: string };
  onChange: (value: "14d" | "1m" | "3m" | { start: string; end: string }) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState(range.start);
  const [end, setEnd] = useState(range.end);
  const labels = { "14d": "最近14天", "1m": "近一个月", "3m": "近三个月" };
  const close = (focus = false) => { if (menu.current) menu.current.open = false; if (focus) menu.current?.querySelector("summary")?.focus(); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const apply = (value: typeof period) => { onChange(value); close(true); };
  return <details ref={menu} className={`${styles.columnMenu} ${styles.filterMenu} ${styles.moverDateMenu}`} onToggle={event => { if (event.currentTarget.open) { setCustom(typeof period !== "string"); setStart(range.start); setEnd(range.end); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } }}>
    <summary aria-label={label} title={`${range.start} — ${range.end}`}><CalendarDays size={14} /><span>{typeof period === "string" ? labels[period] : "自定义日期"}</span><ChevronRight size={13} className={styles.moverDateChevron} /></summary>
    <div><div className={styles.filterGroup}>
      {(["14d", "1m", "3m"] as const).map(value => <button type="button" key={value} aria-pressed={period === value} onClick={event => { event.preventDefault(); apply(value); }}>{labels[value]}{period === value && <Check size={14} />}</button>)}
      <button type="button" aria-expanded={custom} onClick={() => setCustom(true)}>自定义范围{typeof period !== "string" && <Check size={14} />}</button>
    </div>
    {custom && <form className={styles.moverDateForm} onSubmit={event => { event.preventDefault(); if (start && end && start < end) apply({ start, end }); }}>
      <label>开始日期<input type="date" required value={start} max={end || undefined} onInput={event => setStart(event.currentTarget.value)} onChange={event => setStart(event.target.value)} /></label>
      <label>结束日期<input type="date" required value={end} min={start || undefined} onInput={event => setEnd(event.currentTarget.value)} onChange={event => setEnd(event.target.value)} /></label>
      {start && end && start >= end && <small role="alert">结束日期须晚于开始日期</small>}
      <button className="primary-button" type="submit" disabled={!start || !end || start >= end}>应用</button>
    </form>}
    </div>
  </details>;
}

function ChartEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className={styles.chartEmpty}><strong>{title}</strong><span>{detail}</span></div>;
}

const LEDGER_COLUMNS = [
  ["unit", "单位"], ["latest_price", "最新价格"], ["previous_latest_price", "上版价格"], ["change", "价格变化"],
  ["price_date", "价格日期"], ["modifier", "修改人"], ["status", "状态"], ["in_transit_price", "在途价"], ["inventory_price", "库存价"], ["suggested_price", "建议价"],
] as const;
const MATERIAL_COLUMN_WIDTH = 240;
const LEDGER_COLUMN_WIDTHS: Record<string, number> = {
  unit: 72,
  latest_price: 112,
  previous_latest_price: 112,
  change: 120,
  price_date: 132,
  modifier: 120,
  status: 90,
  in_transit_price: 112,
  inventory_price: 112,
  suggested_price: 112,
};
const DEFAULT_PREFERENCES: ProcurementPreferences = {
  ledger_columns: LEDGER_COLUMNS.slice(0, 7).map(([id]) => id),
  history_view: "batches",
  ledger_view: "paged",
  ledger_page_size: 50,
};

function Materials({ data, accessLevel, onRefresh, onSaved, onCreate, onImport, onPublish, onPageChange, focusPending, locateCode, startInEdit, onEditStarted }: { startInEdit: boolean; onEditStarted: () => void; data: ProcurementOverview; accessLevel: number; onRefresh: () => Promise<void>; onSaved: (data: ProcurementOverview) => void; onCreate: () => void; onImport: () => void; onPublish: () => void; onPageChange: (page: ProcurementPage) => void; focusPending: boolean; locateCode: string }) {
  const { preferences, update: savePreferences } = useProcurementPreferences();
  const current = data.current_update;
  const [query, setQuery] = useState("");
  const [movement, setMovement] = useState("all");
  const [editor, setEditor] = useState("");
  const editors = data.editors ?? [];
  const [scope, setScope] = useState("all");
  const [sort, setSort] = useState("change");
  const [sortDirection, setSortDirection] = useState<"ascending" | "descending">("descending");
  const [filterNotice, setFilterNotice] = useState("");
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismissMenus = (event: PointerEvent) => {
      toolbar.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => {
        if (!menu.contains(event.target as Node)) menu.open = false;
      });
      const more = moreButton.current?.closest("details");
      if (more && !more.contains(event.target as Node)) more.open = false;
    };
    document.addEventListener("pointerdown", dismissMenus, true);
    return () => document.removeEventListener("pointerdown", dismissMenus, true);
  }, []);
  const [page, setPage] = useState(1);
  const [pageSizeInput, setPageSizeInput] = useState("50");
  const [selected, setSelected] = useState<string | null>(null);
  const [newPrice, setNewPrice] = useState(false);
  const [edit, setEdit] = useState<{ update_id: string | null; updated_at: string | null; originals: Record<string, string>; order: string[]; sort: string; sortDirection: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [editDate, setEditDate] = useState("");
  const [editReason, setEditReason] = useState<ReasonSelection>({ selected: "", custom: "" });
  const [editError, setEditError] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const saveDialog = useRef<HTMLDialogElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<"events" | null>(null);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [panelError, setPanelError] = useState("");
  const moreButton = useRef<HTMLElement | null>(null);
  const cancelRoundButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setCancelArmed(false); }, [current?.id, current?.updated_at, edit, data.capabilities?.can_cancel_round]);
  const savingRef = useRef(false);
  const edits = collectPriceEdits(values, edit?.originals ?? {});
  const dirty = edits.length > 0;
  const validEdits = edits.every(item => /^\d+(\.\d+)?$/.test(item.price));
  const pricePreview = usePricePreview(saveOpen, editDate, edits);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [reviewReasons, setReviewReasons] = useState<Record<string, ReasonSelection>>({});
  const [reviewError, setReviewError] = useState("");
  const [busy, setBusy] = useState(false);
  const [workColumns, setWorkColumns] = useState<{ id: string; columns: string[] } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const canEdit = Boolean(data.capabilities?.can_edit) && (!current || ["draft", "returned"].includes(current.status));
  const canConfirm = Boolean(data.capabilities?.can_activate) && Boolean(current && ["draft", "returned", "submitted", "revalidation_required"].includes(current.status));
  const allRows = buildLedgerRows(data.materials, current);
  const errors = allRows.filter(row => row.missing).length;
  const risks = allRows.filter(row => row.risk?.status === "open").length;
  const formalComparison = [...data.batches].sort((a, b) => b.version - a.version)[0]?.comparison;
  const formalChange = (item: ProcurementMaterial) => formalLedgerChange(item, formalComparison);
  const pending = new Set(allRows.filter(row => row.pending).map(row => row.material.id));
  const selectedPerson = editors.find(person => person.id === editor)?.name ?? "";
  const rows = filterLedgerRows(allRows, { query, movement, scope, editor, selectedPerson, current, comparison: formalComparison, sort, sortDirection, edit, values });
  const columnOptions: ReadonlyArray<readonly [string, string]> = current || edit ? [...LEDGER_COLUMNS.map(([id, label]) => [id, id === "status" ? "处理状态" : label] as const), ["draft_price", "待发布价"]] : LEDGER_COLUMNS;
  const savedColumns = current ? workColumns?.id === current.id ? workColumns.columns : ["unit", "latest_price", "draft_price", "change", "modifier", "status"] : preferences?.ledger_columns ?? DEFAULT_PREFERENCES.ledger_columns;
  const columns = edit ? Array.from(new Set(["unit", "latest_price", "draft_price", ...savedColumns])) : savedColumns;
  const ledgerView = preferences?.ledger_view ?? DEFAULT_PREFERENCES.ledger_view;
  const pageSize = preferences?.ledger_page_size ?? DEFAULT_PREFERENCES.ledger_page_size;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleRows = ledgerView === "paged" ? rows.slice((safePage - 1) * pageSize, safePage * pageSize) : rows;
  const activeFilterCount = Number(movement !== "all") + Number(scope !== "all");
  const columnWidth = (id: string) => current && id === "status" ? 150 : current && id === "change" ? 178 : LEDGER_COLUMN_WIDTHS[id] ?? 112;
  const tableWidth = MATERIAL_COLUMN_WIDTH + columns.reduce((total, id) => total + columnWidth(id), 0);

  useEffect(() => { setPage(1); }, [query, editor, movement, scope, sort, sortDirection, pageSize]);
  useEffect(() => {
    setEdit(previous => previous ? { ...previous, order: [...new Set([...rows, ...allRows].map(row => row.material.id))], sort, sortDirection } : previous);
  }, [sort, sortDirection]);
  useEffect(() => { setPageSizeInput(String(pageSize)); }, [pageSize]);
  useEffect(() => {
    setScope(focusPending ? "involved" : "all"); setMovement("all"); setQuery("");
    if (focusPending) summary.current?.scrollIntoView({ block: "nearest" });
  }, [focusPending]);
  useEffect(() => { setExpanded(null); setReviewReasons({}); setReviewError(""); if (!current && scope !== "all") { setScope("all"); setFilterNotice("本轮已结束，已恢复全部原料"); } }, [current?.id]);
  useEffect(() => { if (locateCode) { setQuery(locateCode); searchInput.current?.focus(); } }, [locateCode]);

  useEffect(() => { if (sort !== "code" && !columns.includes(sort)) { setSort("code"); setSortDirection("ascending"); } }, [columns.join("|"), sort]);
  const movementLabels: Record<string, string> = { all: "全部", up: "上涨", down: "下降", flat: "持平", missing: "未定价", incomparable: "不可比较" };
  const scopeLabels: Record<string, string> = { all: "全部原料", involved: "本轮已录入", missing: "待补价", risk: "待确认" };
  const sortHeader = (id: string, label: string) => {
    if (id === "change" && edit) label = "本次变化";
    const sortable = ["code", "latest_price", "previous_latest_price", "change", "price_date", "draft_price"].includes(id);
    return <th data-column={id === "code" ? "identity" : id} key={id} aria-sort={sortable && sort === id ? sortDirection : undefined}>
      {sortable ? <button className={styles.sortHeading} type="button" onClick={() => { setSort(id); setSortDirection(sort === id ? sortDirection === "ascending" ? "descending" : "ascending" : id === "code" ? "ascending" : "descending"); }}>{label}{sort === id && (sortDirection === "ascending" ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}</button> : label}
      {id === "change" && <button type="button" className={styles.comparisonInfo} aria-label={edit ? "本次变化：待发布价与最新价格比较" : current ? "价格变化：待发布价与最新价格比较；未录入项显示版本变化" : "价格变化：最新价格与上一版本比较"} title={edit ? "待发布价与最新价格比较" : current ? "待发布价与最新价格比较；未录入项显示版本变化" : "最新价格与上一版本比较"}><Info size={14} /></button>}
    </th>;
  };

  const setPageSize = (value: number) => {
    const next = Math.min(200, Math.max(10, value));
    setPageSizeInput(String(next)); void savePreferences({ ledger_page_size: next });
  };
  const applyCustomPageSize = () => {
    const value = Number(pageSizeInput);
    if (Number.isFinite(value)) setPageSize(value); else setPageSizeInput(String(pageSize));
  };
  const filterTasks = (next: string) => { setScope(next); setQuery(""); setMovement("all");  setPage(1); };
  const openMaterial = (id: string, editing = false) => { if (edit) return; setNewPrice(editing); setSelected(id); };
  const startEditing = () => {
    if (!canEdit || edit) return;
    setEdit({ update_id: current?.id ?? null, updated_at: current?.updated_at ?? null, originals: Object.fromEntries((current?.input_items ?? []).map(item => [item.material_id, item.draft_price ?? ""])), order: [...new Set([...rows, ...allRows].map(row => row.material.id))], sort, sortDirection });
    setEditDate(current?.price_date ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
    setValues({}); setEditError(""); setEditReason({ selected: "", custom: "" }); setExpanded(null);
  };
  useEffect(() => {
    if (!startInEdit) return;
    startEditing();
    onEditStarted();
  }, [startInEdit]);
  const stopEditing = () => { if (!dirty || window.confirm("放弃尚未保存的价格修改？")) { setEdit(null); setValues({}); setEditError(""); } };
  useEffect(() => {
    if (!dirty && !busy) return;
    const leave = (event: Event) => { if (busy || !window.confirm("价格修改尚未保存，确定离开并放弃修改？")) event.preventDefault(); };
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("procurement-before-leave", leave);
    window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener("procurement-before-leave", leave); window.removeEventListener("beforeunload", unload); };
  }, [dirty, busy]);
  const saveEdits = async () => {
    if (!edit || savingRef.current || !dirty || !validEdits || !editDate || !resolveReason(editReason) || !pricePreview.data) return;
    savingRef.current = true; setBusy(true); setEditError("");
    try {
      const result = await bulkAdjustProcurementPrices({ update_id: edit.update_id, updated_at: edit.updated_at, effective_date: editDate, reason: resolveReason(editReason), items: edits, ...(data.capabilities?.can_activate ? { price_confirmation: { baseline_id: pricePreview.data.baseline_id, references: Object.fromEntries(pricePreview.data.rows.map(row => [row.material_id, row.reference_price])) } } : {}) });
      onSaved(result); setSaveOpen(false); setEdit(null); setValues({});
    } catch (error) { setEditError(error instanceof Error ? error.message : "保存失败，输入已保留。"); pricePreview.refresh(); }
    finally { savingRef.current = false; setBusy(false); }
  };
  useEffect(() => { if (saveOpen) saveDialog.current?.showModal(); }, [saveOpen]);
  const closeSave = () => {
    if (busy) return;
    setSaveOpen(false);
    window.requestAnimationFrame(() => saveButton.current?.focus({ preventScroll: true }));
  };
  const closePanel = () => { if (busy) return; setPanel(null); window.requestAnimationFrame(() => moreButton.current?.focus({ preventScroll: true })); };
  const cancelRound = async () => {
    if (!current || savingRef.current || !cancelArmed || !data.capabilities?.can_cancel_round) return;
    savingRef.current = true; setBusy(true); setPanelError("");
    try { onSaved(await cancelProcurementUpdate(current.id, "用户确认取消本轮")); }
    catch (error) { setPanelError(error instanceof Error ? error.message : "取消失败，请重试。"); }
    finally { savingRef.current = false; setBusy(false); setCancelArmed(false); }
  };
  const toggleRow = (id: string) => {
    setExpanded(value => value === id ? null : id); setReviewError("");
    if (expanded !== id) window.requestAnimationFrame(() => document.getElementById(`ledger-review-${id}`)?.querySelector<HTMLSelectElement>("select")?.focus());
  };
  const review = async (issueId: string, materialId: string) => {
    const reason = resolveReason(reviewReasons[issueId]);
    if (!current || !reason || busy) return;
    setBusy(true); setReviewError("");
    try {
      await reviewProcurementIssue(current.id, issueId, reason, current.updated_at);
      await onRefresh(); setExpanded(null);
      window.requestAnimationFrame(() => document.getElementById(`ledger-material-${materialId}`)?.focus());
    } catch (failure) { setReviewError(failure instanceof Error ? failure.message : "确认失败，请重试。"); }
    finally { setBusy(false); }
  };

  return <section className={`${styles.section} ${styles.ledgerSection}`}>
    <div className={`${styles.sectionHeading} ${styles.ledgerHeading}`}>
      <div><div className={styles.ledgerTitle}><h2>原料台账</h2><small>{rows.length} / {data.materials.length} 条</small></div><p className={styles.sectionDescription}>在台账内编辑价格，或导入报表批量更新；启用前，最新价格保持不变。</p></div>
      <div className={styles.ledgerActions}>
        {canEdit && edit && <><button ref={saveButton} className="primary-button" type="button" disabled={busy || !dirty || !validEdits} onClick={() => setSaveOpen(true)}>保存修改{dirty ? `（${edits.length}）` : ""}</button><button className="secondary-button" type="button" disabled={busy} onClick={stopEditing}>取消编辑</button></>}
        {!edit && <>{canEdit && <button className={current ? "secondary-button" : "primary-button"} type="button" onClick={startEditing}><Pencil size={14} />编辑价格</button>}{!current && data.capabilities?.can_manage_catalog && <button className="secondary-button" type="button" onClick={onCreate}><Plus size={14} />新增原料</button>}{!current && canEdit && <button className="secondary-button" type="button" onClick={onImport}><FileUp size={14} />导入报表</button>}</>}
        {current && !edit && <div className={styles.ledgerRoundActions} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) moreButton.current?.closest("details")?.removeAttribute("open"); }} onKeyDown={event => { if (event.key === "Escape") { moreButton.current?.closest("details")?.removeAttribute("open"); moreButton.current?.focus(); } }}>
          <details className={`${styles.columnMenu} ${styles.ledgerMore}`}><summary aria-label="更多操作" title="更多操作" ref={node => { moreButton.current = node; }}><Ellipsis size={18} aria-hidden="true" /></summary><div>{data.capabilities?.can_manage_catalog && <button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onCreate(); }}>新增原料</button>}{canEdit && <button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onImport(); }}>导入报表</button>}<button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setPanel("events"); }}>操作记录</button></div></details>
        </div>}
      </div>
    </div>
    {panelError && <p className={styles.error} role="alert">{panelError}</p>}
    <div className={styles.ledgerEditHint} data-open={Boolean(edit)} aria-hidden={!edit}><div><div className={styles.ledgerEditBar}><small>已修改 {edits.length} 项 · 保存包含其他页的修改；清空输入仅撤回本次修改。</small></div></div></div>
    {edit && saveOpen && <dialog ref={saveDialog} className={`${styles.confirmDialog} ${styles.saveDialog}`} aria-labelledby="ledger-save-title" onCancel={event => { event.preventDefault(); closeSave(); }}>
      <form onSubmit={event => { event.preventDefault(); void saveEdits(); }}>
        <div className={styles.panelHeading}><h2 id="ledger-save-title">保存价格修改</h2><button className="icon-button" type="button" aria-label="关闭保存确认" disabled={busy} onClick={closeSave}><X size={17} /></button></div>
        <p>本次修改 {edits.length} 项原料，保存后待启用。</p>
        <div className={styles.ledgerEditBar}>
          {edit.update_id ? <div className={styles.savedPriceDate}><span>价格日期</span><strong>{formatPriceDate(editDate)}</strong><small>沿用本轮日期</small></div> : <label>价格日期<input type="date" required value={editDate} disabled={busy} onChange={event => setEditDate(event.target.value)} /></label>}
        </div>
        {pricePreview.data ? <PriceReview preview={pricePreview.data} /> : <p>{pricePreview.error ?? "正在核对价格变化…"}{pricePreview.error && <button type="button" onClick={pricePreview.refresh}>重新核对</button>}</p>}
        <div className={styles.ledgerEditBar}><label>录价说明<ReasonSelect label="录价说明" options={PRICE_REASONS} placeholder="请选择说明" value={editReason} disabled={busy} onChange={setEditReason} /></label></div>
        <p>{data.capabilities?.can_activate ? "确认并保存将同时确认以上高波动价格；启用前，最新价格保持不变。" : "保存后，最新价格保持不变；异常波动由有启用权的人员确认。"}</p>
        {editError && <div className={styles.error} role="alert"><p>{editError}</p><button type="button" disabled={busy} onClick={async () => {try {const fresh = await fetchProcurementOverview(); onSaved(fresh); setEdit(old => old ? {...old, update_id: fresh.current_update?.id ?? null, updated_at: fresh.current_update?.updated_at ?? null} : null); if (fresh.current_update) setEditDate(fresh.current_update.price_date); pricePreview.refresh(); setEditError("已读取最新版本，输入已保留。请核对后重新保存。");} catch(e){setEditError((e as Error).message);}}}>读取最新数据核对（保留输入）</button></div>}
        <div className={styles.panelActions}><button className="secondary-button" type="button" disabled={busy} onClick={closeSave}>返回编辑</button><button className="primary-button" type="submit" disabled={busy || !dirty || !validEdits || !editDate || !resolveReason(editReason) || !pricePreview.data}>{busy ? "正在保存" : "确认并保存"}</button></div>
      </form>
    </dialog>}
    {data.scheduled_update && <div className={styles.ledgerSchedule}><Clock3 size={15} /><span>等待启用：{formatPriceDate(data.scheduled_update.price_date)} · {formatShanghaiDateTime(data.scheduled_update.activate_at)}，最新价格未改变。</span><button type="button" disabled={Boolean(edit)} onClick={() => onPageChange("batches")}>查看排期</button></div>}
    {current && !edit && <div ref={summary} className={styles.ledgerUpdate} aria-label="本轮更新摘要">
      <div><strong>本轮更新 · {formatPriceDate(current.price_date)}</strong><small>{current.source_name} · {current.status === "revalidation_required" ? "需要重新确认，原排期不会自动启用" : updateStatusLabel(current.status)}</small></div>
      <div className={styles.ledgerTaskCounts}><button type="button" onClick={() => filterTasks("involved")}>{current.input_items.length} 项涉及</button>{errors > 0 && <button type="button" onClick={() => filterTasks("missing")}>{errors} 项待补价</button>}{risks > 0 && <button type="button" onClick={() => filterTasks("risk")}>{risks} 项待确认</button>}</div>
      <small id="ledger-enable-status" className={styles.ledgerEnable}>{errors || risks ? `还需处理 ${errors} 项补价、${risks} 项波动确认` : canConfirm ? <><Check size={14} aria-hidden="true" />价格问题已处理</> : "等待有启用权的人员启用价格"}</small>
      {canConfirm && <button className="primary-button" type="button" disabled={busy || errors > 0 || risks > 0} aria-describedby="ledger-enable-status" onClick={onPublish}><PackageCheck size={14} />启用价格</button>}
      {data.capabilities?.can_cancel_round && <button ref={cancelRoundButton} className={`secondary-button ${cancelArmed ? styles.cancelArmed : ""}`} type="button" disabled={busy} onBlur={() => setCancelArmed(false)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setCancelArmed(false); } }} onClick={() => { if (cancelArmed) void cancelRound(); else { setPanelError(""); setCancelArmed(true); } }}>{busy && cancelArmed ? "正在取消…" : cancelArmed ? "确认取消" : "取消更新"}</button>}
    </div>}
    <div className={styles.ledgerTableFrame}>
    <div ref={toolbar} className={styles.toolbar} onBlur={event => { event.currentTarget.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => { if (!menu.contains(event.relatedTarget)) menu.open = false; }); }} onKeyDown={event => { if (event.key === "Escape") { const menu = (event.target as HTMLElement).closest("details"); menu?.removeAttribute("open"); menu?.querySelector("summary")?.focus(); } }}>
      <label className={styles.searchField}><Search size={15} /><input ref={searchInput} aria-label="搜索原料" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索原料编号" /></label>
      <details className={`${styles.columnMenu} ${styles.personMenu}`}><summary aria-label="人员">{selectedPerson || "全部人员"}<ChevronRight size={14} /></summary><div>{[{id: "", name: "全部人员"}, ...editors].map(person => <button type="button" key={person.id} aria-pressed={editor === person.id} onClick={event => { setEditor(person.id); const menu = event.currentTarget.closest("details"); menu?.removeAttribute("open"); menu?.querySelector("summary")?.focus(); }}>{person.name}{editor === person.id && <Check size={14} />}</button>)}</div></details>
      <details className={`${styles.columnMenu} ${styles.filterMenu}`}><summary><SlidersHorizontal size={14} />筛选{activeFilterCount > 0 && <em>{activeFilterCount}</em>}</summary><div>
        {[{title: "价格", value: movement, labels: movementLabels, select: setMovement}, ...(current ? [{title: "待发布更新", value: scope, labels: scopeLabels, select: setScope}] : [])].map(group => <section className={styles.filterGroup} key={group.title} aria-label={group.title}><span>{group.title}</span>{Object.entries(group.labels).map(([value, label]) => <button type="button" key={value} aria-pressed={group.value === value} onClick={event => { group.select(value); const menu = event.currentTarget.closest("details"); menu?.removeAttribute("open"); menu?.querySelector("summary")?.focus(); }}>{label}{group.value === value && <Check size={14} />}</button>)}</section>)}
      </div></details>
      <details className={`${styles.columnMenu} ${styles.displayMenu}`}><summary><Columns3 size={14} />显示</summary><div>
        <span className={styles.menuLabel}>显示列{current ? " · 本轮临时设置" : ""}</span>
        <div className={styles.columnGrid}>{columnOptions.map(([id, label]) => <label key={id}><input type="checkbox" checked={columns.includes(id)} disabled={Boolean(edit) || Boolean(current && ["latest_price", "status"].includes(id))} onChange={() => { const next = columns.includes(id) ? columns.filter(item => item !== id) : [...columns, id]; if (next.length) { if (current) setWorkColumns({ id: current.id, columns: next }); else void savePreferences({ ledger_columns: next }); } }} />{label}</label>)}</div>
        <span className={styles.menuLabel}>浏览方式</span>
        <div className={styles.ledgerMode} role="group" aria-label="台账查看模式"><button type="button" aria-pressed={ledgerView === "scroll"} onClick={() => void savePreferences({ ledger_view: "scroll" })}>连续</button><button type="button" aria-pressed={ledgerView === "paged"} onClick={() => void savePreferences({ ledger_view: "paged" })}>分页</button></div>
        {ledgerView === "paged" && <><span className={styles.menuLabel}>每页条数</span><div className={styles.pageSizeControl}>{[25, 50, 100].map(size => <button key={size} type="button" aria-pressed={pageSize === size} onClick={() => setPageSize(size)}>{size}</button>)}<input aria-label="自定义每页条目数" type="number" min="10" max="200" value={pageSizeInput} onChange={(event) => setPageSizeInput(event.target.value)} onBlur={applyCustomPageSize} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div></>}
      </div></details>
    </div>
    {(editor || activeFilterCount > 0) && <div className={styles.filterTags}>
      {editor && <span>人员：{selectedPerson}<button type="button" aria-label="清除人员筛选" onClick={() => setEditor("")}><X size={13} /></button></span>}
      {movement !== "all" && <span>价格 · {movementLabels[movement]}<button type="button" aria-label="清除价格筛选" onClick={() => setMovement("all")}><X size={13} /></button></span>}
      {current && scope !== "all" && <span>待发布 · {scopeLabels[scope]}<button type="button" aria-label="清除待发布筛选" onClick={() => setScope("all")}><X size={13} /></button></span>}
      <button className={styles.clearFilters} type="button" onClick={() => { setEditor(""); setMovement("all"); setScope("all"); }}>清除筛选</button>
    </div>}
    {filterNotice && <div role="status" className={styles.comparisonHelp}>{filterNotice}<button type="button" aria-label="关闭筛选提示" onClick={() => setFilterNotice("")}><X size={13} /></button></div>}
    {!rows.length ? <Empty title={editor && current && scope !== "all" ? "该人员暂无符合条件的待发布修改" : "没有符合条件的原料"} detail="可调整筛选条件或清除筛选。" /> : <div className={`${styles.tableWrap} ${styles.ledgerTableWrap}`}><table className={`${styles.table} ${styles.stickyTable} ${styles.decisionTable}`} style={{ minWidth: `${tableWidth}px` }}><colgroup><col style={{ width: MATERIAL_COLUMN_WIDTH }} />{columns.map(id => <col key={id} style={{ width: columnWidth(id) }} />)}</colgroup><thead><tr>{sortHeader("code", "原料编号")}{columns.map(id => sortHeader(id, columnOptions.find(([column]) => column === id)?.[1] ?? id))}</tr></thead><tbody>{visibleRows.map(row => {
      const { material: item, input, risk } = row;
      const change = edit ? draftLedgerChange(item, values[item.id] ?? edit.originals[item.id] ?? "", formalComparison) : input ? draftLedgerChange(item, input.draft_price ?? "", formalComparison) : formalChange(item);
      return <Fragment key={item.id}>
        <tr><td data-column="identity"><button id={`ledger-material-${item.id}`} className={styles.materialLink} type="button" disabled={Boolean(edit)} onClick={() => openMaterial(item.id)}><span><strong title={item.code}>{item.code}</strong></span><ChevronRight size={16} aria-hidden="true" /></button></td>{columns.map(id => <td data-column={id} key={id}>{
          edit && id === "draft_price" ? <input className={styles.ledgerPriceInput} aria-label={`${item.code}待发布价`} inputMode="decimal" disabled={busy} value={values[item.id] ?? edit.originals[item.id] ?? ""} placeholder="未调整" aria-invalid={Boolean(values[item.id]?.trim() && !/^\d+(\.\d+)?$/.test(values[item.id].trim()))} onChange={event => setValues(previous => ({ ...previous, [item.id]: event.target.value }))} onBlur={() => { if (values[item.id] === "") setValues(previous => { const next = { ...previous }; delete next[item.id]; return next; }); }} /> :
          current && id === "draft_price" ? input ? <strong>{input.draft_price == null ? "缺价" : price(input.draft_price)}</strong> : "—" :
          current && id === "status" ? <div className={styles.ledgerRowActions}>{edit ? <span>{row.state}</span> : row.missing ? canEdit ? <button className="secondary-button" type="button" onClick={() => openMaterial(item.id, true)}>补录价格</button> : <span>待补价</span> : risk ? <><span className={risk.status === "reviewed" ? undefined : styles.riskText}>{risk.status === "reviewed" ? "已确认" : "待确认"}</span><button className={styles.ledgerTextAction} type="button" disabled={busy} aria-expanded={expanded === item.id} aria-controls={`ledger-review-${item.id}`} onClick={() => toggleRow(item.id)}>{risk.status === "reviewed" ? "查看依据" : canConfirm ? "确认波动" : "查看波动"}</button></> : <span className={input ? undefined : styles.baselineEmpty}>{row.state}</span>}</div> :
          id === "change" ? typeof change === "string" ? <span>{change}</span> : <Movement value={change} /> : ledgerCell(item, id, pending.has(item.id))
        }</td>)}</tr>
        {current && expanded === item.id && risk && <tr className={styles.ledgerReviewRow}><td colSpan={columns.length + 1}><div id={`ledger-review-${item.id}`} className={styles.ledgerReview} role="region" aria-label={`${item.code}价格波动确认`}>{risk.status === "reviewed" ? <div className={styles.ledgerReviewCopy}><strong>已确认价格波动</strong><p>确认依据：{risk.review_reason}</p></div> : canConfirm ? <><div className={styles.reviewControl}><ReasonSelect label={`${item.code}确认依据`} options={REVIEW_REASONS} placeholder="请选择确认依据" value={reviewReasons[risk.id]} disabled={busy} onChange={value => setReviewReasons(reasons => ({ ...reasons, [risk.id]: value }))} /><button type="button" disabled={busy || !resolveReason(reviewReasons[risk.id])} onClick={() => void review(risk.id, item.id)}>{busy ? "正在确认" : "确认波动"}</button></div>{reviewError && <p className={styles.error} role="alert">{reviewError}</p>}</> : <p>等待采购员确认。</p>}<button className={styles.ledgerTextAction} type="button" disabled={busy} onClick={() => { setExpanded(null); document.getElementById(`ledger-material-${item.id}`)?.focus(); }}>收起</button></div></td></tr>}
      </Fragment>;
    })}</tbody></table></div>}
    {ledgerView === "paged" && rows.length > 0 && <div className={styles.paginationBar}><span>{(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, rows.length)} / {rows.length} 条</span><div className={styles.pageNavigation}><button type="button" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={14} />上一页</button><span>第 {safePage} / {pageCount} 页</span><button type="button" disabled={safePage === pageCount} onClick={() => setPage(safePage + 1)}>下一页<ChevronRight size={14} /></button></div></div>}
    </div>
    {current && panel && <LedgerPanel title="本轮操作记录" busy={busy} onClose={closePanel}>
      <p>{formatPriceDate(current.price_date)} · {current.input_items.length} 项原料</p>
      <LedgerOperationRecords update={current} />
    </LedgerPanel>}
    {selected && <MaterialDrawer materialId={selected} canEdit={canEdit} canManage={Boolean(data.capabilities?.can_manage_catalog)} currentPriceDate={current?.price_date} startWithNewPrice={newPrice} onClose={() => { const id=selected; setSelected(null); requestAnimationFrame(()=>document.getElementById(`ledger-material-${id}`)?.focus()); }} onChanged={() => { setSelected(null); void onRefresh(); }} />}
  </section>;
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
        <label className={styles.materialCreateField}>原料价格<span className={styles.materialPriceField}><input inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" disabled={busy} value={amount} onChange={event => setAmount(event.target.value)} placeholder="选填，留空为未定价" /><small>元/kg</small></span><span className={styles.materialCreateHint}>保存为待发布价</span></label>
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

function LedgerPanel({ title, busy, onClose, children, fixedBody = false }: { fixedBody?: boolean; title: string; busy: boolean; onClose: () => void; children: React.ReactNode }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  return <div className={`${styles.drawerLayer} ${styles.ledgerPanelLayer}`} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><aside className={styles.drawer} role="dialog" aria-modal="true" aria-label={title}><header className={styles.drawerHeader}><h2>{title}</h2><button ref={closeButton} disabled={busy} className="icon-button" type="button" aria-label="关闭本轮面板" onClick={onClose}><X size={17} /></button></header><div className={`${styles.drawerBody} ${styles.ledgerPanelBody}`} tabIndex={0}>{children}</div></aside></div>;
}

function ledgerCell(item: ProcurementMaterial, column: string, pending: boolean) {
  if (column === "modifier") {
    const modifier = item.price_modifier;
    return modifier?.name ? <span className={styles.modifierCell}><span>{modifier.name}</span>{(item.round_participants?.length ?? 0) > 1 && <details><summary>本轮 {item.round_participants?.length} 人</summary><small>{item.round_participants?.map(person => person.name).join("、")}</small></details>}</span> : !modifier && item.published_price == null && item.source_purchasers?.length ? <span className={styles.modifierCell}>{item.source_purchasers.join("、")}</span> : "未记录";
  }
  if (column === "unit") return item.unit;
  if (column === "latest_price") return item.published_price == null ? "—" : <strong>{price(item.published_price)}</strong>;
  if (column === "previous_latest_price") return item.previous_published_price == null ? "—" : <strong>{price(item.previous_published_price)}</strong>;
  if (column === "change") return item.published_price == null ? "—" : <span className={styles.updateChange}><Movement value={materialChange(item)} /></span>;
  if (column === "price_date") return item.published_price_date ? formatPriceDate(item.published_price_date) : "—";
  if (column === "status") return <span className={`${styles.statusPill} ${pending ? styles.statusPending : item.published_price == null ? styles.statusMissing : styles.statusOk}`}>{pending ? "待处理" : item.published_price == null ? "未定价" : "有效"}</span>;
  if (column === "in_transit_price") return price(item.in_transit_price);
  if (column === "inventory_price") return price(item.inventory_price);
  return price(item.suggested_price);
}


function useProcurementPreferences() {
  const [preferences, setPreferences] = useState<ProcurementPreferences | null>(null);
  useEffect(() => { const controller = new AbortController(); fetchProcurementPreferences(controller.signal).then(setPreferences).catch(() => undefined); return () => controller.abort(); }, []);
  const update = async (next: Partial<ProcurementPreferences>) => setPreferences(await saveProcurementPreferences({ ...(preferences ?? DEFAULT_PREFERENCES), ...next }));
  return { preferences, update };
}

function ReasonSelect({ label, options, placeholder, value = { selected: "", custom: "" }, disabled, onChange }: { label: string; options: string[]; placeholder: string; value?: ReasonSelection; disabled: boolean; onChange: (value: ReasonSelection) => void }) {
  const otherLabel = options === PRICE_REASONS ? "其他说明" : "其他原因";
  return <div className={styles.reasonSelect}>
    <select aria-label={label} disabled={disabled} value={value.selected} onChange={(event) => onChange({ ...value, selected: event.target.value })}>
      <option value="" disabled>{placeholder}</option>
      {options.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
      <option value="other">{otherLabel}</option>
    </select>
    {value.selected === "other" && <input aria-label={`${label}${otherLabel}`} disabled={disabled} minLength={4} maxLength={200} value={value.custom} onChange={(event) => onChange({ ...value, custom: event.target.value })} placeholder={`请填写${otherLabel}（4–200 字）`} />}
  </div>;
}

function MaterialDrawer({ materialId, canEdit, canManage, onClose, onChanged, currentPriceDate, startWithNewPrice = false }: { materialId: string; canEdit: boolean; canManage: boolean; onClose: () => void; onChanged?: () => void; currentPriceDate?: string; startWithNewPrice?: boolean }) {
  const [detail, setDetail] = useState<ProcurementMaterialDetail | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState<string | null>(startWithNewPrice ? "new" : null);
  const [identityStep, setIdentityStep] = useState<"edit" | "confirm" | null>(null);
  const [discardTarget, setDiscardTarget] = useState<"panel" | "drawer" | null>(null);
  const [identityCode, setIdentityCode] = useState("");
  const [panelClosing, setPanelClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [priceValue, setPriceValue] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(() => currentPriceDate ?? today());
  const [reason, setReason] = useState<ReasonSelection>({ selected: "", custom: "" });
  const [error, setError] = useState("");
  const dateInput = useRef<HTMLInputElement>(null);
  const load = useCallback((signal?: AbortSignal) => {
    setLoadState("loading");
    return fetchProcurementMaterial(materialId, signal)
      .then((value) => { setDetail(value); setLoadState("ready"); })
      .catch((failure: unknown) => {
        if (!(failure instanceof DOMException && failure.name === "AbortError")) setLoadState("error");
      });
  }, [materialId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  const unsaved = identityStep ? Boolean(detail && identityCode.trim() !== detail.material.code) : Boolean(priceValue);
  const close = (discard = false) => { if (closing || saving) return; if (unsaved && !discard) { setDiscardTarget("drawer"); return; } setDiscardTarget(null); setClosing(true); window.setTimeout(onClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140); };
  const closePanel = (saved = false) => {
    if (panelClosing || (!saved && saving)) return;
    if (!saved && unsaved) { setDiscardTarget("panel"); return; }
    setDiscardTarget(null);
    setPanelClosing(true);
    window.setTimeout(() => { setEditing(null); setIdentityStep(null); setPriceValue(""); setPanelClosing(false); setError(""); }, 140);
  };
  const startEdit = (id: string | null, value?: string | null, dateValue?: string) => {
    setIdentityStep(null); setEditing(id ?? "new"); setPanelClosing(false); setPriceValue(value ?? ""); setEffectiveDate(dateValue ?? currentPriceDate ?? today()); setReason({ selected: "", custom: "" }); setError("");
  };
  const startIdentityEdit = () => {
    if (!detail) return;
    setEditing(null); setIdentityStep("edit"); setPanelClosing(false); setIdentityCode(detail.material.code); setError("");
  };
  const save = async () => {
    if (saving || !resolveReason(reason) || !pricePreview.data) return;
    setError(""); setSaving(true);
    try {
      if (!detail) return;
      await adjustProcurementPrice(materialId, { price: priceValue, effective_date: effectiveDate, reason: resolveReason(reason), target_history_id: editing === "new" ? null : editing, updated_at: detail.material.updated_at });
      await load(); closePanel(true); onChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "价格修正失败"); pricePreview.refresh(); }
    finally { setSaving(false); }
  };
  const saveIdentity = async () => {
    setError(""); setSaving(true);
    try {
      setDetail(await updateProcurementMaterial(materialId, { code: identityCode, name: detail!.material.name }));
      closePanel(true); onChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "原料资料修改失败"); }
    finally { setSaving(false); }
  };
  const official = detail?.official_history ?? [];
  const latestOfficial = official.at(-1), previousOfficial = official.at(-2);
  const trend = official.filter(item => item.latest_price != null).map(item => ({date: item.version_date, price: Number(item.latest_price)}));
  const validPriceCount = trend.length;
  const panelOpen = Boolean(editing || identityStep);
  const pricePreview = usePricePreview(Boolean(editing), effectiveDate, [{ material_id: materialId, price: priceValue }]);
  const identityChanged = Boolean(detail && identityCode.trim() !== detail.material.code);
  const openDatePicker = () => { const input = dateInput.current; input?.focus(); try { input?.showPicker?.(); } catch { /* Native input remains usable. */ } };
  return <div className={`${styles.drawerLayer} ${closing ? styles.closing : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); panelOpen ? closePanel() : close(); } else recordDialogKeys(event); }}>
    <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="原料价格详情">
      <header className={styles.drawerHeader}><div><span>原料详情</span><h2>{detail ? detail.material.code : "正在读取"}</h2></div><div className={styles.drawerHeaderActions}>{detail && canEdit && <button className="primary-button" type="button" onClick={() => startEdit(null)}><Pencil size={14} />录入新价格</button>}{detail && canManage && <button className="secondary-button" type="button" onClick={startIdentityEdit}><Pencil size={14} />编辑资料</button>}<button className="icon-button" type="button" aria-label="关闭详情" ref={focusWithoutScroll} onClick={() => close()}><X size={17} /></button></div></header>
      {loadState === "error" ? <div className={styles.drawerLoading}><span><strong>原料详情暂时不可用</strong><small>请重新加载后再录入价格。</small><button className="secondary-button" type="button" onClick={() => void load()}>重新加载</button></span></div> : !detail ? <div className={styles.drawerLoading}>正在整理价格记录…</div> : <div className={styles.drawerBody}>
        <div className={styles.detailMetrics}><div><span>最新价格</span><strong>{price(latestOfficial?.latest_price)}</strong></div><div><span>上版价格</span><strong>{price(previousOfficial?.latest_price)}</strong></div><div><span>涨跌</span><Movement value={latestOfficial?.latest_price != null && previousOfficial?.latest_price != null && Number(previousOfficial.latest_price) !== 0 ? (Number(latestOfficial.latest_price) / Number(previousOfficial.latest_price)-1)*100 : null} /></div><div><span>价格日期</span><strong>{latestOfficial?.price_date ? formatPriceDate(latestOfficial.price_date) : "—"}</strong></div></div>
        <section className={styles.drawerSection}><div><span>价格版本</span><h3>有效价格走势</h3></div>{trend.length < 2 ? <ChartEmpty title="暂无可比较周期" detail="至少需要两期有效价格。" /> : <div className={styles.detailChart}><ResponsiveContainer width="100%" height="100%"><LineChart data={trend}><CartesianGrid stroke="#edf0f1" vertical={false} /><XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} width={42} /><Tooltip formatter={(value) => [price(String(value)), "参考价"]} /><Line type="monotone" dataKey="price" stroke="#2f3337" strokeWidth={2} dot={{ r: 2.5 }} /></LineChart></ResponsiveContainer></div>}</section>
        <section className={styles.drawerSection}><div><span>历史记录</span><h3>{validPriceCount} 期有效价格</h3></div><div className={styles.priceHistory}><div className={styles.priceHistoryHeading} aria-hidden="true"><span>版本日期</span><span>价格</span><span>修改人</span><span /></div>{[...official].reverse().map(item => <details key={item.id}><summary aria-label={`v${item.version} ${formatPriceDate(item.version_date)}，价格 ${item.latest_price == null ? item.raw_price ?? "未定价" : price(item.latest_price)}，修改人 ${item.modifier?.name || "未记录"}`}><span className={styles.historyDate}>{formatPriceDate(item.version_date)}<small>v{item.version}</small></span><strong>{item.latest_price == null ? item.raw_price ?? "未定价" : price(item.latest_price)}</strong><span>{item.modifier?.name || "未记录"}</span><ChevronRight size={13} aria-hidden="true" /></summary><dl className={styles.historySource}><div><dt>价格来源日期</dt><dd>{item.price_date ? formatPriceDate(item.price_date) : "未记录"}</dd></div><div><dt>数据位置</dt><dd>{[item.sheet, item.cell].filter(Boolean).join(" · ") || "未记录"}</dd></div></dl></details>)}</div></section>
        {detail.adjustments.length > 0 && <section className={styles.drawerSection}><div><span>修正记录</span><h3>完整留痕</h3></div><div className={styles.adjustmentList}>{detail.adjustments.map((item) => <article key={item.id}><strong>{item.reason}</strong><span>{item.created_by} · {formatDate(item.created_at)}</span></article>)}</div></section>}
        {detail.sources.length > 0 && <details className={styles.sourceDetails} key={detail.material.id}><summary><span>数据来源</span><small>{detail.sources.length} 处</small><ChevronRight size={14} aria-hidden="true" /></summary>{Array.from(new Set(detail.sources.map(source => source.filename))).map(filename => <div className={styles.sourceFile} key={filename}><p>{filename}</p><ul>{detail.sources.filter(source => source.filename === filename).map(source => <li key={`${source.sheet}-${source.row}`}><span>{source.sheet}<small>第 {source.row} 行</small></span><span>{source.purchaser || "未填写"}</span></li>)}</ul></div>)}</details>}
        {!!detail.changes?.length && <details className={`${styles.sourceDetails} ${styles.materialChanges}`} key={`changes-${detail.material.id}`}><summary><span>修改记录</span><small>{detail.changes.length} 条</small><ChevronRight size={14} aria-hidden="true" /></summary>{detail.changes.map(change=><article key={change.id}><div className={styles.changeByline}><span>{change.actor}</span><time>{formatShanghaiDateTime(change.created_at)}</time></div>{change.status === "cancelled" && <p className={styles.cancelledChange}>已取消，不影响价格</p>}<p>{change.reason}</p><ChangePrices items={change.items ?? []} /></article>)}</details>}
      </div>}
      {detail && panelOpen && <div className={`${styles.drawerSubpanelLayer}${panelClosing ? ` ${styles.panelClosing}` : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
        <section className={styles.drawerSubpanel} aria-label={editing ? "价格修正" : "原料资料编辑"}>
          {discardTarget && <div className={styles.panelNote} role="alertdialog" aria-label="放弃未保存修改"><strong>放弃尚未保存的修改？</strong><div className={styles.panelActions}><button type="button" className="secondary-button" ref={focusWithoutScroll} onClick={() => setDiscardTarget(null)}>继续编辑</button><button type="button" className="primary-button" onClick={() => discardTarget === "drawer" ? close(true) : closePanel(true)}>放弃并关闭</button></div></div>}
          {editing && <form className={styles.adjustmentForm} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className={styles.panelHeading}><strong>{editing === "new" ? "录入新价格" : "修正历史记录"}</strong><button type="button" aria-label="取消修正" onClick={() => closePanel()}><X size={14} /></button></div>
            <p className={styles.fieldHint}>录入后加入本轮更新，启用前，最新价格保持不变。</p>
            <label>价格<input autoFocus type="number" min="0" step="0.01" value={priceValue} onChange={(event) => setPriceValue(event.target.value)} /></label>
            <label>价格日期<div className={styles.dateField} onClick={openDatePicker}><input ref={dateInput} type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /><CalendarDays size={15} /></div></label>
            <div className={styles.reasonField}><span>录价说明</span><ReasonSelect label="录价说明" options={PRICE_REASONS} placeholder="请选择说明" value={reason} disabled={saving} onChange={setReason} /></div>
            {pricePreview.data ? <PriceReview preview={pricePreview.data} /> : <p>{pricePreview.error ?? "填写价格后核对价格变化"}{pricePreview.error && <button type="button" onClick={pricePreview.refresh}>重新核对</button>}</p>}
            {error && <p className={styles.error}>{error}<button type="button" onClick={() => { void load(); pricePreview.refresh(); }}>读取最新价格核对（保留输入）</button></p>}
            <button className="primary-button" type="submit" disabled={saving || !priceValue || !effectiveDate || !resolveReason(reason) || !pricePreview.data}>{saving ? "正在写入" : "确认并保存"}</button>
          </form>}
          {identityStep === "edit" && <form className={styles.adjustmentForm} onSubmit={(event) => { event.preventDefault(); setIdentityStep("confirm"); setError(""); }}>
            <div className={styles.panelHeading}><strong>编辑原料资料</strong><button type="button" aria-label="取消编辑" onClick={() => closePanel()}><X size={14} /></button></div>
            <label>原料编号<input autoFocus readOnly={!canManage} value={identityCode} onChange={(event) => setIdentityCode(event.target.value)} /></label>
            {error && <p className={styles.error}>{error}</p>}
            <button className="primary-button" type="submit" disabled={!identityChanged || !identityCode.trim()}>检查修改</button>
          </form>}
          {identityStep === "confirm" && <div className={styles.adjustmentForm}>
            <div className={styles.panelHeading}><strong>确认资料修改</strong><button type="button" aria-label="取消编辑" onClick={() => closePanel()}><X size={14} /></button></div>
            <div className={styles.identityReview}><span>原料编号</span><strong>{detail.material.code}</strong><ArrowRight size={14} /><strong>{identityCode.trim()}</strong></div>
            {identityCode.trim() !== detail.material.code && <p className={styles.panelNote}>旧编号会保留为导入别名，已发布价格批次不会被改写。</p>}
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.panelActions}><button className="secondary-button" type="button" disabled={saving} onClick={() => setIdentityStep("edit")}>返回编辑</button><button className="primary-button" type="button" disabled={saving} onClick={() => void saveIdentity()}>{saving ? "正在修改" : "确认修改"}</button></div>
          </div>}
        </section>
      </div>}
    </aside>
  </div>;
}

function Movement({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) return <span className={styles.movementMuted}><Minus size={12} />暂无对比</span>;
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const className = value >= 10 ? `${styles.movementUp} ${styles.movementSurge}` : value > 0 ? styles.movementUp : value < 0 ? styles.movementDown : styles.movementStable;
  return <span className={`${styles.priceChange} ${className}`}><Icon size={12} />{formatPercent(value)}</span>;
}


function PriceHistory({ published }: { published: ProcurementOverview["batches"] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const rows = [...published].sort((a, b) => b.version - a.version);
  const close = () => { setSelected(null); window.requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); };
  return <>
    {!rows.length && <Empty title="还没有价格版本" detail="启用价格后，版本及其修改记录将在这里显示。" />}
    <ol className={styles.historyTimeline}>{rows.map(row => <li key={row.id}>
      <i aria-hidden="true" />
      <button type="button" aria-label={`v${row.version} · 价格日期 ${row.price_date || "未记录"}`} onClick={event => { trigger.current = event.currentTarget; setSelected(row.id); }}>
        <span className={styles.historyDate}><strong>{row.price_date ? formatPriceDate(row.price_date) : "日期未记录"}</strong>{row.status === "active" && <em>当前生效</em>}</span>
        <span className={styles.historySource}><strong>v{row.version}</strong><small>覆盖 {row.item_count} 项 · {row.status === "active" ? "当前生效" : "历史版本"} · {row.provenance ? "历史迁入 · 原表未记录启用时间" : `启用 ${formatShanghaiDateTime(row.activated_at ?? row.published_at)} · ${row.published_by_name ?? "未记录启用人"}`}</small>{row.provenance && <small>本期已报 {row.provenance.reported_count} · 本期未报 {row.item_count-row.provenance.reported_count}（此前有价则沿用）</small>}</span>
        <VersionSummary comparison={row.comparison} />
        <ChevronRight size={17} aria-hidden="true" />
      </button>
    </li>)}</ol>
    {selected && <PublishedBatchDrawer batchId={selected} onClose={close} />}
  </>;
}

function VersionSummary({ comparison, hideZeroFirst = false }: { comparison: ProcurementOverview["batches"][number]["comparison"]; hideZeroFirst?: boolean }) {
  if (!comparison) return <span className={styles.historyBatchStats}>版本统计暂不可用</span>;
  return <span className={styles.historyBatchStats}><small>{comparison.previous_version === null ? "首次建立基线" : `较 v${comparison.previous_version}`}</small><span className={styles.historyUp}>↑ {comparison.up} 上涨</span><span className={styles.historyDown}>↓ {comparison.down} 下降</span><span className={styles.historyStable}>— {comparison.unchanged} 未变</span>{(!hideZeroFirst || comparison.first > 0) && <span>{comparison.first} 首次定价</span>}{comparison.missing > 0 && <span>{comparison.missing} 未定价</span>}{Boolean(comparison.incomparable) && <span>{comparison.incomparable} 不可比较</span>}</span>;
}

function focusWithoutScroll(node: HTMLButtonElement | null) { node?.focus({ preventScroll: true }); }

function recordDialogKeys(event: React.KeyboardEvent<HTMLElement>) {
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')).filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
  if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.querySelector<HTMLButtonElement>('button[aria-label="关闭详情"]')?.click(); }
  if (event.key === "Tab" && controls.length) {
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
  }
}

function PriceRecordDrawer({ title, label, loading, failed, onClose, children, fixedBody = false }: { fixedBody?: boolean; title: string; label: string; loading: boolean; failed: boolean; onClose: () => void; children: React.ReactNode }) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const close = () => {
    if (timer.current) return;
    setClosing(true);
    timer.current = setTimeout(onClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140);
  };
  return <div className={`${styles.drawerLayer} ${closing ? styles.closing : ""}`} role="presentation" onKeyDown={recordDialogKeys} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <aside className={`${styles.drawer} ${styles.batchDrawer}`} role="dialog" aria-modal="true" aria-label={label}>
      <header className={styles.drawerHeader}><div><span>{label}</span><h2>{title}</h2></div><button ref={focusWithoutScroll} className="icon-button" type="button" aria-label="关闭详情" onClick={close}><X size={17} /></button></header>
      {failed ? <div className={styles.drawerLoading} role="alert">详情读取失败，请关闭后重试。</div> : loading ? <div className={styles.drawerLoading}>正在读取价格明细…</div> : <div className={`${styles.drawerBody} ${fixedBody ? styles.versionBody : ""}`}>{children}</div>}
    </aside>
  </div>;
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

function LedgerOperationRecords({ update }: { update: ProcurementUpdate }) {
  const events = [...update.events].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const system = (event: typeof events[number]) => ["created", "migrated"].includes(event.event);
  const render = (event: typeof events[number]) => {
    const items = update.changes?.find(change => change.id === event.id)?.items ?? [];
    const reason = event.event === "prices_adjusted" ? event.reason?.replace(/^修改 \d+ 项原料；/, "") : event.reason;
    const prices = <div className={styles.operationPrices}>{items.map(item => <div key={item.id}><strong>{item.code}</strong><span>{item.before_recorded ? price(item.before) : "未记录"}<ArrowRight size={13} aria-label="修改为" /><b>{price(item.after)}</b></span></div>)}</div>;
    return <article key={event.id} className={styles.operationRecord}>
      <header><strong>{updateEventLabel(event.event)}</strong><time>{formatDate(event.created_at)}</time></header>
      <p>{event.actor_name}{reason && <> · {reason}</>}</p>
      {items.length === 1 ? prices : items.length > 1 ? <details><summary>修改 {items.length} 项 · 查看明细</summary>{prices}</details> : null}
    </article>;
  };
  return <div className={styles.operationRecords}>
    {events.filter(event => !system(event)).map(render)}
    {events.some(system) && <details className={styles.operationSystem}><summary>系统记录 · {events.filter(system).length} 条</summary>{events.filter(system).map(render)}</details>}
  </div>;
}

function ChangePrices({ items }: { items: NonNullable<NonNullable<ProcurementBatchDetail["changes"]>[number]["items"]> }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return <p>未记录该次价格明细。</p>;
  const known = items.filter(item => item.before_recorded && item.before !== null && item.after !== null);
  const up = known.filter(item => Number(item.after) > Number(item.before)).length;
  const down = known.filter(item => Number(item.after) < Number(item.before)).length;
  return <><p>本次保存 {items.length} 项：上涨 {up} · 下降 {down} · <span className={styles.stableText}>未变 {known.length - up - down}</span>{known.length < items.length ? ` · 不可比较 ${items.length - known.length}` : ""}（较修改前报价或当时价格）</p><div className={styles.changePrices}><table className={styles.table}><thead><tr><th>原料</th><th>修改前</th><th>修改后</th><th>变化</th></tr></thead><tbody>{(expanded ? items : items.slice(0, 3)).map(item => <tr key={item.id}><td><strong>{item.code}</strong><span>{item.unit}</span></td><td>{item.before_recorded ? <>{price(item.before)}<small>{item.before_basis === "published" ? "当时价格" : "保存前有效价"}</small></> : "未记录修改前价格"}</td><td><strong>{price(item.after)}</strong></td><td><Movement value={item.change === null ? null : item.change * 100} /></td></tr>)}</tbody></table></div>{items.length > 3 && <button className="secondary-button" type="button" onClick={() => setExpanded(value => !value)}>{expanded ? "收起明细" : `展开全部 ${items.length} 项`}</button>}</>;
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
  return <PriceRecordDrawer fixedBody title={detail ? `价格基线 v${detail.version}` : "正在读取"} label="价格基线详情" loading={!detail} failed={failed} onClose={onClose}>
    {detail && <>
      <div className={styles.versionOverview}><VersionSummary comparison={detail.comparison} hideZeroFirst /></div>
      <div className={styles.detailMetrics}><div><span>价格日期</span><strong>{detail.price_date ? formatPriceDate(detail.price_date) : "—"}</strong></div><div><span>启用时间</span><strong>{detail.provenance ? "原表未记录" : formatDate(detail.activated_at ?? detail.published_at)}</strong></div><div><span>原料数量</span><strong>{detail.item_count}</strong></div><div><span>版本状态</span><strong>{detail.status === "active" ? "当前生效" : "历史版本"}</strong></div></div>
      <p className={styles.batchMeta}>{detail.provenance ? `历史迁入 · ${detail.provenance.filename} · 迁入操作人 ${detail.provenance.imported_by} · 迁入时间 ${formatShanghaiDateTime(detail.provenance.imported_at)}；原表未记录历史启用人及逐次修改。` : `${detail.source_name ?? "未记录来源"} · 启用人 ${detail.published_by_name ?? "未记录"}${detail.activation_mode === "scheduled" ? " · 系统定时启用" : ""}`}</p>
      {detail.provenance && <p className={styles.batchMeta}>本期已报 {detail.provenance.reported_count} 项 · 本期未报 {detail.item_count-detail.provenance.reported_count} 项（此前有价则沿用，不代表价格未变）</p>}
      <div className={styles.versionTabs} role="tablist" aria-label="版本内容">
        {(["prices", "changes"] as const).map(value => <button key={value} id={`version-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`version-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "prices" : event.key === "End" ? "changes" : tab === "prices" ? "changes" : "prices"; setTab(next); document.getElementById(`version-tab-${next}`)?.focus({ preventScroll: true }); } }}>{value === "prices" ? "价格" : "修改记录"}<span>{value === "prices" ? detail.item_count : detail.changes?.length ?? 0}</span></button>)}
      </div>
      <div className={styles.versionPane} id="version-panel-prices" role="tabpanel" aria-labelledby="version-tab-prices" tabIndex={0} hidden={tab !== "prices"}>
      <div className={styles.changePrices}><table className={styles.table}><thead><tr>{header("code", "原料编号 / 来源")}{header("previous", "上版价格")}{header("current", "本版价格")}{header("change", "涨跌变化")}</tr></thead><tbody>{sortBatchPrices(detail, sort, direction).map(item => { const comparison = detail.comparison?.items[item.material_id]; const source=detail.snapshot_sources?.[item.material_id]; return <tr key={item.material_id}><td><strong>{item.code} · {item.unit}</strong><span>{source?.price_date ?? "未定价"}{source?.sheet ? ` · ${source.sheet}!${source.cell ?? "—"}` : ""}</span></td><td>{price(comparison?.previous_raw ?? comparison?.previous)}</td><td><strong>{price(source?.raw_price ?? item.latest_price)}</strong>{source && source.price_kind!=="number" && source.price_kind!=="missing" && <small>原文异常，不参与精确涨跌</small>}</td><td>{comparison?.kind === "first" ? "首次定价" : comparison?.kind === "missing" ? "未定价" : comparison?.kind === "incomparable" ? "不可比较" : <Movement value={comparison?.change == null ? null : comparison.change * 100} />}</td></tr>; })}</tbody></table></div>
      </div>
      <div className={styles.versionPane} id="version-panel-changes" role="tabpanel" aria-labelledby="version-tab-changes" tabIndex={0} hidden={tab !== "changes"}>
        {!detail.changes?.length ? <p className={styles.batchMeta}>此版本没有可关联的逐次修改记录。</p> : <ol className={styles.changeTimeline}>{detail.changes.map(change => <li key={change.id}><div><strong>{updateEventLabel(change.event)}</strong><time>{formatShanghaiDateTime(change.created_at)}</time></div><p>{change.actor}</p>{change.reason && <p>{change.reason}</p>}<ChangePrices items={change.items ?? []} /></li>)}</ol>}
      </div>
    </>}
  </PriceRecordDrawer>;
}

function ImportPanel({ current, onClose, onImported }: { current: ProcurementUpdate | null; onClose: () => void; onImported: (data: ProcurementOverview) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); trigger?.focus({ preventScroll: true }); };
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

  const readFile = async (file?: File) => {
    if (!file || busy) return;
    setBusy(true); setSource(file.name); setPreview(null); setExcel(null); setContent(""); setError("");
    try {
      if (file.name.toLowerCase().endsWith(".xlsx")) {
        setExcelFile(file);
        const result = await previewProcurementExcel(file);
        setExcel(result); setSheet(result.default_sheet);
        setEffectiveDate(result.sheets.find(s => s.name === result.default_sheet)?.dates.at(-1) ?? today());
      } else { setExcelFile(null); setContent(await file.text()); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "读取文件失败"); }
    finally { setBusy(false); }
  };

  const run = async (confirm: boolean) => {
    setBusy(true); setError("");
    try {
      if (confirm) {
        if (!preview || !resolveReason(importReason)) return;
        await confirmProcurementImport(source, effectiveDate, content, revision, resolveReason(importReason));
        onImported(await fetchProcurementOverview());
      } else {
        let text = content;
        if (excelFile) { const result = await previewProcurementExcel(excelFile,sheet,effectiveDate); setExcel(result); if (!result.selection || result.selection.blocked) {setPreview(null); return;} text=result.selection.content; setContent(text); }
        setPreview(await previewProcurementImport(source, effectiveDate, text));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
      if (confirm) setPreview(null);
    } finally { setBusy(false); }
  };

  const close = () => { if (!busy) { if (content.trim() || excelFile) setDiscard(true); else onClose(); } };
  return <dialog ref={dialog} className={`settings-dialog ${styles.materialCreate} ${styles.importPanel}`} aria-labelledby="import-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <header><h2 id="import-title">导入价格</h2><button className="icon-button" type="button" aria-label="关闭导入" disabled={busy} onClick={close}><X size={17} /></button></header>
    <div className={styles.materialCreateBody}>
    <p className={styles.importIntro}>先检查数据，再保存为待发布价。</p>
    <label>来源名称<input disabled={busy} value={source} onChange={(event) => setSource(event.target.value)} /></label>
    <label>价格日期<div className={styles.dateField} onClick={(event) => { const input = event.currentTarget.querySelector("input"); input?.focus(); try { input?.showPicker?.(); } catch { /* Native input remains usable. */ } }}><input type="date" disabled={busy} value={effectiveDate} onChange={(event) => { setEffectiveDate(event.target.value); setPreview(null); }} /><CalendarDays size={15} /></div></label>
    <label className={styles.filePicker}><FileUp size={14} />选择 Excel、CSV 或 TXT<input type="file" accept=".xlsx,.csv,.txt" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} /></label>
    {excel && <><label>工作表<select value={sheet} onChange={e=>{setSheet(e.target.value); setPreview(null); setExcel({...excel,selection:undefined});}}>{excel.sheets.map(item=><option key={item.name}>{item.name}</option>)}</select></label><label>表内价格日期<select value={effectiveDate} onChange={e=>{setEffectiveDate(e.target.value);setPreview(null);}}>{excel.sheets.find(s=>s.name===sheet)?.dates.map(date=><option key={date}>{date}</option>)}</select></label>{excel.selection && <><p>有效 {excel.selection.valid} · 空白 {excel.selection.unreported} · 异常或冲突 {excel.selection.blocked}。空白不清除现价。</p><div className={styles.previewRows}>{excel.selection.rows.map(row=><div key={row.row}><span>第{row.row}行 · {row.code} · {row.raw_price || "—"}</span><em>{({number:"有效",missing:"空白",range:"区间价，须更正",invalid:"异常，须更正",duplicate:"重复编号",unknown:"未知编号"} as Record<string,string>)[row.state] ?? row.state}</em></div>)}</div></>}</>}
    {!excelFile && <label>CSV、TXT 或粘贴表格<textarea rows={8} value={content} onChange={(event) => { setContent(event.target.value); setPreview(null); }} placeholder={'编号,名称,单位,最新价,库存价,在途价\nCF004,示例原料,kg,12.2,13,12.4'} /></label>}
    {error && <p className={styles.error}>{error}<button type="button" disabled={busy} onClick={async () => {const fresh=await fetchProcurementOverview();setRevision({update_id:fresh.current_update?.id ?? null,updated_at:fresh.current_update?.updated_at ?? null});setPreview(null);setError("已刷新本轮，请重新检查数据；文件和输入已保留。");}}>读取最新本轮</button></p>}
    {preview && <><div className={styles.preview}><strong>{preview.received_count} 行 · {preview.importable_count} 行可导入 · {preview.skipped_count} 行冲突</strong><span>空白保留现价；保存后仍需由有启用权的人员确认异常波动。</span></div><div className={styles.previewRows}>{preview.rows.map((row) => <div key={`${row.code}-${row.name}`}><span><strong>{row.code}</strong>{price(row.reference_price)} → {price(row.latest_price)} <Movement value={row.change == null ? null : row.change * 100} /></span><em>{row.issues.length ? row.issues.map(importIssueLabel).join("、") : "可导入"}</em></div>)}</div><ReasonSelect label="录价说明" options={PRICE_REASONS} placeholder="请选择说明" value={importReason} disabled={busy} onChange={setImportReason} /></>}
    {discard && <section role="alertdialog" aria-label="放弃导入"><p>放弃本次文件和输入？</p><button className="secondary-button" type="button" onClick={() => setDiscard(false)}>继续编辑</button><button className="secondary-button" type="button" onClick={onClose}>放弃导入</button></section>}
    </div>
    <footer className={styles.importActions}><button className="secondary-button" type="button" disabled={busy || (!excelFile && !content.trim()) || !effectiveDate} onClick={() => void run(false)}>检查数据</button><button className="primary-button" type="button" disabled={busy || !preview || preview.importable_count === 0 || preview.skipped_count > 0 || Boolean(excel?.selection?.blocked) || !effectiveDate || !resolveReason(importReason)} onClick={() => void run(true)}>确认并导入</button></footer>
  </dialog>;
}

function PublishConfirm({ update, publishing, onClose, onConfirm }: { update: ProcurementUpdate; publishing: boolean; onClose: () => void; onConfirm: (mode: "immediate" | "scheduled", activateAt?: string) => Promise<void> }) {
  const [mode, setMode] = useState<"immediate" | "scheduled">("immediate");
  const [activateAt, setActivateAt] = useState(futureLocalInput());
  const counts = summarizeUpdate(update.input_items);
  const risks = update.issues.filter(issue => issue.kind === "price_spike" && issue.status !== "resolved");
  return <div className={styles.confirmLayer} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !publishing) onClose(); }}>
    <section onKeyDown={event => {if(event.key === "Escape" && !publishing)onClose();else recordDialogKeys(event);}} className={`${styles.confirmDialog} ${styles.publishDialog}`} role="dialog" aria-modal="true" aria-labelledby="publish-confirm-title">
      <div className={styles.panelHeading}><h2 id="publish-confirm-title">启用价格</h2><button className="icon-button" type="button" aria-label="关闭启用确认" ref={focusWithoutScroll} disabled={publishing} onClick={onClose}><X size={17} /></button></div>
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
      <div className={styles.panelActions}><button className="secondary-button" type="button" disabled={publishing} onClick={onClose}>返回台账</button><button className="primary-button" type="button" disabled={publishing || counts.missing > 0 || risks.some(issue => issue.status !== "reviewed") || (mode === "scheduled" && !activateAt)} onClick={() => void onConfirm(mode, mode === "scheduled" ? activateAt : undefined)}>{publishing ? "正在处理" : mode === "scheduled" ? "确认排期" : "确认启用"}</button></div>
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

function price(value?: string | null) { return value == null ? "—" : `¥${value}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatShanghaiDateTime(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "—"; }
function formatPriceDate(value: string) { return value.slice(0, 10).replaceAll("-", "."); }
function shortDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function formatPercent(value: number) { return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`; }
function today() { const value = new Date(); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function futureLocalInput() { const value = new Date(Date.now() + 60 * 60 * 1000); value.setMinutes(Math.ceil(value.getMinutes() / 5) * 5, 0, 0); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`; }
function updateStatusLabel(status: ProcurementUpdate["status"]) { return ({ draft: "录入价格", returned: "继续修改", submitted: "待启用", scheduled: "等待定时启用", revalidation_required: "需要重新确认", published: "已启用", cancelled: "已取消" } as const)[status]; }
function updateEventLabel(event: string) { return ({ prices_adjusted: "批量编辑价格", cancelled: "取消本轮", created: "创建本轮更新", imported: "导入价格", price_adjusted: "修正价格", submitted: "提交复核", returned: "退回修改", risk_reviewed: "确认高风险变动", scheduled: "安排定时启用", activated: "启用", revalidation_required: "要求重新确认", schedule_cancelled: "撤销排期", copied_from_schedule: "复制为新草稿", migrated: "迁移现有工作稿" } as Record<string, string>)[event] ?? event; }
function materialChange(item: ProcurementMaterial) {
  if (item.published_price == null || item.previous_published_price == null) return null;
  const current = Number(item.published_price); const previous = Number(item.previous_published_price);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return current === previous ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
function importIssueLabel(issue: string) { return ({ missing_price: "缺价", duplicate_code: "重复编码", unit_conflict: "单位冲突", price_spike: "价格波动" } as Record<string, string>)[issue] ?? issue; }
