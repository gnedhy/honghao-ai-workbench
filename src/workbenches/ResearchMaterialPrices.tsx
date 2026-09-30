import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronRight, Columns3, Search, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "../api";
import { LedgerFrame, LedgerToolbar, PageState, WorkbenchLoading } from "../components/WorkbenchLayout";
import { LedgerPagination } from "../components/LedgerPagination";
import { WorkbenchOptionMenu } from "../components/WorkbenchMenus";
import { PriceMovement } from "../components/PriceMovement";
import type { ProcurementMaterial, ResearchMaterialDetail, ResearchMaterialPrices as MaterialPrices } from "../types";
import { MaterialDrawer, ledgerCell } from "./ProcurementWorkbench";
import { buildLedgerRows, filterLedgerRows, formalLedgerChange } from "./procurementLedger";
import styles from "../components/WorkbenchSurface.module.css";
import researchStyles from "./ResearchWorkbench.module.css";

const base = "/api/workbenches/research/material-prices";
const columns = [
  ["inventory_quantity", "库存量", 120], ["unit", "单位", 72], ["latest_price", "最新价格", 112],
  ["inventory_price", "库存价格", 112], ["change", "价格变化", 120], ["price_date", "价格日期", 132],
  ["modifier", "修改人", 120], ["status", "状态", 90], ["previous_latest_price", "上版价格", 112],
] as const;
type Column = typeof columns[number][0];
const sortableColumns = new Set(["inventory_quantity", "latest_price", "inventory_price", "change", "price_date"]);
type Preferences = { columns: Column[]; view: "scroll" | "paged"; pageSize: number };
const defaults: Preferences = { columns: columns.slice(0, 8).map(([id]) => id), view: "paged", pageSize: 50 };
const movementOptions = [
  { value: "all", label: "全部" }, { value: "up", label: "上涨" }, { value: "down", label: "下降" },
  { value: "flat", label: "持平" }, { value: "missing", label: "未定价" }, { value: "incomparable", label: "暂无对比" },
];
const detail = (id: string, signal?: AbortSignal) => fetchJson<ResearchMaterialDetail>(`${base}/${encodeURIComponent(id)}`, { signal });
const errorText = (error: unknown) => error instanceof Error ? error.message : "原料价格暂时不可用";

