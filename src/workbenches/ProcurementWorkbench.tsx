import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Columns3, FileUp, Minus, Newspaper, PackageCheck, Pencil, RefreshCw, Search, SlidersHorizontal, TrendingDown, TrendingUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adjustProcurementPrice, cancelProcurementSchedule, confirmProcurementImport, fetchProcurementBatch, fetchProcurementHistoryBatch, fetchProcurementHistoryBatches, fetchProcurementMaterial, fetchProcurementOverview, fetchProcurementPreferences, fetchProcurementPriceHistory, previewProcurementImport, publishProcurementUpdate, reviewProcurementIssue, saveProcurementPreferences, updateProcurementMaterial } from "../api";
import type { ProcurementBatchDetail, ProcurementHistoryBatch, ProcurementHistoryBatchDetail, ProcurementImportPreview, ProcurementMaterial, ProcurementMaterialDetail, ProcurementOverview, ProcurementPage, ProcurementPreferences, ProcurementPriceHistory, ProcurementUpdate } from "../types";
import { buildPriceMovement, buildPriceTrend, countValidPrices } from "./procurementAnalytics";
import { defaultProcurementPage, procurementWorkflowStage } from "./procurementWorkflow";
import styles from "./ProcurementWorkbench.module.css";

const MARKET_NEWS = [
  { title: "基础化工原料运价进入季节性观察窗口", source: "行业资讯示例", material: "聚合氯化铝", impact: "成本关注", detail: "关注区域运价与到厂周期变化，评估短期补库节奏。" },
  { title: "上游能源价格波动可能影响助剂报价", source: "市场动态示例", material: "助剂系列", impact: "价格上行", detail: "建议结合供应商最新报价与库存覆盖天数持续观察。" },
  { title: "重点原料供应稳定性进入月度复核", source: "内部情报示例", material: "核心原料", impact: "供应关注", detail: "汇总交付周期、在途数量和异常询价，供管理层研判。" },
] as const;

