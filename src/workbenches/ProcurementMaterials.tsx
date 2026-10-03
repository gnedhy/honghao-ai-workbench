import { useProcurementEditSession } from "./procurementEditSession";
import { useProcurementMaterialQuery } from "./procurementMaterialQuery";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, Clock3, Columns3, Ellipsis, FileUp, Info, PackageCheck, Pencil, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { fetchProcurementPreferences, saveProcurementPreferences } from "../api";
import type { ProcurementMaterial, ProcurementOverview, ProcurementPage, ProcurementPreferences } from "../types";
import { DecimalInput } from "../components/DecimalInput";
import { PriceMovement as Movement } from "../components/PriceMovement";
import { Drawer } from "../components/Drawer";
import { LedgerPagination } from "../components/LedgerPagination";
import type { DepartmentLedger } from "./ProcurementDistribution";
import { draftLedgerChange, formalLedgerChange } from "./procurementLedger";
import { PRICE_REASONS, REVIEW_REASONS, resolveReason} from "./procurementReasons";
import { PriceReview, ReasonSelect} from "./procurementPriceEditing";
import { ProcurementMaterialDrawer } from "./ProcurementMaterialDrawer";
import { ledgerCell, LedgerOperationRecords, price, formatPriceDate, formatShanghaiDateTime, updateStatusLabel } from "./ProcurementMaterialView";
import styles from "../components/WorkbenchSurface.module.css";
function Empty({title,detail}:{title:string;detail:string}) {return <div className={styles.empty}><PackageCheck size={21}/><strong>{title}</strong><p>{detail}</p></div>;}

const LEDGER_COLUMNS = [
  ["inventory_quantity", "库存量"], ["unit", "单位"], ["latest_price", "最新价格"], ["inventory_price", "库存价格"], ["change", "价格变化"],
  ["price_date", "价格日期"], ["modifier", "修改人"], ["status", "状态"], ["previous_latest_price", "上版价格"], ["in_transit_price", "在途价"], ["suggested_price", "建议价"],
] as const;
const MATERIAL_COLUMN_WIDTH = 240;
const LEDGER_COLUMN_WIDTHS: Record<string, number> = {
  inventory_quantity: 120,
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
  ledger_columns: LEDGER_COLUMNS.slice(0, 8).map(([id]) => id),
  history_view: "batches",
  ledger_view: "paged",
  ledger_page_size: 50,
};