export function ResearchMaterialPrices({ userId }: { userId: string }) {
  const [data, setData] = useState<MaterialPrices | null>(null);
  const [error, setError] = useState("");
  const inFlight = useRef<AbortSignal | undefined | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (inFlight.current !== null && !inFlight.current?.aborted) return;
    inFlight.current = signal;
    try {
      const value = await fetchJson<MaterialPrices>(base, { signal });
      if (!signal?.aborted) { setData(value); setError(""); }
    } catch (failure) {
      if (!signal?.aborted) setError(errorText(failure));
    } finally { if (inFlight.current === signal) inFlight.current = null; }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);

  const preferenceKey = `research-material-prices:${userId}`;
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) || "null") as Partial<Preferences> | null;
      const allowed = new Set<Column>(columns.map(([id]) => id));
      const selected = saved?.columns?.filter((id): id is Column => allowed.has(id));
      return { columns: selected?.length ? selected : defaults.columns, view: saved?.view === "scroll" ? "scroll" : "paged",
        pageSize: Number.isInteger(saved?.pageSize) && Number(saved?.pageSize) >= 10 && Number(saved?.pageSize) <= 200 ? Number(saved?.pageSize) : 50 };
    } catch { return defaults; }
  });
  useEffect(() => { try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* Browsing remains available. */ } }, [preferenceKey, preferences]);
  const [scope, setScope] = useState("formula");
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState("");
  const [movement, setMovement] = useState("all");
  const [sort, setSort] = useState("change");
  const [direction, setDirection] = useState<"ascending" | "descending">("descending");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => document.getElementById("research-material-toolbar")?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => {
      if (!menu.contains(event.target as Node)) menu.open = false;
    });
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, []);
  useEffect(() => { setPage(1); }, [scope, query, person, movement, sort, direction, preferences.pageSize]);

  const people = useMemo(() => Array.from(new Map((data?.materials ?? []).flatMap(item => item.participants ?? []).map(item => [item.id, item])).values())
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")), [data]);
  const scoped = useMemo(() => (data?.materials ?? []).filter(item => scope === "all" || item.in_formula_scope), [data, scope]);
  const rows = useMemo(() => filterLedgerRows(buildLedgerRows(scoped, null), {
    query, movement, scope: "all", editor: person, selectedPerson: "", current: null,
    comparison: data?.ledger_comparison ?? undefined, sort, sortDirection: direction, edit: null, values: {},
  }), [scoped, data, query, movement, person, sort, direction]);
  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / preferences.pageSize)));
  const visible = preferences.view === "scroll" ? rows : rows.slice((safePage - 1) * preferences.pageSize, safePage * preferences.pageSize);
  const tableWidth = 240 + preferences.columns.reduce((sum, id) => sum + (columns.find(([column]) => column === id)?.[2] ?? 112), 0);
  const toggleSort = (id: string) => { setDirection(old => sort === id && old === "descending" ? "ascending" : "descending"); setSort(id); };
  const header = (id: string, label: string) => <th key={id} data-column={id} aria-sort={sortableColumns.has(id) && sort === id ? direction : undefined}>{sortableColumns.has(id) ? <button className={styles.sortHeading} type="button" onClick={() => toggleSort(id)}>{label}{sort === id ? direction === "ascending" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={12} />}</button> : label}</th>;
  const cell = (item: ProcurementMaterial, id: Column) => id === "change" ? <PriceMovement value={formalLedgerChange(item, data?.ledger_comparison ?? undefined)} /> : ledgerCell(item, id, false);

  return <article className={`workbench-detail ${styles.root} ${styles.full} ${styles.ledgerPage} ${researchStyles.root}`}>
    <header className={styles.header}><div><span className={styles.eyebrow}>研发五部 · 只读</span><h1>原料价格</h1><p>查看采购已启用的正式价格；本页约每 10 秒同步一次。</p></div></header>
    {error && <PageState error className={researchStyles.notice} onRetry={() => void load()}>{data ? "价格刷新失败，仍显示上次读取的内容。" : error}</PageState>}
    <section className={`${styles.section} ${styles.ledgerSection}`}>
      <div className={`${styles.sectionHeading} ${styles.ledgerHeading}`}><div><h2>原料价格</h2><span>{rows.length} / {scoped.length} 项{data?.batch ? ` · 正式版 v${data.batch.version}` : " · 暂无正式版本"}</span></div></div>
      {!data ? error ? null : <WorkbenchLoading local title="正在读取原料价格" /> : <LedgerFrame>
        <LedgerToolbar id="research-material-toolbar" onBlur={event => { event.currentTarget.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => { if (!menu.contains(event.relatedTarget)) menu.open = false; }); }} onKeyDown={event => { if (event.key === "Escape") { const menu = (event.target as HTMLElement).closest("details"); if (menu) { menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus(); } } }}>
          <label className={styles.searchField}><Search size={15} aria-hidden="true"/><input aria-label="搜索原料编号" placeholder="搜索原料编号" value={query} onChange={event => setQuery(event.target.value)}/></label>
          <WorkbenchOptionMenu label="原料范围" value={scope} options={[{value:"formula",label:"配方范围"},{value:"all",label:"所有原料"}]} onSelect={setScope}/>
          <WorkbenchOptionMenu label="人员" value={person} options={[{value:"",label:"全部人员"},...people.map(item => ({value:item.id,label:item.name}))]} onSelect={setPerson}/>
          <details className={`${styles.columnMenu} ${styles.filterMenu}`}><summary><SlidersHorizontal size={14} aria-hidden="true"/>筛选{movement !== "all" && <em>1</em>}</summary><div><section className={styles.filterGroup} aria-label="价格变化"><span>价格变化</span>{movementOptions.map(option => <button key={option.value} type="button" aria-pressed={movement === option.value} onClick={event => { setMovement(option.value); const menu = event.currentTarget.closest("details"); if (menu) { menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus(); } }}>{option.label}{movement === option.value && <Check size={14}/>}</button>)}</section></div></details>
          <details className={`${styles.columnMenu} ${styles.displayMenu} ${researchStyles.materialDisplayMenu}`}><summary><Columns3 size={14} aria-hidden="true"/>显示</summary><div><span className={styles.menuLabel}>显示列</span><div className={styles.columnGrid}>{columns.map(([id,label]) => <label key={id}><input type="checkbox" checked={preferences.columns.includes(id)} onChange={() => { const next = preferences.columns.includes(id) ? preferences.columns.filter(column => column !== id) : columns.map(([column]) => column).filter(column => column === id || preferences.columns.includes(column)); if (next.length) setPreferences({...preferences, columns: next}); }}/>{label}</label>)}</div><span className={styles.menuLabel}>浏览方式</span><div className={styles.ledgerMode} role="group" aria-label="台账查看模式"><button type="button" aria-pressed={preferences.view === "scroll"} onClick={() => setPreferences({...preferences,view:"scroll"})}>连续</button><button type="button" aria-pressed={preferences.view === "paged"} onClick={() => setPreferences({...preferences,view:"paged"})}>分页</button></div>{preferences.view === "paged" && <><span className={styles.menuLabel}>每页条数</span><div className={styles.pageSizeControl}>{[25,50,100].map(size => <button key={size} type="button" aria-pressed={preferences.pageSize === size} onClick={() => setPreferences({...preferences,pageSize:size})}>{size}</button>)}<input aria-label="自定义每页条目数" type="number" min="10" max="200" key={preferences.pageSize} defaultValue={preferences.pageSize} onBlur={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 10 && value <= 200) setPreferences({...preferences,pageSize:value}); else event.target.value = String(preferences.pageSize); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}/></div></>}</div></details>
        </LedgerToolbar>
        {!rows.length ? <div className={styles.inlineEmpty}><strong>没有符合条件的原料</strong><span>可切换范围或调整筛选条件。</span></div> : <div className={`${styles.tableWrap} ${styles.ledgerTableWrap}`}><table className={`${styles.table} ${styles.stickyTable} ${styles.decisionTable}`} style={{minWidth:tableWidth}}><colgroup><col style={{width:240}}/>{preferences.columns.map(id => <col key={id} style={{width:columns.find(([column]) => column === id)?.[2]}}/>)}</colgroup><thead><tr>{header("code","原料编号")}{preferences.columns.map(id => header(id, columns.find(([column]) => column === id)?.[1] ?? id))}</tr></thead><tbody>{visible.map(({material:item}) => <tr key={item.id}><td data-column="identity"><button id={`research-material-${item.id}`} className={styles.materialLink} type="button" onClick={() => setSelected(item.id)}><span><strong title={item.code}>{item.code}</strong></span><ChevronRight size={16} aria-hidden="true"/></button></td>{preferences.columns.map(id => <td data-column={id} key={id}>{cell(item,id)}</td>)}</tr>)}</tbody></table></div>}
        {preferences.view === "paged" && <LedgerPagination total={rows.length} page={safePage} pageSize={preferences.pageSize} onPageChange={setPage}/>}
      </LedgerFrame>}
    </section>
    {selected && data && <MaterialDrawer batches={data.batches} materialId={selected} canEdit={false} canManage={false} loadMaterial={detail} refreshEveryMs={10000} onClose={() => { const id = selected; setSelected(null); requestAnimationFrame(() => document.getElementById(`research-material-${id}`)?.focus()); }} />}
  </article>;
}