export function ProcurementWorkbench({ accessLevel, view, page, onPageChange, onEnter }: { accessLevel: number; view: "preview" | "full"; page: ProcurementPage; onPageChange: (page: ProcurementPage) => void; onEnter: () => void }) {
  const [data, setData] = useState<ProcurementOverview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [importOpen, setImportOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback((signal?: AbortSignal) => {
    setState("loading");
    return fetchProcurementOverview(signal)
      .then((overview) => { setData(overview); setState("ready"); })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setState("error");
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (state === "loading") return <ModuleState title="正在读取采购数据" />;
  if (state === "error" || !data) return <ModuleState title="采购工作台暂时不可用" retry={() => void load()} />;

  if (view === "preview") return <ProcurementPreview data={data} onEnter={() => { onPageChange(defaultProcurementPage(data.current_update)); onEnter(); }} />;

  return (
    <article className={`workbench-detail ${styles.root} ${styles.full}${page === "materials" ? ` ${styles.ledgerPage}` : ""}`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>采购部 · 已启用</span>
          <h1>原料成本管理</h1>
          <p>归集采购价格，确认异常波动后启用可追溯的原料成本基线。</p>
        </div>
        <div className={styles.actions}>
          {(page === "updates" || page === "materials") && accessLevel >= 3 && (!data.current_update || ["draft", "returned"].includes(data.current_update.status)) && <button className="secondary-button" type="button" onClick={() => setImportOpen(true)}><FileUp size={15} />导入价格</button>}
        </div>
      </header>

      {page === "materials" && data.current_update && <button className={styles.compactUpdate} type="button" onClick={() => onPageChange("updates")}>
        <span><strong>本轮更新 · {updateStatusLabel(data.current_update.status)}</strong><small>{formatPriceDate(data.current_update.price_date)} · {data.current_update.summary.error_count + data.current_update.summary.risk_count} 项待处理</small></span>
        <em>查看本轮更新<ChevronRight size={15} /></em>
      </button>}
      {notice && <div className={styles.notice}><Check size={14} />{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}

      {page === "dashboard" && <Dashboard data={data} onOpenUpdate={() => onPageChange("updates")} />}
      {page === "updates" && <CurrentUpdate data={data} accessLevel={accessLevel} onPageChange={onPageChange} onRefresh={() => void load()} onNotice={setNotice} onPublish={() => setPublishOpen(true)} />}
      {page === "materials" && <Materials data={data} accessLevel={accessLevel} onRefresh={() => void load()} />}
      {page === "history" && <PriceHistory />}
      {page === "batches" && <Batches data={data} accessLevel={accessLevel} onRefresh={() => void load()} onNotice={setNotice} />}
      {importOpen && <ImportPanel onClose={() => setImportOpen(false)} onImported={(overview) => { setData(overview); setImportOpen(false); setNotice("价格数据已导入，异常项已进入待处理列表。"); }} />}
      {publishOpen && data.current_update && <PublishConfirm update={data.current_update} publishing={publishing} onClose={() => setPublishOpen(false)} onConfirm={async (mode, activateAt) => {
        setPublishing(true);
        const published = await publish(data.current_update!, mode, activateAt, setData, setNotice);
        setPublishing(false);
        if (published) setPublishOpen(false);
      }} />}
    </article>
  );
}

function ModuleState({ title, retry }: { title: string; retry?: () => void }) {
  return <article className="workbench-detail workspace-detail-empty"><RefreshCw size={22} /><strong>{title}</strong>{retry && <button className="secondary-button" type="button" onClick={retry}>重新加载</button>}</article>;
}

function ProcurementPreview({ data, onEnter }: { data: ProcurementOverview; onEnter: () => void }) {
  const movement = buildPriceMovement(data.materials);
  const latestBatch = data.batches[0];
  const metrics = [
    ["跟踪原料", data.metrics.material_count, "已纳入当前台账"],
    ["待处理事项", data.metrics.open_issue_count, data.metrics.open_issue_count ? "需要进入工作台处理" : "当前没有未处理异常"],
    ["最新价格版本", latestBatch ? `v${latestBatch.version}` : "未发布", latestBatch ? formatDate(latestBatch.published_at) : "尚未形成正式基线"],
    ["本期价格变动", movement.ranked.length ? `${movement.counts.rising} 涨 / ${movement.counts.falling} 降` : "暂无对比", movement.ranked.length ? "按最新价与上次价格比较" : "需要至少两个价格周期"],
  ] as const;
  const materialMap = new Map(data.materials.map((material) => [material.code, material]));

  return <article className={`workbench-detail ${styles.root} ${styles.summaryPage}`}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>采购部 · 已启用</span><h1>原料成本管理</h1><p>快速查看采购价格、异常和最新成本基线，需要处理业务时再进入完整工作台。</p></div>
      <button className="primary-button" type="button" onClick={onEnter}>进入工作台<ArrowRight size={15} /></button>
    </header>
    <div className={`${styles.metrics} workbench-metrics`}>{metrics.map(([label, value, note]) => <div key={label}><small>{label}</small><strong>{value}</strong><span>{note}</span></div>)}</div>
    <PriceTrendPanel data={data} className={styles.previewTrend} />
    <section className={styles.section}>
      <div className={styles.sectionHeading}><div><span>管理摘要</span><h2>本期价格关注</h2></div><small>{movement.ranked.length ? `${movement.ranked.length} 项可比较` : "暂无可比较周期"}</small></div>
      {movement.ranked.length
        ? <div className={styles.previewMovers}>{movement.ranked.slice(0, 4).map((item) => { const material = materialMap.get(item.code); return <div key={item.code}><span><strong>{material?.name ?? item.code}</strong><small>{item.code} · 当前 {price(material?.latest_price)}</small></span><Movement value={item.changePercent} /></div>; })}</div>
        : <div className={styles.inlineEmpty}><strong>暂无可比较周期</strong><span>完成第二次价格导入后，这里将显示变动最大的原料。</span></div>}
    </section>
  </article>;
}

function PriceTrendPanel({ data, className = "" }: { data: ProcurementOverview; className?: string }) {
  const { rows: history, failed } = usePriceHistory();
  const movement = buildPriceMovement(data.materials);
  const materialMap = new Map(data.materials.map((material) => [material.code, material]));
  const defaultMaterial = movement.ranked[0]?.code ?? data.materials[0]?.code ?? "";
  const [selectedMaterial, setSelectedMaterial] = useState(defaultMaterial);
  const trend = history ? buildPriceTrend(history, selectedMaterial) : [];

  useEffect(() => {
    if (selectedMaterial && data.materials.some((material) => material.code === selectedMaterial)) return;
    setSelectedMaterial(defaultMaterial);
  }, [data.materials, defaultMaterial, selectedMaterial]);

  return <section className={`${styles.dashboardPanel} ${styles.trendPanel}${className ? ` ${className}` : ""}`}>
    <div className={styles.panelHeading}><div><span>价格趋势</span><h2>关键原料价格走势</h2></div><select aria-label="选择趋势原料" value={selectedMaterial} onChange={(event) => setSelectedMaterial(event.target.value)}>{data.materials.map((material) => <option key={material.code} value={material.code}>{material.name}</option>)}</select></div>
    {failed ? <ChartEmpty title="询价历史暂时不可用" detail="稍后重新进入该页面。" /> : history === null ? <ChartEmpty title="正在读取价格趋势" detail="正在整理询价记录。" /> : trend.length < 2 ? <ChartEmpty title="暂无可比较周期" detail="至少需要两次有效询价记录才会生成趋势线。" /> : <div className={styles.lineChart} aria-label={`${materialMap.get(selectedMaterial)?.name ?? selectedMaterial}价格趋势`}><ResponsiveContainer width="100%" height="100%"><LineChart data={trend} accessibilityLayer margin={{ top: 8, right: 12, bottom: 4, left: 0 }}><CartesianGrid stroke="#edf0f1" vertical={false} /><XAxis dataKey="recordedAt" tickFormatter={shortDate} tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} width={44} /><Tooltip labelFormatter={(value) => formatPriceDate(String(value))} formatter={(value) => [price(String(value)), "最新价"]} /><Line type="monotone" dataKey="value" stroke="#2f3337" strokeWidth={2} dot={{ r: 3, fill: "#fff", strokeWidth: 2 }} activeDot={{ r: 4 }} /></LineChart></ResponsiveContainer></div>}
  </section>;
}

function Dashboard({ data, onOpenUpdate }: { data: ProcurementOverview; onOpenUpdate: () => void }) {
  const movement = buildPriceMovement(data.materials);
  const materialMap = new Map(data.materials.map((material) => [material.code, material]));
  const latestBatch = data.batches[0];
  const surgeCount = movement.ranked.filter((item) => item.changePercent >= 10).length;
  const pieData = [
    { name: "大幅上涨", value: surgeCount, color: "#d03730" },
    { name: "上涨", value: movement.counts.rising - surgeCount, color: "#c97732" },
    { name: "下降", value: movement.counts.falling, color: "#3f7d68" },
    { name: "持平", value: movement.counts.stable, color: "#788189" },
    { name: "暂无对比", value: movement.counts.unavailable, color: "#d7dbde" },
  ].filter((item) => item.value > 0);

  const metrics = [
    ["跟踪原料", data.metrics.material_count, "当前台账"],
    ["上涨原料", movement.ranked.length ? movement.counts.rising : "—", movement.ranked.length ? "较上次价格" : "暂无对比周期"],
    ["待处理异常", data.metrics.open_issue_count, data.metrics.open_issue_count ? "需要管理关注" : "当前无异常"],
    ["最新价格批次", latestBatch ? `v${latestBatch.version}` : "—", latestBatch ? formatDate(latestBatch.published_at) : "尚未发布"],
  ] as const;

  const task = data.current_update ?? data.scheduled_update;
  return <>
    <section className={styles.taskCard}>
      <div><span>{task?.status === "scheduled" ? "待启用批次" : "当前任务"}</span><h2>{data.next_action}</h2><p>{task ? `${formatPriceDate(task.price_date)} · ${task.source_name} · ${updateStatusLabel(task.status)}` : "从导入询价报表或录入单项价格开始下一轮更新。"}</p></div>
      {task && <button className="primary-button" type="button" onClick={onOpenUpdate}>查看本轮更新<ArrowRight size={15} /></button>}
    </section>
    <div className={`${styles.metrics} workbench-metrics`}>{metrics.map(([label, value, note]) => <div key={label}><small>{label}</small><strong>{value}</strong><span>{note}</span></div>)}</div>
    <div className={styles.dashboardGrid}>
      <PriceTrendPanel data={data} />
      <section className={styles.dashboardPanel}>
        <div className={styles.panelHeading}><div><span>变动结构</span><h2>原料价格分布</h2></div></div>
        {movement.ranked.length === 0 ? <ChartEmpty title="暂无可比较周期" detail="第二次价格导入后显示涨跌分布。" /> : <><div className={styles.pieChart}><ResponsiveContainer width="100%" height="100%"><PieChart accessibilityLayer><Pie data={pieData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={72} paddingAngle={2}>{pieData.map((item) => <Cell key={item.name} fill={item.color} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer><strong>{movement.ranked.length}</strong><span>项可比较</span></div><div className={styles.chartLegend}>{pieData.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}<strong>{item.value}</strong></span>)}</div></>}
      </section>
      <section className={styles.dashboardPanel}>
        <div className={styles.panelHeading}><div><span>变动排行</span><h2>价格波动关注</h2></div></div>
        {movement.ranked.length === 0 ? <ChartEmpty title="暂无波动排行" detail="当前数据还没有可比较的上期价格。" /> : <div className={styles.moverList}>{movement.ranked.slice(0, 5).map((item) => { const material = materialMap.get(item.code); const Icon = item.changePercent > 0 ? TrendingUp : TrendingDown; return <div key={item.code}><Icon size={16} /><span><strong>{material?.name ?? item.code}</strong><small>{item.code} · {price(material?.previous_latest_price)} → {price(material?.latest_price)}</small></span><Movement value={item.changePercent} /></div>; })}</div>}
      </section>
      <section className={styles.dashboardPanel}>
        <div className={styles.panelHeading}><div><span>示例资讯</span><h2>今日行情资讯</h2></div><small>尚未接入实时采集</small></div>
        <div className={styles.newsList}>{MARKET_NEWS.map((item) => <article key={item.title}><Newspaper size={15} /><div><strong>{item.title}</strong><p>{item.detail}</p><span><Clock3 size={11} />{item.source} · 影响原料：{item.material} · {item.impact}</span></div></article>)}</div>
      </section>
    </div>
  </>;
}

function ChartEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className={styles.chartEmpty}><strong>{title}</strong><span>{detail}</span></div>;
}

const LEDGER_COLUMNS = [
  ["unit", "单位"], ["latest_price", "当前正式价"], ["previous_latest_price", "上次正式价"], ["change", "价格变化"],
  ["price_date", "价格日期"], ["status", "状态"], ["in_transit_price", "在途价"], ["inventory_price", "库存价"], ["suggested_price", "建议价"],
] as const;
const MATERIAL_COLUMN_WIDTH = 240;
const LEDGER_COLUMN_WIDTHS: Record<string, number> = {
  unit: 72,
  latest_price: 112,
  previous_latest_price: 112,
  change: 120,
  price_date: 132,
  status: 90,
  in_transit_price: 112,
  inventory_price: 112,
  suggested_price: 112,
};
const UPDATE_COLUMNS = [
  ["unit", "单位", LEDGER_COLUMN_WIDTHS.unit],
  ["previous_latest_price", "当前正式价", LEDGER_COLUMN_WIDTHS.previous_latest_price + 30],
  ["latest_price", "待发布价", LEDGER_COLUMN_WIDTHS.latest_price + 30],
  ["change", "价格变化", LEDGER_COLUMN_WIDTHS.change + 32],
  ["status", "风险", LEDGER_COLUMN_WIDTHS.status + 40],
] as const;
const DEFAULT_PREFERENCES: ProcurementPreferences = {
  ledger_columns: LEDGER_COLUMNS.slice(0, 6).map(([id]) => id),
  history_view: "batches",
  ledger_view: "scroll",
  ledger_page_size: 50,
};

function Materials({ data, accessLevel, onRefresh }: { data: ProcurementOverview; accessLevel: number; onRefresh: () => void }) {
  const { preferences, update } = useProcurementPreferences();
  const [query, setQuery] = useState("");
  const [movement, setMovement] = useState("all");
  const [period, setPeriod] = useState("all");
  const [sort, setSort] = useState("code");
  const [page, setPage] = useState(1);
  const [pageSizeInput, setPageSizeInput] = useState("50");
  const [selected, setSelected] = useState<string | null>(null);
  const latestDate = data.materials.reduce((latest, item) => item.price_date > latest ? item.price_date : latest, "");
  const pending = new Set(data.issues.filter((item) => item.status === "open").map((item) => item.material_id));
  const rows = data.materials.filter((item) => {
    const change = materialChange(item);
    const matchesQuery = `${item.code} ${item.name}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesMovement = movement === "all" || (movement === "up" && change !== null && change > 0) || (movement === "down" && change !== null && change < 0) || (movement === "missing" && item.latest_price == null) || (movement === "pending" && pending.has(item.id));
    const matchesPeriod = period === "all" || (period === "current" ? item.price_date === latestDate : item.price_date !== latestDate);
    return matchesQuery && matchesMovement && matchesPeriod;
  }).sort((a, b) => compareMaterials(a, b, sort));
  const columns = preferences?.ledger_columns ?? DEFAULT_PREFERENCES.ledger_columns;
  const ledgerView = preferences?.ledger_view ?? DEFAULT_PREFERENCES.ledger_view;
  const pageSize = preferences?.ledger_page_size ?? DEFAULT_PREFERENCES.ledger_page_size;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const visibleRows = ledgerView === "paged" ? rows.slice((page - 1) * pageSize, page * pageSize) : rows;
  const activeFilterCount = Number(movement !== "all") + Number(period !== "all");

  useEffect(() => { setPage(1); }, [query, movement, period, sort, pageSize]);
  useEffect(() => { setPage((current) => Math.min(current, pageCount)); }, [pageCount]);
  useEffect(() => { setPageSizeInput(String(pageSize)); }, [pageSize]);

  const setPageSize = (value: number) => {
    const next = Math.min(200, Math.max(10, value));
    setPageSizeInput(String(next));
    void update({ ledger_page_size: next });
  };
  const applyCustomPageSize = () => {
    const value = Number(pageSizeInput);
    if (Number.isFinite(value)) setPageSize(value);
    else setPageSizeInput(String(pageSize));
  };

  return <section className={`${styles.section} ${styles.ledgerSection}`}>
    <div className={styles.sectionHeading}><div><span>当前有效参考价</span><h2>原料台账</h2><p className={styles.sectionDescription}>查询和维护当前有效参考价；点击原料可查看趋势与修正记录。</p></div><small>{rows.length} / {data.materials.length} 条</small></div>
    <div className={styles.toolbar}>
      <label className={styles.searchField}><Search size={15} /><input aria-label="搜索原料" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号或原料名称" /></label>
      <details className={`${styles.columnMenu} ${styles.filterMenu}`}><summary><SlidersHorizontal size={14} />筛选{activeFilterCount > 0 && <em>{activeFilterCount}</em>}</summary><div>
        <label className={styles.menuSelect}><span>价格状态</span><select aria-label="筛选价格状态" value={movement} onChange={(event) => setMovement(event.target.value)}><option value="all">全部状态</option><option value="up">价格上涨</option><option value="down">价格下降</option><option value="missing">缺少价格</option><option value="pending">待处理</option></select></label>
        <label className={styles.menuSelect}><span>价格周期</span><select aria-label="筛选价格周期" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="all">全部周期</option><option value="current">当前周期</option><option value="older">较早周期</option></select></label>
      </div></details>
      <label><ArrowUpDown size={14} /><select aria-label="台账排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="code">编号升序</option><option value="price">价格由高到低</option><option value="change">涨跌幅由高到低</option><option value="date">日期由近到远</option></select></label>
      <details className={`${styles.columnMenu} ${styles.displayMenu}`}><summary><Columns3 size={14} />显示</summary><div>
        <span className={styles.menuLabel}>显示列</span>
        <div className={styles.columnGrid}>{LEDGER_COLUMNS.map(([id, label]) => <label key={id}><input type="checkbox" checked={columns.includes(id)} onChange={() => { const next = columns.includes(id) ? columns.filter((item) => item !== id) : [...columns, id]; if (next.length) void update({ ledger_columns: next }); }} />{label}</label>)}</div>
        <span className={styles.menuLabel}>浏览方式</span>
        <div className={styles.ledgerMode} role="group" aria-label="台账查看模式"><button type="button" aria-pressed={ledgerView === "scroll"} onClick={() => void update({ ledger_view: "scroll" })}>连续</button><button type="button" aria-pressed={ledgerView === "paged"} onClick={() => void update({ ledger_view: "paged" })}>分页</button></div>
        {ledgerView === "paged" && <><span className={styles.menuLabel}>每页条数</span><div className={styles.pageSizeControl}>{[25, 50, 100].map((size) => <button key={size} type="button" aria-pressed={pageSize === size} onClick={() => setPageSize(size)}>{size}</button>)}<input aria-label="自定义每页条目数" type="number" min="10" max="200" value={pageSizeInput} onChange={(event) => setPageSizeInput(event.target.value)} onBlur={applyCustomPageSize} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div></>}
      </div></details>
    </div>
    {!rows.length ? <Empty title="没有符合条件的原料" detail="调整搜索或筛选条件后再试。" /> : <MaterialTable materials={visibleRows} columns={columns} pending={pending} onSelect={setSelected} ledger />}
    {ledgerView === "paged" && rows.length > 0 && <div className={styles.paginationBar}>
      <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, rows.length)} / {rows.length} 条</span>
      <div className={styles.pageNavigation}><button type="button" disabled={page === 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={14} />上一页</button><span>第 {page} / {pageCount} 页</span><button type="button" disabled={page === pageCount} onClick={() => setPage((current) => current + 1)}>下一页<ChevronRight size={14} /></button></div>
    </div>}
    {selected && <MaterialDrawer materialId={selected} accessLevel={accessLevel} onClose={() => setSelected(null)} onChanged={onRefresh} />}
  </section>;
}

function MaterialTable({ materials, columns, pending, onSelect, ledger = false }: { materials: ProcurementMaterial[]; columns: string[]; pending: Set<string>; onSelect: (id: string) => void; ledger?: boolean }) {
  const tableWidth = MATERIAL_COLUMN_WIDTH + columns.reduce((total, id) => total + (LEDGER_COLUMN_WIDTHS[id] ?? 112), 0);
  return <div className={`${styles.tableWrap}${ledger ? ` ${styles.ledgerTableWrap}` : ""}`}><table className={`${styles.table} ${styles.stickyTable} ${styles.decisionTable}`} style={{ minWidth: `${tableWidth}px` }}><colgroup><col style={{ width: MATERIAL_COLUMN_WIDTH }} />{columns.map((id) => <col key={id} style={{ width: LEDGER_COLUMN_WIDTHS[id] ?? 112 }} />)}</colgroup><thead><tr><th data-column="identity">编号 / 原料</th>{columns.map((id) => <th data-column={id} key={id}>{LEDGER_COLUMNS.find(([column]) => column === id)?.[1]}</th>)}</tr></thead><tbody>{materials.map((item) => <tr key={item.id}><td data-column="identity"><button className={styles.materialLink} type="button" onClick={() => onSelect(item.id)}><span><strong title={item.code}>{item.code}</strong><small title={item.name}>{item.name}</small></span><ChevronRight size={16} aria-hidden="true" /></button></td>{columns.map((id) => <td data-column={id} key={id}>{ledgerCell(item, id, pending.has(item.id))}</td>)}</tr>)}</tbody></table></div>;
}

function ledgerCell(item: ProcurementMaterial, column: string, pending: boolean) {
  if (column === "unit") return item.unit;
  if (column === "latest_price") return item.published_price == null ? <span className={styles.baselineEmpty}>未建立基线</span> : <strong>{price(item.published_price)}</strong>;
  if (column === "previous_latest_price") return item.previous_published_price == null ? "—" : <strong>{price(item.previous_published_price)}</strong>;
  if (column === "change") return <span className={styles.updateChange}><small>较上期</small><Movement value={materialChange(item)} /></span>;
  if (column === "price_date") return item.published_price_date ? formatPriceDate(item.published_price_date) : <span className={styles.baselineEmpty}>尚未建立基线</span>;
  if (column === "status") return <span className={`${styles.statusPill} ${pending ? styles.statusPending : item.latest_price == null ? styles.statusMissing : styles.statusOk}`}>{pending ? "待处理" : item.latest_price == null ? "缺价" : "有效"}</span>;
  if (column === "in_transit_price") return price(item.in_transit_price);
  if (column === "inventory_price") return price(item.inventory_price);
  return price(item.suggested_price);
}

function compareMaterials(a: ProcurementMaterial, b: ProcurementMaterial, sort: string) {
  if (sort === "price") return Number(b.latest_price ?? -1) - Number(a.latest_price ?? -1);
  if (sort === "change") return (materialChange(b) ?? -Infinity) - (materialChange(a) ?? -Infinity);
  if (sort === "date") return b.price_date.localeCompare(a.price_date);
  return a.code.localeCompare(b.code, "zh-CN", { numeric: true });
}

function useProcurementPreferences() {
  const [preferences, setPreferences] = useState<ProcurementPreferences | null>(null);
  useEffect(() => { const controller = new AbortController(); fetchProcurementPreferences(controller.signal).then(setPreferences).catch(() => undefined); return () => controller.abort(); }, []);
  const update = async (next: Partial<ProcurementPreferences>) => setPreferences(await saveProcurementPreferences({ ...(preferences ?? DEFAULT_PREFERENCES), ...next }));
  return { preferences, update };
}

function MaterialDrawer({ materialId, accessLevel, onClose, onChanged, startWithNewPrice = false }: { materialId: string; accessLevel: number; onClose: () => void; onChanged?: () => void; startWithNewPrice?: boolean }) {
  const [detail, setDetail] = useState<ProcurementMaterialDetail | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState<string | null>(startWithNewPrice ? "new" : null);
  const [identityStep, setIdentityStep] = useState<"edit" | "confirm" | null>(null);
  const [identityCode, setIdentityCode] = useState("");
  const [identityName, setIdentityName] = useState("");
  const [panelClosing, setPanelClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [priceValue, setPriceValue] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [reason, setReason] = useState("");
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
  useEffect(() => { if (startWithNewPrice && detail?.price_date && !effectiveDate) setEffectiveDate(detail.price_date); }, [detail, effectiveDate, startWithNewPrice]);
  const close = () => { setClosing(true); window.setTimeout(onClose, 140); };
  const closePanel = () => {
    if (panelClosing) return;
    setPanelClosing(true);
    window.setTimeout(() => { setEditing(null); setIdentityStep(null); setPanelClosing(false); setError(""); }, 140);
  };
  const startEdit = (id: string | null, value?: string | null, dateValue?: string) => {
    setIdentityStep(null); setEditing(id ?? "new"); setPanelClosing(false); setPriceValue(value ?? ""); setEffectiveDate(dateValue ?? detail?.price_date ?? ""); setReason(""); setError("");
  };
  const startIdentityEdit = () => {
    if (!detail) return;
    setEditing(null); setIdentityStep("edit"); setPanelClosing(false); setIdentityCode(detail.material.code); setIdentityName(detail.material.name); setError("");
  };
  const save = async () => {
    setError(""); setSaving(true);
    try {
      await adjustProcurementPrice(materialId, { price: priceValue, effective_date: effectiveDate, reason, target_history_id: editing === "new" ? null : editing });
      await load(); closePanel(); onChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "价格修正失败"); }
    finally { setSaving(false); }
  };
  const saveIdentity = async () => {
    setError(""); setSaving(true);
    try {
      setDetail(await updateProcurementMaterial(materialId, { code: identityCode, name: identityName }));
      closePanel(); onChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "原料资料修改失败"); }
    finally { setSaving(false); }
  };
  const trend = detail?.history.filter((item) => item.latest_price != null).map((item) => ({ date: item.effective_date, price: Number(item.latest_price) })) ?? [];
  const validPriceCount = countValidPrices(detail?.history ?? []);
  const panelOpen = Boolean(editing || identityStep);
  const identityChanged = Boolean(detail && (identityCode.trim() !== detail.material.code || identityName.trim() !== detail.material.name));
  const openDatePicker = () => { const input = dateInput.current; input?.focus(); try { input?.showPicker?.(); } catch { /* Native input remains usable. */ } };
  return <div className={`${styles.drawerLayer} ${closing ? styles.closing : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); panelOpen ? closePanel() : close(); } }}>
    <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="原料价格详情">
      <header className={styles.drawerHeader}><div><span>原料详情</span><h2>{detail ? `${detail.material.code} · ${detail.material.name}` : "正在读取"}</h2></div><div className={styles.drawerHeaderActions}>{detail && accessLevel >= 3 && <button className="secondary-button" type="button" onClick={startIdentityEdit}><Pencil size={14} />编辑资料</button>}<button className="icon-button" type="button" aria-label="关闭详情" onClick={close}><X size={17} /></button></div></header>
      {loadState === "error" ? <div className={styles.drawerLoading}><span><strong>原料详情暂时不可用</strong><small>请重新加载后再录入价格。</small><button className="secondary-button" type="button" onClick={() => void load()}>重新加载</button></span></div> : !detail ? <div className={styles.drawerLoading}>正在整理价格记录…</div> : <div className={styles.drawerBody}>
        <div className={styles.detailMetrics}><div><span>当前价</span><strong>{price(detail.latest_price)}</strong></div><div><span>上次价</span><strong>{price(detail.previous_price)}</strong></div><div><span>涨跌</span><Movement value={detail.change == null ? null : detail.change * 100} /></div><div><span>价格日期</span><strong>{detail.price_date ? formatPriceDate(detail.price_date) : "—"}</strong></div></div>
        {accessLevel >= 3 && <button className="secondary-button" type="button" onClick={() => startEdit(null)}>新增当前价格</button>}
        <section className={styles.drawerSection}><div><span>价格趋势</span><h3>有效价格记录</h3></div>{trend.length < 2 ? <ChartEmpty title="暂无可比较周期" detail="至少需要两期有效价格。" /> : <div className={styles.detailChart}><ResponsiveContainer width="100%" height="100%"><LineChart data={trend}><CartesianGrid stroke="#edf0f1" vertical={false} /><XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: "#858d94", fontSize: 10 }} axisLine={false} tickLine={false} width={42} /><Tooltip formatter={(value) => [price(String(value)), "参考价"]} /><Line type="monotone" dataKey="price" stroke="#2f3337" strokeWidth={2} dot={{ r: 2.5 }} /></LineChart></ResponsiveContainer></div>}</section>
        <section className={styles.drawerSection}><div><span>历史记录</span><h3>{validPriceCount} 期有效价格</h3></div><div className={styles.timeline}>{[...detail.history].reverse().map((item) => <article key={item.id}><i /><span><strong>{formatPriceDate(item.effective_date)} · {item.latest_price == null ? "缺价" : price(item.latest_price)}</strong><small>{item.source_name} · {item.created_by_name}</small></span>{accessLevel >= 3 && <button type="button" onClick={() => startEdit(item.id, item.latest_price, item.effective_date)}>修正</button>}</article>)}</div></section>
        {detail.adjustments.length > 0 && <section className={styles.drawerSection}><div><span>修正记录</span><h3>完整留痕</h3></div><div className={styles.adjustmentList}>{detail.adjustments.map((item) => <article key={item.id}><strong>{item.reason}</strong><span>{item.created_by} · {formatDate(item.created_at)}</span></article>)}</div></section>}
      </div>}
      {detail && panelOpen && <div className={`${styles.drawerSubpanelLayer}${panelClosing ? ` ${styles.panelClosing}` : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
        <section className={styles.drawerSubpanel} aria-label={editing ? "价格修正" : "原料资料编辑"}>
          {editing && <form className={styles.adjustmentForm} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className={styles.panelHeading}><strong>{editing === "new" ? "新增当前价格" : "修正历史记录"}</strong><button type="button" aria-label="取消修正" onClick={closePanel}><X size={14} /></button></div>
            <label>价格<input autoFocus type="number" min="0" step="0.01" value={priceValue} onChange={(event) => setPriceValue(event.target.value)} /></label>
            <label>生效日期<div className={styles.dateField} onClick={openDatePicker}><input ref={dateInput} type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /><CalendarDays size={15} /></div></label>
            <label>修正原因<textarea rows={3} minLength={4} maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明价格来源或修正原因" /></label>
            {error && <p className={styles.error}>{error}</p>}
            <button className="primary-button" type="submit" disabled={saving || !priceValue || !effectiveDate || reason.trim().length < 4}>{saving ? "正在写入" : "确认写入"}</button>
          </form>}
          {identityStep === "edit" && <form className={styles.adjustmentForm} onSubmit={(event) => { event.preventDefault(); setIdentityStep("confirm"); setError(""); }}>
            <div className={styles.panelHeading}><strong>编辑原料资料</strong><button type="button" aria-label="取消编辑" onClick={closePanel}><X size={14} /></button></div>
            <label>原料编号<input autoFocus={accessLevel >= 4} readOnly={accessLevel < 4} value={identityCode} onChange={(event) => setIdentityCode(event.target.value)} /></label>
            {accessLevel < 4 && <p className={styles.fieldHint}>编号由采购负责人维护，你可以修改下方原料名称。</p>}
            <label>原料名称（备注）<input autoFocus={accessLevel < 4} maxLength={120} value={identityName} onChange={(event) => setIdentityName(event.target.value)} /></label>
            {error && <p className={styles.error}>{error}</p>}
            <button className="primary-button" type="submit" disabled={!identityChanged || !identityCode.trim() || !identityName.trim()}>检查修改</button>
          </form>}
          {identityStep === "confirm" && <div className={styles.adjustmentForm}>
            <div className={styles.panelHeading}><strong>确认资料修改</strong><button type="button" aria-label="取消编辑" onClick={closePanel}><X size={14} /></button></div>
            <div className={styles.identityReview}><span>原料编号</span><strong>{detail.material.code}</strong><ArrowRight size={14} /><strong>{identityCode.trim()}</strong><span>原料名称</span><strong>{detail.material.name}</strong><ArrowRight size={14} /><strong>{identityName.trim()}</strong></div>
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
  const className = value >= 10 ? `${styles.movementUp} ${styles.movementSurge}` : value > 0 ? styles.movementUp : value < 0 ? styles.movementDown : styles.movementMuted;
  return <span className={`${styles.priceChange} ${className}`}><Icon size={12} />{formatPercent(value)}</span>;
}

function CurrentUpdate({ data, accessLevel, onPageChange, onRefresh, onNotice, onPublish }: { data: ProcurementOverview; accessLevel: number; onPageChange: (page: ProcurementPage) => void; onRefresh: () => void; onNotice: (message: string) => void; onPublish: () => void }) {
  const [selectedMaterial, setSelectedMaterial] = useState<string | null>(null);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [itemQuery, setItemQuery] = useState("");
  const [itemRisk, setItemRisk] = useState("all");
  const [itemSort, setItemSort] = useState("code");
  const [itemPage, setItemPage] = useState(1);
  const [itemPageSize, setItemPageSize] = useState(25);
  const [itemColumns, setItemColumns] = useState<string[]>(UPDATE_COLUMNS.map(([id]) => id));
  useEffect(() => { setItemPage(1); }, [itemQuery, itemRisk, itemSort, itemPageSize]);
  const update = data.current_update;
  if (!update) return <Empty title="当前没有本轮更新" detail="从导入询价报表或在原料详情录入新价格开始。" />;
  const canEdit = accessLevel >= 3 && ["draft", "returned"].includes(update.status);
  const canConfirm = accessLevel >= 3 && ["draft", "returned", "submitted", "revalidation_required"].includes(update.status);
  const errors = update.issues.filter((issue) => issue.kind !== "price_spike" && issue.status === "open");
  const risks = update.issues.filter((issue) => issue.kind === "price_spike");
  const openRiskCount = risks.filter((issue) => issue.status === "open").length;
  const issueTitle = [errors.length ? `${errors.length} 项价格待补录` : "", openRiskCount ? `${openRiskCount} 项价格波动待确认` : ""].filter(Boolean).join("，") || "价格问题已处理";
  const issueHint = errors.length ? "先补齐缺价，再完成价格波动确认" : openRiskCount ? "逐项填写 4–200 字确认依据" : "可选择正式启用方式";
  const riskByMaterial = new Map(risks.map((issue) => [issue.material_id, issue]));
  const filteredItems = update.items.filter((item) => {
    const matchesQuery = `${item.code} ${item.name}`.toLowerCase().includes(itemQuery.trim().toLowerCase());
    const hasRisk = riskByMaterial.has(item.material_id);
    return matchesQuery && (itemRisk === "all" || (itemRisk === "risk" ? hasRisk : !hasRisk));
  }).sort((a, b) => {
    if (itemSort === "price") return Number(b.draft_price ?? -1) - Number(a.draft_price ?? -1);
    if (itemSort === "change") return (b.change ?? -Infinity) - (a.change ?? -Infinity);
    return a.code.localeCompare(b.code, "zh-CN", { numeric: true });
  });
  const itemPageCount = Math.max(1, Math.ceil(filteredItems.length / itemPageSize));
  const safeItemPage = Math.min(itemPage, itemPageCount);
  const visibleItems = filteredItems.slice((safeItemPage - 1) * itemPageSize, safeItemPage * itemPageSize);
  const workflowStage = procurementWorkflowStage(update);
  const workflowSteps: Array<[string, ProcurementPage]> = [["录入价格", "updates"], ["确认价格波动", "updates"], ["正式启用", "batches"]];
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try { await action(); onNotice(success); onRefresh(); }
    catch (reason) { onNotice(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  };
  return <section className={`${styles.section} ${styles.updateSection}`}>
    <section className={styles.workflowBar} aria-label="本轮价格更新进度">
      <div className={styles.workflowOverviewHeader}><div><span>本轮价格更新</span><strong>{formatPriceDate(update.price_date)} · {update.source_name.replace(update.price_date, "").trim() || "本轮更新"}</strong><small>{update.created_by_name} 创建 · {formatDate(update.updated_at)} 更新</small></div></div>
      <ol>
        {workflowSteps.map(([label, target], index) => {
          const position = index + 1;
          const completed = position < workflowStage;
          const active = position === workflowStage;
          return <li key={label} className={completed ? styles.workflowComplete : active ? styles.workflowActive : ""} data-status={active ? update.status : undefined}><button type="button" aria-current={active ? "step" : undefined} onClick={() => onPageChange(target)}><i>{completed ? <Check size={11} /> : position}</i><span>{active && update.status !== "draft" ? updateStatusLabel(update.status) : label}</span></button></li>;
        })}
      </ol>
      {update.return_reason && <div className={styles.returnBanner}><AlertTriangle size={15} /><span><strong>此前退回原因</strong>{update.return_reason}</span></div>}
      <div className={styles.updateMetrics}>
        <div><span>覆盖原料</span><strong>{update.summary.coverage_count}</strong></div><div><span>价格变动</span><strong>{update.summary.changed_count}</strong></div><div><span>未变</span><strong>{update.summary.unchanged_count}</strong></div><div><span>数据错误</span><strong>{update.summary.error_count}</strong></div><div><span>业务风险</span><strong>{update.summary.risk_count}</strong></div>
      </div>
      {(errors.length > 0 || risks.length > 0) && <div className={styles.workflowIssues}><div className={styles.panelHeading}><div><span>当前待办</span><h2>{issueTitle}</h2></div><small>{issueHint}</small></div><div className={styles.issueList}>{[...errors, ...risks].map((issue) => {
        const reviewed = issue.status === "reviewed";
        const status = issue.kind === "missing_price" ? "待补录" : reviewed ? "已确认" : "待确认";
        return <div key={issue.id}><AlertTriangle size={16} /><span><strong>{issue.material_code} · {issue.material_name}</strong><small>{issue.label}{issue.review_reason ? ` · 依据：${issue.review_reason}` : ""}</small></span><em className={reviewed ? styles.reviewed : ""}>{status}</em>{canEdit && issue.kind === "missing_price" && <button className="secondary-button" type="button" onClick={() => setSelectedMaterial(issue.material_id)}>补录价格</button>}{canEdit && issue.kind === "price_spike" && <button className="secondary-button" type="button" onClick={() => setSelectedMaterial(issue.material_id)}>查看价格</button>}{canConfirm && issue.kind === "price_spike" && issue.status === "open" && <label className={styles.reviewControl}><input aria-label={`${issue.material_code}确认依据`} maxLength={200} value={reviewReasons[issue.id] ?? ""} onChange={(event) => setReviewReasons((current) => ({ ...current, [issue.id]: event.target.value }))} placeholder="填写确认依据" /><button type="button" disabled={busy || (reviewReasons[issue.id]?.trim().length ?? 0) < 4} onClick={() => void run(() => reviewProcurementIssue(update.id, issue.id, reviewReasons[issue.id]), `${issue.material_code} 价格波动已确认。`)}>确认波动</button></label>}</div>;
      })}</div></div>}
      <div className={styles.workflowFooter}><small>{data.next_action}</small><div className={styles.updateActions}>
        {canConfirm && <button className="primary-button" type="button" disabled={busy || errors.length > 0 || openRiskCount > 0} onClick={onPublish}><PackageCheck size={15} />选择启用方式</button>}
      </div></div>
    </section>
    <section className={styles.updateBlock}>
      <div className={styles.panelHeading}><div><span>全部变价</span><h2>正式价与待发布价</h2></div><small>{filteredItems.length} / {update.items.length} 项</small></div>
      {update.items.length > 0 && <div className={styles.toolbar}>
        <label className={styles.searchField}><Search size={15} /><input aria-label="搜索变价原料" value={itemQuery} onChange={(event) => setItemQuery(event.target.value)} placeholder="搜索编号或原料名称" /></label>
        <label><SlidersHorizontal size={14} /><select aria-label="筛选变价风险" value={itemRisk} onChange={(event) => setItemRisk(event.target.value)}><option value="all">全部变价</option><option value="risk">高风险</option><option value="normal">普通变动</option></select></label>
        <label><ArrowUpDown size={14} /><select aria-label="变价排序" value={itemSort} onChange={(event) => setItemSort(event.target.value)}><option value="code">编号升序</option><option value="change">涨跌幅由高到低</option><option value="price">待发布价由高到低</option></select></label>
        <details className={`${styles.columnMenu} ${styles.displayMenu}`}><summary><Columns3 size={14} />显示</summary><div>
          <span className={styles.menuLabel}>显示列</span>
          <div className={styles.columnGrid}>{UPDATE_COLUMNS.map(([id, label]) => <label key={id}><input type="checkbox" checked={itemColumns.includes(id)} onChange={() => { const next = itemColumns.includes(id) ? itemColumns.filter((item) => item !== id) : [...itemColumns, id]; if (next.length) setItemColumns(next); }} />{label}</label>)}</div>
          <span className={styles.menuLabel}>每页条数</span>
          <div className={styles.pageSizeControl}>{[25, 50, 100].map((size) => <button key={size} type="button" aria-pressed={itemPageSize === size} onClick={() => setItemPageSize(size)}>{size}</button>)}</div>
        </div></details>
      </div>}
      {!update.items.length ? <div className={styles.inlineEmpty}><strong>本轮没有价格变动</strong><span>可返回检查录入内容。</span></div> : !filteredItems.length ? <Empty title="没有符合条件的变价" detail="调整搜索或筛选条件后再试。" /> : <>
        <div className={`${styles.tableWrap} ${styles.updateTableWrap}`}><table className={`${styles.table} ${styles.decisionTable}`}><colgroup><col style={{ width: MATERIAL_COLUMN_WIDTH }} />{itemColumns.map((id) => <col key={id} style={{ width: UPDATE_COLUMNS.find(([column]) => column === id)?.[2] }} />)}</colgroup><thead><tr><th data-column="identity">编号 / 原料</th>{itemColumns.map((id) => <th data-column={id} key={id}>{UPDATE_COLUMNS.find(([column]) => column === id)?.[1]}</th>)}</tr></thead><tbody>{visibleItems.map((item) => { const issue = riskByMaterial.get(item.material_id); return <tr key={item.material_id}><td data-column="identity"><strong>{item.code}</strong><span>{item.name}</span></td>{itemColumns.map((id) => <td data-column={id} key={id}>{id === "unit" ? item.unit : id === "previous_latest_price" ? item.published_price == null ? <span className={styles.baselineEmpty}>尚未建立基线</span> : price(item.published_price) : id === "latest_price" ? <strong>{price(item.draft_price)}</strong> : id === "change" ? <span className={styles.updateChange}>{item.comparison_basis === "previous_inquiry" && <small>较上期</small>}<Movement value={item.change == null ? null : item.change * 100} /></span> : issue ? <span className={`${styles.statusPill} ${issue.status === "reviewed" ? styles.statusOk : styles.statusPending}`}>{issue.status === "reviewed" ? "已确认" : "高风险"}</span> : "—"}</td>)}</tr>; })}</tbody></table></div>
        <div className={styles.paginationBar}><span>{(safeItemPage - 1) * itemPageSize + 1}–{Math.min(safeItemPage * itemPageSize, filteredItems.length)} / {filteredItems.length} 条</span><div className={styles.pageNavigation}><button type="button" disabled={safeItemPage === 1} onClick={() => setItemPage(safeItemPage - 1)}><ChevronLeft size={14} />上一页</button><span>第 {safeItemPage} / {itemPageCount} 页</span><button type="button" disabled={safeItemPage === itemPageCount} onClick={() => setItemPage(safeItemPage + 1)}>下一页<ChevronRight size={14} /></button></div></div>
      </>}
    </section>
    <section className={styles.updateBlock}><div className={styles.panelHeading}><div><span>操作记录</span><h2>本轮完整留痕</h2></div></div><div className={styles.eventList}>{update.events.map((event, index) => <div key={`${event.created_at}-${index}`}><span><strong>{updateEventLabel(event.event)}</strong><small>{event.actor_name} · {formatDate(event.created_at)}</small></span>{event.reason && <p>{event.reason}</p>}</div>)}</div></section>
    {selectedMaterial && <MaterialDrawer materialId={selectedMaterial} accessLevel={accessLevel} startWithNewPrice={errors.some((issue) => issue.material_id === selectedMaterial)} onClose={() => setSelectedMaterial(null)} onChanged={onRefresh} />}
  </section>;
}

function PriceHistory() {
  const [batches, setBatches] = useState<ProcurementHistoryBatch[] | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setFailed(false);
    fetchProcurementHistoryBatches(controller.signal).then(setBatches).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
    });
    return () => controller.abort();
  }, []);
  const latest = batches?.[0];

  return <section className={`${styles.section} ${styles.historySection}`}>
    <div className={styles.sectionHeading}><div><span>批次采集记录</span><h2>询价历史</h2><p className={styles.sectionDescription}>按日期追溯每次价格采集及跨期变化。</p></div><small>{batches?.length ?? "—"} 个日期批次</small></div>
    {failed ? <Empty title="询价历史暂时不可用" detail="请稍后重新进入该页面。" /> : batches === null ? <Empty title="正在整理询价历史" detail="正在按价格日期汇总采集记录。" /> : !batches.length || !latest ? <Empty title="还没有询价历史" detail="每次确认导入后，系统会形成一个日期批次。" /> : <>
      <div className={styles.historyMetrics} aria-label="询价历史摘要">
        <div><span>历史批次</span><strong>{batches.length}</strong><small>按价格日期归档</small></div>
        <div><span>最新价格日期</span><strong>{formatPriceDate(latest.effective_date)}</strong><small>{latest.source_name}</small></div>
        <div><span>最新批次覆盖</span><strong>{latest.material_count}</strong><small>项原料</small></div>
        <div><span>最新批次缺价</span><strong>{latest.missing_count}</strong><small>{latest.missing_count ? "需要关注" : "数据完整"}</small></div>
      </div>
      <BatchHistoryTimeline rows={batches} onSelect={setSelectedBatch} />
    </>}
    {selectedBatch && <BatchDrawer batchId={selectedBatch} onClose={() => setSelectedBatch(null)} />}
  </section>;
}

function BatchHistoryTimeline({ rows, onSelect }: { rows: ProcurementHistoryBatch[]; onSelect: (id: string) => void }) {
  return <ol className={styles.historyTimeline}>{rows.map((item, index) => <li key={item.id}>
    <i aria-hidden="true" />
    <button type="button" aria-label={`${formatPriceDate(item.effective_date)} 询价批次，覆盖 ${item.material_count} 项原料`} onClick={() => onSelect(item.id)}>
      <span className={styles.historyDate}><strong>{formatPriceDate(item.effective_date)}</strong>{index === 0 && <em>最新</em>}</span>
      <span className={styles.historySource}><strong>{item.source_name}</strong><small>{item.created_by} · 导入于 {formatDate(item.created_at)}</small></span>
      <span className={styles.historyBatchStats}>
        <span><PackageCheck size={13} />{item.material_count} 项</span>
        <span className={styles.historyUp}><ArrowUp size={13} />{item.up_count} 上涨</span>
        <span className={styles.historyDown}><ArrowDown size={13} />{item.down_count} 下降</span>
        <span><Minus size={13} />{item.flat_count} 持平</span>
        <span className={item.missing_count ? styles.historyMissing : undefined}><AlertTriangle size={13} />{item.missing_count} 缺价</span>
      </span>
      <ChevronRight size={17} aria-hidden="true" />
    </button>
  </li>)}</ol>;
}

function BatchDrawer({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ProcurementHistoryBatchDetail | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => { const controller = new AbortController(); fetchProcurementHistoryBatch(batchId, controller.signal).then(setDetail).catch(() => undefined); return () => controller.abort(); }, [batchId]);
  const close = () => { setClosing(true); window.setTimeout(onClose, 140); };
  return <div className={`${styles.drawerLayer} ${closing ? styles.closing : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside className={`${styles.drawer} ${styles.batchDrawer}`} role="dialog" aria-modal="true" aria-label="询价批次详情"><header className={styles.drawerHeader}><div><span>日期批次</span><h2>{detail ? `${formatPriceDate(detail.effective_date)} · ${detail.material_count} 项原料` : "正在读取"}</h2></div><button className="icon-button" type="button" aria-label="关闭详情" onClick={close}><X size={17} /></button></header>{detail && <div className={styles.drawerBody}><div className={styles.detailMetrics}><div><span>上涨</span><strong>{detail.up_count}</strong></div><div><span>下降</span><strong>{detail.down_count}</strong></div><div><span>持平</span><strong>{detail.flat_count}</strong></div><div><span>缺价</span><strong>{detail.missing_count}</strong></div></div><p className={styles.batchMeta}>{detail.source_name} · {detail.created_by} · 对比 {detail.previous_date ? formatPriceDate(detail.previous_date) : "首个有效周期"}</p><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>编号 / 原料</th><th>本期价格</th><th>上期价格</th><th>涨跌</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td><strong>{item.material_code}</strong><span>{item.material_name}</span></td><td>{price(item.latest_price)}</td><td>{price(item.previous_price)}</td><td><Movement value={item.change == null ? null : item.change * 100} /></td></tr>)}</tbody></table></div></div>}</aside></div>;
}

function usePriceHistory() {
  const [rows, setRows] = useState<ProcurementPriceHistory[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchProcurementPriceHistory(controller.signal).then(setRows).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
    });
    return () => controller.abort();
  }, []);
  return { rows, failed };
}