export function ProcurementMaterials({ department, onOpenDepartmentMaterial, data, accessLevel, onRefresh, onSaved, onCreate, onImport, onPublish, onPageChange, focusPending, locateCode, startInEdit, onEditStarted }: { department?: DepartmentLedger; onOpenDepartmentMaterial: (id: string) => void; startInEdit: boolean; onEditStarted: () => void; data: ProcurementOverview; accessLevel: number; onRefresh: () => Promise<void>; onSaved: (data: ProcurementOverview) => void; onCreate: () => void; onImport: () => void; onPublish: () => void; onPageChange: (page: ProcurementPage) => void; focusPending: boolean; locateCode: string }) {
  const { preferences, update: savePreferences } = useProcurementPreferences();
  const current = department ? null : data.current_update;
  const materials=useMemo(()=>department?.materialIds?data.materials.filter(item=>department.materialIds!.includes(item.id)):data.materials,[data.materials,department?.materialIds]);
  const ledgerView=preferences?.ledger_view??DEFAULT_PREFERENCES.ledger_view;
  const pageSize=preferences?.ledger_page_size??DEFAULT_PREFERENCES.ledger_page_size;
  const session=useProcurementEditSession(data,Boolean(department),onSaved,onRefresh);
  const {edit,values,editDate,editReason,editError,saveOpen,expanded,reviewReasons,reviewError,cancelArmed,panelError,busy,edits,dirty,validEdits,pricePreview,unsaved,canEdit,canConfirm}=session;
  const queryState=useProcurementMaterialQuery(materials,data,current,edit,values,pageSize,ledgerView,focusPending,locateCode,Boolean(department?.selection));
  const {query,movement,editor,scope,sort,sortDirection,safePage,rows,allRows,visibleRows,selectedPerson,formalComparison,filterNotice}=queryState;
  const {setQuery,setMovement,setEditor,setScope,setSort,setSortDirection,setPage,setFilterNotice,filterTasks,resetSort}=queryState.actions;
  const {stopEditing,saveEdits,cancelRound,recover}=session.actions;
  const editors=data.editors??[];
  const formalChange=(item:ProcurementMaterial)=>formalLedgerChange(item,formalComparison);
  const errors=allRows.filter(row=>row.missing).length;
  const risks=allRows.filter(row=>row.risk?.status==="open").length;
  const pending=new Set(allRows.filter(row=>row.pending).map(row=>row.material.id));
  const toolbar=useRef<HTMLDivElement>(null), moreButton=useRef<HTMLElement|null>(null);
  const saveDialog=useRef<HTMLDialogElement>(null),saveButton=useRef<HTMLButtonElement>(null),cancelRoundButton=useRef<HTMLButtonElement>(null);
  const searchInput=useRef<HTMLInputElement>(null),summary=useRef<HTMLDivElement>(null);
  const [pageSizeInput,setPageSizeInput]=useState("50");
  const [selected,setSelected]=useState<string|null>(null),[newPrice,setNewPrice]=useState(false);
  const [panel,setPanel]=useState<"events"|null>(null);
  const [workColumns,setWorkColumns]=useState<{id:string;columns:string[]}|null>(null);
  useEffect(()=>{
    const dismiss=(event:PointerEvent)=>{
      toolbar.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu=>{if(!menu.contains(event.target as Node))menu.open=false;});
      const more=moreButton.current?.closest("details");if(more&&!more.contains(event.target as Node))more.open=false;
    };
    document.addEventListener("pointerdown",dismiss,true);return()=>document.removeEventListener("pointerdown",dismiss,true);
  },[]);
  const columnOptions: ReadonlyArray<readonly [string, string]> = current || edit ? [...LEDGER_COLUMNS.map(([id, label]) => [id, id === "status" ? "处理状态" : label] as const), ["draft_price", "待发布价"]] : LEDGER_COLUMNS;
  const savedColumns = current ? workColumns?.id === current.id ? workColumns.columns : ["unit", "latest_price", "draft_price", "change", "modifier", "status"] : preferences?.ledger_columns ?? DEFAULT_PREFERENCES.ledger_columns;
  const columns = [...savedColumns];
  if (edit) {
    for (const id of ["unit", "latest_price"]) if (!columns.includes(id)) columns.push(id);
    if (!columns.includes("draft_price")) columns.splice(columns.indexOf("latest_price") + 1, 0, "draft_price");
  }
  const activeFilterCount = Number(movement !== "all") + Number(scope !== "all");
  const columnWidth = (id: string) => current && id === "status" ? 150 : current && id === "change" ? 178 : LEDGER_COLUMN_WIDTHS[id] ?? 112;
  const tableWidth = (department?.selection ? 56 : 0) + MATERIAL_COLUMN_WIDTH + columns.reduce((total, id) => total + columnWidth(id), 0);

  const actionsRef=useRef(session.actions);actionsRef.current=session.actions;
  const sortKey=`${sort}:${sortDirection}`,lastSort=useRef(sortKey);
  useEffect(()=>{
    if(!edit||lastSort.current===sortKey)return;
    lastSort.current=sortKey;actionsRef.current.orderRows([...new Set([...rows,...allRows].map(row=>row.material.id))],sort,sortDirection);
  },[edit,rows,allRows,sortKey,sort,sortDirection]);
  useEffect(()=>{setPageSizeInput(String(pageSize));},[pageSize]);
  useEffect(()=>{if(focusPending)summary.current?.scrollIntoView({block:"nearest"});},[focusPending]);
  useEffect(()=>{if(locateCode)searchInput.current?.focus();},[locateCode]);
  const sortAllowed=sort==="code"||columns.includes(sort);
  useEffect(()=>{if(!sortAllowed)resetSort();},[sortAllowed,resetSort]);
  const movementLabels: Record<string, string> = { all: "全部", up: "上涨", down: "下降", flat: "持平", missing: "未定价", incomparable: "不可比较" };
  const scopeLabels: Record<string, string> = { all: "全部原料", involved: "本轮已录入", missing: "待补价", risk: "待确认" };
  const sortHeader = (id: string, label: string) => {
    if (id === "change" && edit) label = "本次变化";
    const sortable = ["code", "inventory_quantity", "latest_price", "previous_latest_price", "change", "price_date", "draft_price"].includes(id);
    return <th data-column={id === "code" ? "identity" : id} key={id} aria-sort={sortable && sort === id ? sortDirection : undefined}>
      {sortable ? <button className={styles.sortHeading} type="button" onClick={() => { setSort(id); setSortDirection(sort === id ? sortDirection === "ascending" ? "descending" : "ascending" : id === "code" ? "ascending" : "descending"); }}>{label}{sort === id && (sortDirection === "ascending" ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}</button> : label}
      {id === "change" && <button type="button" className={styles.comparisonInfo} aria-label={edit ? "本次变化：待发布价与最新价格比较" : current ? "价格变化：待发布价与最新价格比较；未录入项比较最新价格与上版价格" : "价格变化：最新价格与上版正式价格比较；价格相同显示 0.0%，无可比较价格显示暂无对比"} title={edit ? "待发布价与最新价格比较" : current ? "待发布价与最新价格比较；未录入项比较最新价格与上版价格" : "最新价格与上版正式价格比较；价格相同显示 0.0%，无可比较价格显示暂无对比；补充新原料不重置已有原料的比较；悬停涨跌幅查看比较价格和版本"}><Info size={14} /></button>}
      {id === "inventory_quantity" && <button type="button" className={styles.comparisonInfo} aria-label="库存量：仅显示整数部分，鼠标悬停数值可查看完整数值；排序使用原始数值" title="仅显示整数部分，鼠标悬停数值可查看完整数值；排序使用原始数值"><Info size={14} /></button>}
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
  const openMaterial = (id: string, editing = false) => { if (edit || department?.selection) return; if (department) { onOpenDepartmentMaterial(id); return; } setNewPrice(editing); setSelected(id); };
  const startEditing=()=>session.actions.startEditing([...new Set([...rows,...allRows].map(row=>row.material.id))],sort,sortDirection);
  const startRef=useRef({startEditing,onEditStarted});startRef.current={startEditing,onEditStarted};
  useEffect(()=>{if(startInEdit){startRef.current.startEditing();startRef.current.onEditStarted();}},[startInEdit]);
  useEffect(() => { if (saveOpen) saveDialog.current?.showModal(); }, [saveOpen]);
  const closeSave = () => {
    if (busy) return;
    session.actions.closeSave();
    window.requestAnimationFrame(() => saveButton.current?.focus({ preventScroll: true }));
  };
  const closePanel = () => { if (busy) return; setPanel(null); window.requestAnimationFrame(() => moreButton.current?.focus({ preventScroll: true })); };
  const toggleRow=(id:string)=>{
    session.actions.toggleReview(id);
    if(expanded!==id)requestAnimationFrame(()=>document.getElementById(`ledger-review-${id}`)?.querySelector<HTMLSelectElement>("select")?.focus());
  };
  const review=async(issueId:string,materialId:string)=>{if(await session.actions.review(issueId))requestAnimationFrame(()=>document.getElementById(`ledger-material-${materialId}`)?.focus());};
  return <section className={`${styles.section} ${styles.ledgerSection} ${department ? styles.distributionLedger : ""}`}>
    {unsaved.confirmation}
    {!department && <div className={`${styles.sectionHeading} ${styles.ledgerHeading}`}>
      <div><div className={styles.ledgerTitle}><h2>价格台账</h2><small>{rows.length} / {data.materials.length} 条</small></div><p className={styles.sectionDescription}>在台账内编辑价格，或导入报表批量更新；启用前，最新价格保持不变。</p></div>
      <div className={styles.ledgerActions}>
        {canEdit && edit && <><button ref={saveButton} className="primary-button" type="button" disabled={busy || !dirty || !validEdits} onClick={() => session.actions.openSave()}>保存修改{dirty ? `（${edits.length}）` : ""}</button><button className="secondary-button" type="button" disabled={busy} onClick={stopEditing}>取消编辑</button></>}
        {!edit && <>{canEdit && <button className={current ? "secondary-button" : "primary-button"} type="button" onClick={startEditing}><Pencil size={14} />编辑价格</button>}{!current && data.capabilities?.can_manage_catalog && <button className="secondary-button" type="button" onClick={onCreate}><Plus size={14} />新增原料</button>}{!current && canEdit && <button className="secondary-button" type="button" onClick={onImport}><FileUp size={14} />导入报表</button>}</>}
        {current && !edit && <div className={styles.ledgerRoundActions} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) moreButton.current?.closest("details")?.removeAttribute("open"); }} onKeyDown={event => { if (event.key === "Escape") { moreButton.current?.closest("details")?.removeAttribute("open"); moreButton.current?.focus(); } }}>
          <details className={`${styles.columnMenu} ${styles.ledgerMore}`}><summary aria-label="更多操作" title="更多操作" ref={node => { moreButton.current = node; }}><Ellipsis size={18} aria-hidden="true" /></summary><div>{data.capabilities?.can_manage_catalog && <button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onCreate(); }}>新增原料</button>}{canEdit && <button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onImport(); }}>导入报表</button>}<button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setPanel("events"); }}>操作记录</button></div></details>
        </div>}
      </div>
    </div>}
    {panelError && <p className={styles.error} role="alert">{panelError}</p>}
    <div className={styles.ledgerEditHint} data-open={Boolean(edit)} aria-hidden={!edit}><div><div className={styles.ledgerEditBar}><small>已修改 {edits.length} 项 · 保存包含其他页的修改；清空输入仅撤回本次修改。</small></div></div></div>
    {edit && saveOpen && <dialog ref={saveDialog} className={`${styles.confirmDialog} ${styles.saveDialog}`} aria-labelledby="ledger-save-title" onCancel={event => { event.preventDefault(); closeSave(); }}>
      <form onSubmit={event => { event.preventDefault(); void saveEdits(); }}>
        <div className={styles.panelHeading}><h2 id="ledger-save-title">保存价格修改</h2><button className="icon-button" type="button" aria-label="关闭保存确认" disabled={busy} onClick={closeSave}><X size={17} /></button></div>
        <p>本次修改 {edits.length} 项原料，保存后待启用。</p>
        <div className={styles.ledgerEditBar}>
          {edit.update_id ? <div className={styles.savedPriceDate}><span>价格日期</span><strong>{formatPriceDate(editDate)}</strong><small>沿用本轮日期</small></div> : <label>价格日期<input type="date" required value={editDate} disabled={busy} onChange={event => session.actions.changeDate(event.target.value)} /></label>}
        </div>
        {pricePreview.data ? <PriceReview preview={pricePreview.data} /> : <p>{edits.length?pricePreview.error ?? "正在核对价格变化…":"本次价格已与最新本轮数据一致，无需重复保存。"}{pricePreview.error && <button type="button" onClick={pricePreview.refresh}>重新核对</button>}</p>}
        <div className={styles.ledgerEditBar}><label>录价说明<ReasonSelect label="录价说明" options={PRICE_REASONS} placeholder="请选择说明" value={editReason} disabled={busy} onChange={session.actions.chooseReason} /></label></div>
        <p>{data.capabilities?.can_activate ? "确认并保存将同时确认以上高波动价格；启用前，最新价格保持不变。" : "保存后，最新价格保持不变；异常波动由有启用权的人员确认。"}</p>
        {editError && <div className={styles.error} role="alert"><p>{editError}</p><button type="button" disabled={busy} onClick={() => void recover()}>读取最新数据核对（保留输入）</button></div>}
        <div className={styles.panelActions}><button className="secondary-button" type="button" disabled={busy} onClick={closeSave}>返回编辑</button><button className="primary-button" type="submit" disabled={busy || !dirty || !validEdits || !editDate || !resolveReason(editReason) || !pricePreview.data}>{busy ? "正在保存" : "确认并保存"}</button></div>
      </form>
    </dialog>}
    {!department && data.scheduled_update && <div className={styles.ledgerSchedule}><Clock3 size={15} /><span>等待启用：{formatPriceDate(data.scheduled_update.price_date)} · {formatShanghaiDateTime(data.scheduled_update.activate_at)}，最新价格未改变。</span><button type="button" disabled={Boolean(edit)} onClick={() => onPageChange("batches")}>查看排期</button></div>}
    {current && !edit && <div ref={summary} className={styles.ledgerUpdate} aria-label="本轮更新摘要">
      <div><strong>本轮更新 · {formatPriceDate(current.price_date)}</strong><small>{current.source_name} · {current.status === "revalidation_required" ? "需要重新确认，原排期不会自动启用" : updateStatusLabel(current.status)}</small></div>
      <div className={styles.ledgerTaskCounts}><button type="button" onClick={() => filterTasks("involved")}>{current.input_items.length} 项涉及</button>{errors > 0 && <button type="button" onClick={() => filterTasks("missing")}>{errors} 项待补价</button>}{risks > 0 && <button type="button" onClick={() => filterTasks("risk")}>{risks} 项待确认</button>}</div>
      <small id="ledger-enable-status" className={styles.ledgerEnable}>{errors || risks ? `还需处理 ${errors} 项补价、${risks} 项波动确认` : canConfirm ? <><Check size={14} aria-hidden="true" />价格问题已处理</> : "等待有启用权的人员启用价格"}</small>
      {canConfirm && <button className="primary-button" type="button" disabled={busy || errors > 0 || risks > 0} aria-describedby="ledger-enable-status" onClick={onPublish}><PackageCheck size={14} />启用价格</button>}
      {data.capabilities?.can_cancel_round && <button ref={cancelRoundButton} className={`secondary-button ${cancelArmed ? styles.cancelArmed : ""}`} type="button" disabled={busy} onBlur={() => session.actions.armCancel(false)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); session.actions.armCancel(false); } }} onClick={() => { if (cancelArmed) void cancelRound(); else { session.actions.armCancel(true); } }}>{busy && cancelArmed ? "正在取消…" : cancelArmed ? "确认取消" : "取消更新"}</button>}
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
      {department?.actions}
    </div>
    {department?.notice}
    {(editor || activeFilterCount > 0) && <div className={styles.filterTags}>
      {editor && <span>人员：{selectedPerson}<button type="button" aria-label="清除人员筛选" onClick={() => setEditor("")}><X size={13} /></button></span>}
      {movement !== "all" && <span>价格 · {movementLabels[movement]}<button type="button" aria-label="清除价格筛选" onClick={() => setMovement("all")}><X size={13} /></button></span>}
      {current && scope !== "all" && <span>待发布 · {scopeLabels[scope]}<button type="button" aria-label="清除待发布筛选" onClick={() => setScope("all")}><X size={13} /></button></span>}
      <button className={styles.clearFilters} type="button" onClick={() => { setEditor(""); setMovement("all"); setScope("all"); }}>清除筛选</button>
    </div>}
    {filterNotice && <div role="status" className={styles.comparisonHelp}>{filterNotice}<button type="button" aria-label="关闭筛选提示" onClick={() => setFilterNotice("")}><X size={13} /></button></div>}
    {!rows.length ? <Empty title={editor && current && scope !== "all" ? "该人员暂无符合条件的待发布修改" : "没有符合条件的原料"} detail="可调整筛选条件或清除筛选。" /> : <div className={`${styles.tableWrap} ${styles.ledgerTableWrap}`}><table className={`${styles.table} ${styles.stickyTable} ${styles.decisionTable}`} style={{ minWidth: `${tableWidth}px` }}><colgroup>{department?.selection && <col style={{ width: 56 }} />}<col style={{ width: MATERIAL_COLUMN_WIDTH }} />{columns.map(id => <col key={id} style={{ width: columnWidth(id) }} />)}</colgroup><thead><tr>{department?.selection && <th data-column="selection">选择</th>}{sortHeader("code", "原料编号")}{columns.map(id => sortHeader(id, columnOptions.find(([column]) => column === id)?.[1] ?? id))}</tr></thead><tbody>{visibleRows.map(row => {
      const { material: item, input, risk } = row;
      const change = edit ? draftLedgerChange(item, values[item.id] ?? edit.originals[item.id] ?? "", formalComparison) : input ? draftLedgerChange(item, input.draft_price ?? "", formalComparison) : formalChange(item);
      const comparison = formalComparison?.items[item.id];
      const changeTitle = !edit && !input && comparison?.previous != null && ["up", "down", "unchanged"].includes(comparison.kind) ? `价格变化：${price(comparison.previous)} → ${price(item.published_price)}（v${comparison.previous_version ?? formalComparison?.previous_version} → v${comparison.version ?? data.batches[0]?.version}）${Number(comparison.previous) === 0 && comparison.change == null ? "；比较基准为零，无法计算涨跌幅" : ""}` : undefined;
      return <Fragment key={item.id}>
        <tr>{department?.selection && <td data-column="selection"><label className={styles.rangeSelectTarget}><input className={styles.rangeCheckbox} type="checkbox" aria-label={`关联 ${item.code}`} checked={department.selection.ids.includes(item.id)} disabled={department.selection.disabled} onChange={event => department.selection?.toggle(item.id, event.target.checked)} /></label></td>}<td data-column="identity">{department?.selection ? <span className={styles.materialLink}><span><strong title={item.code}>{item.code}</strong></span></span> : <button id={`ledger-material-${item.id}`} className={styles.materialLink} type="button" disabled={Boolean(edit)} onClick={() => openMaterial(item.id)}><span><strong title={item.code}>{item.code}</strong></span><ChevronRight size={16} aria-hidden="true" /></button>}</td>{columns.map(id => <td data-column={id} key={id}>{
          edit && id === "draft_price" ? <DecimalInput className={styles.ledgerPriceInput} aria-label={`${item.code}待发布价`} inputMode="decimal" disabled={busy} value={values[item.id] ?? edit.originals[item.id] ?? ""} placeholder="未调整" aria-invalid={Boolean(values[item.id]?.trim() && !/^\d+(\.\d+)?$/.test(values[item.id].trim()))} onChange={event => session.actions.changePrice(item.id,event.target.value)} onBlur={() => session.actions.retractPrice(item.id)} /> :
          current && id === "draft_price" ? input ? <strong>{input.draft_price == null ? "缺价" : price(input.draft_price)}</strong> : "—" :
          current && id === "status" ? <div className={styles.ledgerRowActions}>{edit ? <span>{row.state}</span> : row.missing ? canEdit ? <button className="secondary-button" type="button" onClick={() => openMaterial(item.id, true)}>补录价格</button> : <span>待补价</span> : risk ? <><span className={risk.status === "reviewed" ? undefined : styles.riskText}>{risk.status === "reviewed" ? "已确认" : "待确认"}</span><button className={styles.ledgerTextAction} type="button" disabled={busy} aria-expanded={expanded === item.id} aria-controls={`ledger-review-${item.id}`} onClick={() => toggleRow(item.id)}>{risk.status === "reviewed" ? "查看依据" : canConfirm ? "确认波动" : "查看波动"}</button></> : <span className={input ? undefined : styles.baselineEmpty}>{row.state}</span>}</div> :
          id === "change" ? <span title={changeTitle}>{typeof change === "string" ? change : <Movement value={change} />}</span> : ledgerCell(item, id, pending.has(item.id))
        }</td>)}</tr>
        {current && expanded === item.id && risk && <tr className={styles.ledgerReviewRow}><td colSpan={columns.length + 1}><div id={`ledger-review-${item.id}`} className={styles.ledgerReview} role="region" aria-label={`${item.code}价格波动确认`}>{risk.status === "reviewed" ? <div className={styles.ledgerReviewCopy}><strong>已确认价格波动</strong><p>确认依据：{risk.review_reason}</p></div> : canConfirm ? <><div className={styles.reviewControl}><ReasonSelect label={`${item.code}确认依据`} options={REVIEW_REASONS} placeholder="请选择确认依据" value={reviewReasons[risk.id]} disabled={busy} onChange={value => session.actions.chooseReviewReason(risk.id,value)} /><button type="button" disabled={busy || !resolveReason(reviewReasons[risk.id])} onClick={() => void review(risk.id, item.id)}>{busy ? "正在确认" : "确认波动"}</button></div>{reviewError && <p className={styles.error} role="alert">{reviewError}</p>}</> : <p>等待采购员确认。</p>}<button className={styles.ledgerTextAction} type="button" disabled={busy} onClick={() => { session.actions.toggleReview(null); document.getElementById(`ledger-material-${item.id}`)?.focus(); }}>收起</button></div></td></tr>}
      </Fragment>;
    })}</tbody></table></div>}
    {ledgerView === "paged" && <LedgerPagination total={rows.length} page={safePage} pageSize={pageSize} onPageChange={setPage}/>}
    </div>
    {current && panel && <LedgerPanel title="本轮操作记录" busy={busy} onClose={closePanel}>
      <p>{formatPriceDate(current.price_date)} · {current.input_items.length} 项原料</p>
      <LedgerOperationRecords update={current} />
    </LedgerPanel>}
    {selected && <ProcurementMaterialDrawer batches={data.batches} materialId={selected} canEdit={canEdit} canManage={Boolean(data.capabilities?.can_manage_catalog)} currentPriceDate={current?.price_date} startWithNewPrice={newPrice} onClose={() => { const id=selected; setSelected(null); requestAnimationFrame(()=>document.getElementById(`ledger-material-${id}`)?.focus()); }} onChanged={() => { setSelected(null); void onRefresh(); }} />}
  </section>;
}

function useProcurementPreferences() {
  const [preferences, setPreferences] = useState<ProcurementPreferences | null>(null);
  useEffect(() => { const controller = new AbortController(); fetchProcurementPreferences(controller.signal).then(setPreferences).catch(() => undefined); return () => controller.abort(); }, []);
  const update = async (next: Partial<ProcurementPreferences>) => setPreferences(await saveProcurementPreferences({ ...(preferences ?? DEFAULT_PREFERENCES), ...next }));
  return { preferences, update };
}

function LedgerPanel({ title, busy, onClose, children }: { fixedBody?: boolean; title: string; busy: boolean; onClose: () => void; children: React.ReactNode }) {
  return <Drawer title={title} busy={busy} onClose={onClose} bodyClassName={styles.ledgerPanelBody} closeLabel="关闭本轮面板">{children}</Drawer>;
}