function Batches({ data, accessLevel, onRefresh, onNotice }: { data: ProcurementOverview; accessLevel: number; onRefresh: () => void; onNotice: (message: string) => void }) {
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const batchTrigger = useRef<HTMLButtonElement | null>(null);
  const scheduled = data.scheduled_update;
  const cancel = async (copyToDraft: boolean) => {
    if (!scheduled) return;
    setBusy(true);
    try { await cancelProcurementSchedule(scheduled.id, cancelReason, copyToDraft); onNotice(copyToDraft ? "排期已撤销，并复制为新的本轮草稿。" : "排期已撤销，当前正式基线未受影响。"); onRefresh(); }
    catch (reason) { onNotice(reason instanceof Error ? reason.message : "撤销排期失败"); }
    finally { setBusy(false); }
  };
  const closeBatch = () => {
    setSelectedBatch(null);
    window.requestAnimationFrame(() => batchTrigger.current?.focus());
  };
  return <section className={styles.section}><div className={styles.sectionHeading}><div><span>正式成本基线</span><h2>价格批次</h2><p className={styles.sectionDescription}>区分当前正式价、待启用排期和历史版本。</p></div><small>{data.batches.length} 个已启用版本</small></div>
    {scheduled && <div className={styles.scheduledCard}><Clock3 size={18} /><span><strong>待启用：{formatPriceDate(scheduled.price_date)}</strong><small>{formatShanghaiDateTime(scheduled.activate_at)} · {scheduled.summary.coverage_count} 项原料</small></span><em>定时启用</em>{accessLevel >= 3 && <label><input value={cancelReason} maxLength={200} onChange={(event) => setCancelReason(event.target.value)} placeholder="撤销原因（4–200字）" /><button className="secondary-button" type="button" disabled={busy || cancelReason.trim().length < 4} onClick={() => void cancel(false)}>撤销排期</button><button className="secondary-button" type="button" disabled={busy || cancelReason.trim().length < 4} onClick={() => void cancel(true)}>撤销并复制草稿</button></label>}</div>}
    {!data.batches.length ? <Empty title="还没有正式价格基线" detail="本轮价格处理完成并启用后，将在这里形成第一个不可变版本。" /> : <div className={styles.batchList}>{data.batches.map((batch) => <button key={batch.id} type="button" onClick={(event) => { batchTrigger.current = event.currentTarget; setSelectedBatch(batch.id); }}><PackageCheck size={17} /><span><strong>价格基线 v{batch.version}{batch.status === "active" ? " · 当前正式" : ""}</strong><small>价格日期 {batch.price_date ? formatPriceDate(batch.price_date) : "—"} · 启用 {formatDate(batch.activated_at ?? batch.published_at)} · {batch.item_count} 项原料</small></span><em>{batch.status === "active" ? "使用中" : "历史版本"}</em><ChevronRight size={17} aria-hidden="true" /></button>)}</div>}
    {selectedBatch && <PublishedBatchDrawer batchId={selectedBatch} onClose={closeBatch} />}
  </section>;
}

function PublishedBatchDrawer({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ProcurementBatchDetail | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchProcurementBatch(batchId, controller.signal)
      .then((value) => { setDetail(value); setLoadState("ready"); })
      .catch((error: unknown) => { if (!(error instanceof DOMException && error.name === "AbortError")) setLoadState("error"); });
    return () => controller.abort();
  }, [batchId]);
  const close = () => { setClosing(true); window.setTimeout(onClose, 140); };
  return <div className={`${styles.drawerLayer} ${closing ? styles.closing : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <aside className={`${styles.drawer} ${styles.batchDrawer}`} role="dialog" aria-modal="true" aria-label="正式价格基线详情">
      <header className={styles.drawerHeader}><div><span>正式成本基线</span><h2>{detail ? `价格基线 v${detail.version}` : "正在读取"}</h2></div><button autoFocus className="icon-button" type="button" aria-label="关闭详情" onClick={close}><X size={17} /></button></header>
      {loadState === "error" ? <div className={styles.drawerLoading}><span><strong>价格基线详情暂时不可用</strong><small>请关闭后重新打开。</small></span></div> : !detail ? <div className={styles.drawerLoading}>正在读取正式价格快照…</div> : <div className={styles.drawerBody}>
        <div className={styles.detailMetrics}><div><span>价格日期</span><strong>{detail.price_date ? formatPriceDate(detail.price_date) : "—"}</strong></div><div><span>启用时间</span><strong>{formatDate(detail.activated_at ?? detail.published_at)}</strong></div><div><span>原料数量</span><strong>{detail.item_count}</strong></div><div><span>版本状态</span><strong>{detail.status === "active" ? "当前正式" : "历史版本"}</strong></div></div>
        <p className={styles.batchMeta}>{detail.source_name ?? "未记录来源"} · {detail.activation_mode === "scheduled" ? "批准人" : "启用人"} {detail.published_by_name ?? "未记录"}{detail.activation_mode === "scheduled" ? " · 系统定时启用" : ""}</p>
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="正式价格快照明细"><table className={styles.table}><thead><tr><th>编号 / 原料</th><th>单位</th><th>正式价</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.material_id}><td><strong>{item.code}</strong><span>{item.name}</span></td><td>{item.unit}</td><td><strong>{price(item.latest_price)}</strong></td></tr>)}</tbody></table></div>
      </div>}
    </aside>
  </div>;
}

function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: (data: ProcurementOverview) => void }) {
  const [source, setSource] = useState("采购价格导入");
  const [effectiveDate, setEffectiveDate] = useState(today());
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<ProcurementImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (confirm: boolean) => {
    setBusy(true); setError("");
    try {
      if (confirm) {
        await confirmProcurementImport(source, effectiveDate, content);
        onImported(await fetchProcurementOverview());
      } else {
        setPreview(await previewProcurementImport(source, effectiveDate, content));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
    } finally { setBusy(false); }
  };

  return <div className={styles.importPanel}>
    <div className={styles.importHeading}><div><span>价格导入</span><h2>预览后再写入台账</h2></div><button className="icon-button" type="button" aria-label="关闭导入" onClick={onClose}><X size={17} /></button></div>
    <label>来源名称<input value={source} onChange={(event) => setSource(event.target.value)} /></label>
    <label>价格生效日期<div className={styles.dateField} onClick={(event) => { const input = event.currentTarget.querySelector("input"); input?.focus(); try { input?.showPicker?.(); } catch { /* Native input remains usable. */ } }}><input type="date" value={effectiveDate} onChange={(event) => { setEffectiveDate(event.target.value); setPreview(null); }} /><CalendarDays size={15} /></div></label>
    <label className={styles.filePicker}><FileUp size={14} />选择 CSV 或 TXT<input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; setSource(file.name); void file.text().then((text) => { setContent(text); setPreview(null); }); }} /></label>
    <label>CSV、TXT 或粘贴表格<textarea rows={8} value={content} onChange={(event) => { setContent(event.target.value); setPreview(null); }} placeholder={'编号,名称,单位,最新价,库存价,在途价\nCF004,示例原料,kg,12.2,13,12.4'} /></label>
    {error && <p className={styles.error}>{error}</p>}
    {preview && <><div className={styles.preview}><strong>{preview.received_count} 行 · {preview.importable_count} 行可导入 · {preview.skipped_count} 行跳过</strong><span>{preview.rows.filter((row) => row.issues.length).length} 行需要后续处理</span></div><div className={styles.previewRows}>{preview.rows.slice(0, 8).map((row) => <div key={`${row.code}-${row.name}`}><span><strong>{row.code}</strong>{row.name}</span><em>{row.issues.length ? row.issues.map(importIssueLabel).join("、") : "可导入"}</em></div>)}</div></>}
    <div className={styles.importActions}><button className="secondary-button" type="button" disabled={busy || !content.trim() || !effectiveDate} onClick={() => void run(false)}>检查数据</button><button className="primary-button" type="button" disabled={busy || !preview || preview.importable_count === 0 || !effectiveDate} onClick={() => void run(true)}>确认写入</button></div>
  </div>;
}

function PublishConfirm({ update, publishing, onClose, onConfirm }: { update: ProcurementUpdate; publishing: boolean; onClose: () => void; onConfirm: (mode: "immediate" | "scheduled", activateAt?: string) => Promise<void> }) {
  const [mode, setMode] = useState<"immediate" | "scheduled">("immediate");
  const [activateAt, setActivateAt] = useState(futureLocalInput());
  return <div className={styles.confirmLayer} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !publishing) onClose(); }}>
    <section className={styles.confirmDialog} role="dialog" aria-modal="true" aria-labelledby="publish-confirm-title">
      <div className={styles.panelHeading}><div><span>启用确认</span><h2 id="publish-confirm-title">选择正式基线启用方式</h2></div><button className="icon-button" type="button" aria-label="关闭启用确认" disabled={publishing} onClick={onClose}><X size={17} /></button></div>
      <div className={styles.publishSummary}>
        <div><span>价格日期</span><strong>{formatPriceDate(update.price_date)}</strong></div>
        <div><span>本次来源</span><strong>{update.source_name}</strong></div>
        <div><span>启用范围</span><strong>{update.summary.coverage_count} 项原料</strong></div>
        <div><span>价格波动</span><strong>已确认</strong></div>
      </div>
      <div className={styles.activateModes}><button type="button" aria-pressed={mode === "immediate"} onClick={() => setMode("immediate")}><strong>立即启用</strong><span>确认后立刻替换当前正式基线</span></button><button type="button" aria-pressed={mode === "scheduled"} onClick={() => setMode("scheduled")}><strong>定时启用</strong><span>在指定时间自动启用</span></button></div>
      {mode === "scheduled" && <label className={styles.scheduleField}>启用时间<input type="datetime-local" value={activateAt} onChange={(event) => setActivateAt(event.target.value)} /></label>}
      <p>启用后将形成完整正式基线。定时启用前如正式基线变化，本批次会停止自动启用并提示重新确认。</p>
      <div className={styles.panelActions}><button className="secondary-button" type="button" disabled={publishing} onClick={onClose}>返回检查</button><button className="primary-button" type="button" disabled={publishing || (mode === "scheduled" && !activateAt)} onClick={() => void onConfirm(mode, mode === "scheduled" ? activateAt : undefined)}>{publishing ? "正在处理" : mode === "scheduled" ? "安排定时启用" : "立即发布并启用"}</button></div>
    </section>
  </div>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className={styles.empty}><PackageCheck size={21} /><strong>{title}</strong><p>{detail}</p></div>;
}

async function publish(update: ProcurementUpdate, mode: "immediate" | "scheduled", activateAt: string | undefined, onUpdated: (data: ProcurementOverview) => void, onNotice: (message: string) => void) {
  try {
    const result = await publishProcurementUpdate(update.id, { mode, activate_at: activateAt });
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
function updateEventLabel(event: string) { return ({ created: "创建本轮更新", imported: "导入价格", price_adjusted: "修正价格", submitted: "提交复核", returned: "退回修改", risk_reviewed: "确认高风险变动", scheduled: "安排定时启用", activated: "正式启用", revalidation_required: "要求重新确认", schedule_cancelled: "撤销排期", copied_from_schedule: "复制为新草稿", migrated: "迁移现有工作稿" } as Record<string, string>)[event] ?? event; }
function materialChange(item: ProcurementMaterial) {
  if (item.published_price == null || item.previous_published_price == null) return null;
  const current = Number(item.published_price); const previous = Number(item.previous_published_price);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return current === previous ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
function importIssueLabel(issue: string) { return ({ missing_price: "缺价", duplicate_code: "重复编码", unit_conflict: "单位冲突", price_spike: "价格波动" } as Record<string, string>)[issue] ?? issue; }
