import {HistoryBrowser} from "../components/HistoryBrowser";
import {PriceCards} from "../components/PriceCards";
import { useEffect, useId, useState } from "react";
import { ArrowRight, ChevronRight, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PriceMovement as Movement } from "../components/PriceMovement";
import { WorkbenchLoading } from "../components/WorkbenchLayout";
import { useExitTransition } from "../components/Interaction";
import { Drawer } from "../components/Drawer";
import type { ProcurementBatchDetail, ProcurementMaterial, ProcurementUpdate, ResearchMaterialDetail } from "../types";
import { materialPriceStatus } from "./procurementLedger";
import styles from "../components/WorkbenchSurface.module.css";

export function ChartEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className={`${styles.chartEmpty} ${styles.compactEmpty}`}><strong>{title}</strong><span>{detail}</span></div>;
}

export function ledgerCell(item: ProcurementMaterial, column: string, pending: boolean) {
  if (column === "data_source") return item.inventory_source?.catalog_source ?? "采购维护";
  if (column === "modifier") {
    const modifier = item.price_modifier;
    return modifier?.name ? <span className={styles.modifierCell}><span>{modifier.name}</span>{(item.round_participants?.length ?? 0) > 1 && <details><summary>本轮 {item.round_participants?.length} 人</summary><small>{item.round_participants?.map(person => person.name).join("、")}</small></details>}</span> : !modifier && item.published_price == null && item.source_purchasers?.length ? <span className={styles.modifierCell}>{item.source_purchasers.join("、")}</span> : "未记录";
  }
  if (column === "unit") return item.unit;
  if (column === "inventory_quantity") return item.inventory_quantity == null ? "—" : <span title={`${item.inventory_quantity} ${item.unit}`}>{Math.trunc(Number(item.inventory_quantity))}</span>;
  if (column === "latest_price") return item.published_price == null ? "—" : <strong><Price value={item.published_price}/></strong>;
  if (column === "previous_latest_price") return item.previous_published_price == null ? "—" : <strong><Price value={item.previous_published_price}/></strong>;
  if (column === "price_date") return item.published_price_date ? formatPriceDate(item.published_price_date) : "—";
  if (column === "status") return <span className={`${styles.statusPill} ${pending ? styles.statusPending : item.published_price == null ? item.inventory_price == null ? styles.statusMissing : styles.statusPending : styles.statusOk}`}>{pending ? "待处理" : materialPriceStatus(item)}</span>;
  if (column === "in_transit_price") return <Price value={item.in_transit_price}/>;
  if (column === "inventory_price") return item.inventory_price == null ? "—" : <strong><Price value={item.inventory_price}/></strong>;
  return <Price value={item.suggested_price}/>;
}


export function focusWithoutScroll(node: HTMLButtonElement | null) { node?.focus({ preventScroll: true }); }

export function recordDialogKeys(event: React.KeyboardEvent<HTMLElement>) {
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')).filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
  if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.querySelector<HTMLButtonElement>('button[aria-label="关闭详情"]')?.click(); }
  if (event.key === "Tab" && controls.length) {
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
  }
}

export function LedgerOperationRecords({ update }: { update: ProcurementUpdate }) {
  const events = [...update.events].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const system = (event: typeof events[number]) => ["created", "migrated"].includes(event.event);
  const render = (event: typeof events[number]) => {
    const items = update.changes?.find(change => change.id === event.id)?.items ?? [];
    const reason = event.event === "prices_adjusted" ? event.reason?.replace(/^修改 \d+ 项原料；/, "") : event.reason;
    const prices = <div className={styles.operationPrices}>{items.map(item => <div key={item.id}><strong>{item.code}</strong><span>{item.before_recorded ? <Price value={item.before}/> : "未记录"}<ArrowRight size={13} aria-label="修改为" /><b>{<Price value={item.after}/>}</b></span></div>)}</div>;
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

export function ChangePrices({ items }: { items: NonNullable<NonNullable<ProcurementBatchDetail["changes"]>[number]["items"]> }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return <p>未记录该次价格明细。</p>;
  const known = items.filter(item => item.before_recorded && item.before !== null && item.after !== null);
  const up = known.filter(item => Number(item.after) > Number(item.before)).length;
  const down = known.filter(item => Number(item.after) < Number(item.before)).length;
  return <><p>本次保存 {items.length} 项：上涨 {up} · 下降 {down} · <span className={styles.stableText}>未变 {known.length - up - down}</span>{known.length < items.length ? ` · 不可比较 ${items.length - known.length}` : ""}（较修改前报价或当时价格）</p><div className={styles.changePrices}><table className={styles.table}><thead><tr><th>原料</th><th>修改前</th><th>修改后</th><th>变化</th></tr></thead><tbody>{(expanded ? items : items.slice(0, 3)).map(item => <tr key={item.id}><td><strong>{item.code}</strong><span>{item.unit}</span></td><td>{item.before_recorded ? <>{<Price value={item.before}/>}<small>{item.before_basis === "published" ? "当时价格" : "保存前有效价"}</small></> : "未记录修改前价格"}</td><td><strong>{<Price value={item.after}/>}</strong></td><td><Movement value={item.change === null ? null : item.change * 100} /></td></tr>)}</tbody></table></div>{items.length > 3 && <button className="secondary-button" type="button" onClick={() => setExpanded(value => !value)}>{expanded ? "收起明细" : `展开全部 ${items.length} 项`}</button>}</>;
}

export function price(value?: string | null) { return value == null ? "—" : `¥${value}`; }
export function Price({ value }: { value?: string | null }) {
  return value == null ? "—" : !value.trim() || !Number.isFinite(Number(value)) ? <span title={value}>{value}</span> : <span title={price(value)}>¥{Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}
export function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
export function formatShanghaiDateTime(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "—"; }
export function formatPriceDate(value: string) { return value.slice(0, 10).replaceAll("-", "."); }
export function shortDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
export function updateEventLabel(event: string) { return ({ prices_adjusted: "批量编辑价格", cancelled: "取消本轮", created: "创建本轮更新", imported: "导入价格", price_adjusted: "修正价格", submitted: "提交复核", returned: "退回修改", risk_reviewed: "确认高风险变动", scheduled: "安排定时启用", activated: "启用", revalidation_required: "要求重新确认", schedule_cancelled: "撤销排期", copied_from_schedule: "复制为新草稿", migrated: "迁移现有工作稿" } as Record<string, string>)[event] ?? event; }

type Batches = Array<{ id: string; comparison?: { added_material_ids?: string[] } | null }>;
export function MaterialPriceBody({detail,batches,notice}: {detail: ResearchMaterialDetail; batches: Batches; notice?: React.ReactNode}) {
  const materialId=detail.material.id;
  const priceTabsId = useId();
  const [selected, setSelected] = useState<{id: string; kind: "market" | "inventory"} | null>(null);
  const carriedBatches = new Set(batches.filter(batch => batch.comparison?.added_material_ids?.length && !batch.comparison.added_material_ids.includes(materialId)).map(batch => batch.id));
  const official = (detail?.official_history ?? []).filter(item => !carriedBatches.has(item.id));
  const latestOfficial = official.at(-1), previousOfficial = official.at(-2);
  const comparison = detail?.comparison;
  const previousPrice = comparison ? comparison.previous : previousOfficial?.latest_price;
  const change = comparison ? comparison.change == null ? null : comparison.change * 100 : latestOfficial?.latest_price != null && previousPrice != null && Number(previousPrice) !== 0 ? (Number(latestOfficial.latest_price) / Number(previousPrice) - 1) * 100 : null;
  const trend = official.filter(item => item.latest_price != null).map(item => ({date: item.version_date, price: Number(item.latest_price)}));
  const validPriceCount = trend.length;
  const hasMarket = latestOfficial?.latest_price != null;
  const hasInventory = detail.material.inventory_price != null;
  const inventoryAvailable = hasInventory || detail.material.inventory_quantity != null || !!detail.material.inventory_source;
  const showInventory = hasMarket && inventoryAvailable && selected?.id === materialId ? selected.kind === "inventory" && inventoryAvailable : !hasMarket && inventoryAvailable;
  const prices = [
    {kind: "market" as const, label: "行情价格", value: latestOfficial?.latest_price, available: hasMarket},
    {kind: "inventory" as const, label: "库存价格", value: detail.material.inventory_price, available: inventoryAvailable},
  ].filter(item => item.available);
  return <div className={`${styles.drawerBody} ${styles.materialPriceBody}`}>{notice}
        {prices.length ? <PriceCards label="价格口径" panelId={`${priceTabsId}-panel`} value={showInventory ? "inventory" : "market"} onChange={kind=>setSelected({id:materialId,kind})} items={prices.map(item=>({key:item.kind,label:item.label,amount:item.value==null?"暂无库存价":<Price value={item.value}/>,unit:`元/${detail.material.unit}`}))}/> : <p className={styles.sectionDescription}>暂无行情价格和库存价格</p>}
        {prices.length === 1 && <p className={styles.sectionDescription}>{hasMarket ? "暂无库存价格" : "暂无行情价格"}</p>}
        <div key={`${materialId}-${showInventory ? "inventory" : "market"}`} className={styles.materialPricePanel} id={`${priceTabsId}-panel`} role={prices.length === 2 ? "tabpanel" : undefined} aria-labelledby={prices.length === 2 ? `${priceTabsId}-panel-${showInventory ? "inventory" : "market"}` : undefined}>
        {showInventory ? <><section className={styles.drawerSection} aria-label="库存信息"><h3>库存信息</h3>
          <dl className={styles.historySource}><div><dt>库存数量</dt><dd><strong title={detail.material.inventory_quantity ?? undefined}>{detail.material.inventory_quantity == null ? "—" : Number(detail.material.inventory_quantity).toLocaleString("zh-CN", {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong> {detail.material.unit}</dd></div>
          {detail.material.inventory_source && <><div><dt>数据来源</dt><dd>{detail.material.inventory_source.source}</dd></div><div><dt>库存截止日期</dt><dd>{detail.material.inventory_source.as_of}</dd></div><div><dt>导入时间</dt><dd>{formatShanghaiDateTime(detail.material.inventory_source.imported_at)}</dd></div></>}</dl>
          <p className={styles.sectionDescription}>库存记录按批次更新。</p>
        </section><section className={styles.drawerSection} aria-label="库存价格走势"><h3>库存价格走势</h3><ChartEmpty title="暂无走势" detail={hasInventory ? "仅有一期库存记录，暂无走势。" : "暂无有效库存价格记录。"}/></section></> : <>
        {hasMarket && <dl className={`${styles.historySource} ${styles.materialMarketMeta}`}><div><dt>上版价格</dt><dd><Price value={previousPrice}/> <Movement value={change}/></dd></div><div><dt>价格日期</dt><dd>{latestOfficial?.price_date ? formatPriceDate(latestOfficial.price_date) : "—"}</dd></div></dl>}
        {validPriceCount > 0 && <section className={styles.drawerSection}><h3>行情价格走势</h3>{trend.length < 2 ? <ChartEmpty title="暂无可比较周期" detail="至少需要两期有效价格。" /> : <div className={styles.detailChart}><ResponsiveContainer width="100%" height="100%"><LineChart data={trend} margin={{top: 12, right: 16, bottom: 8, left: 0}}><CartesianGrid stroke="#edf0f1" vertical={false} /><XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: "#69747d", fontSize: 11 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: "#69747d", fontSize: 11 }} axisLine={false} tickLine={false} width={42} /><Tooltip formatter={(value) => [price(String(value)), "参考价"]} /><Line isAnimationActive={false} type="monotone" dataKey="price" stroke="#2f3337" strokeWidth={2} dot={{ r: 2.5 }} /></LineChart></ResponsiveContainer></div>}</section>}
        {official.length > 0 && <section className={styles.drawerSection}><h3>行情历史<small>{validPriceCount} 期有效价格</small></h3><div className={styles.priceHistory}><HistoryBrowser key={materialId} items={[...official].reverse()} date={item=>item.version_date} text={item=>`${item.version_date} v${item.version} ${item.modifier?.name??""}`} empty="尚无行情历史。">{items=><><div className={styles.priceHistoryHeading} aria-hidden="true"><span>版本日期</span><span>价格</span><span>修改人</span><span /></div>{items.map(item => <details className={styles.priceHistoryRecord} key={item.id}><summary aria-label={`v${item.version} ${formatPriceDate(item.version_date)}，价格 ${item.latest_price == null ? item.raw_price ?? "未定价" : price(item.latest_price)}，修改人 ${item.modifier?.name || "未记录"}`}><span className={styles.historyDate}>{formatPriceDate(item.version_date)}<small>v{item.version}</small></span><strong>{item.latest_price == null ? item.raw_price ?? "未定价" : <Price value={item.latest_price}/>}</strong><span>{item.modifier?.name || "未记录"}</span><ChevronRight size={13} aria-hidden="true" /></summary><dl className={styles.historySource}><div><dt>价格来源日期</dt><dd>{item.price_date ? formatPriceDate(item.price_date) : "未记录"}</dd></div><div><dt>数据位置</dt><dd>{[item.sheet, item.cell].filter(Boolean).join(" · ") || "未记录"}</dd></div></dl></details>)}</>}</HistoryBrowser></div></section>}
        </>}
        </div>
        {detail.adjustments.length > 0 && <section className={styles.drawerSection}><div><span>修正记录</span><h3>完整留痕</h3></div><div className={styles.adjustmentList}>{detail.adjustments.map((item) => <article key={item.id}><strong>{item.reason}</strong><span>{item.created_by} · {formatDate(item.created_at)}</span></article>)}</div></section>}
        {detail.sources.length > 0 && <details className={styles.sourceDetails} key={detail.material.id}><summary><span>数据来源</span><small>{detail.sources.length} 处</small><ChevronRight size={14} aria-hidden="true" /></summary>{Array.from(new Set(detail.sources.map(source => source.filename))).map(filename => <div className={styles.sourceFile} key={filename}><p>{filename}</p><ul>{detail.sources.filter(source => source.filename === filename).map(source => <li key={`${source.sheet}-${source.row}`}><span>{source.sheet}<small>第 {source.row} 行</small></span><span>{source.purchaser || "未填写"}</span></li>)}</ul></div>)}</details>}
        {!!detail.changes?.length && <details className={`${styles.sourceDetails} ${styles.materialChanges}`} key={`changes-${detail.material.id}`}><summary><span>修改记录</span><small>{detail.changes.length} 条</small><ChevronRight size={14} aria-hidden="true" /></summary>{detail.changes.map(change=><article key={change.id}><div className={styles.changeByline}><span>{change.actor}</span><time>{formatShanghaiDateTime(change.created_at)}</time></div>{change.status === "cancelled" && <p className={styles.cancelledChange}>已取消，不影响价格</p>}<p>{change.reason}</p><ChangePrices items={change.items ?? []} /></article>)}</details>}
  </div>;
}

// The caller supplies its authorized read endpoint; this module has no write API.
export function ReadOnlyMaterialDrawer({batches,materialId,loadMaterial,refreshEveryMs,refreshKey,onClose,backLabel,notice}: {
  batches: Batches; materialId: string; loadMaterial: (id: string,signal?: AbortSignal)=>Promise<ResearchMaterialDetail>;
  refreshEveryMs?: number; refreshKey?: unknown; onClose: ()=>void; backLabel?: string; notice?: React.ReactNode;
}) {
  const [detail,setDetail]=useState<ResearchMaterialDetail|null>(null);
  const [failed,setFailed]=useState("");
  const [retry,setRetry]=useState(0);
  const {closing,close}=useExitTransition(onClose);
  useEffect(()=>{
    const controller=new AbortController(); let pending=false;
    setDetail(value=>value?.material.id===materialId || value?.material.code===materialId ? value : null); setFailed("");
    const load=async()=>{
      if(pending)return; pending=true;
      try { const value=await loadMaterial(materialId,controller.signal); if(!controller.signal.aborted){setDetail(value);setFailed("");} }
      catch(error) {if(!controller.signal.aborted){if(error instanceof Error && "status" in error && (error.status===401||error.status===403||error.status===404))setDetail(null);setFailed(error instanceof Error ? error.message : "原料详情读取失败");}}
      finally {pending=false;}
    };
    void load(); const timer=refreshEveryMs?window.setInterval(()=>{if(!document.hidden)void load();},refreshEveryMs):null;
    return ()=>{controller.abort();if(timer!==null)clearInterval(timer);};
  },[materialId,loadMaterial,refreshEveryMs,refreshKey,retry]);
  const body = !detail ? failed ? <div className={styles.drawerLoading}><span><strong>原料详情暂时不可用</strong><p role="alert">{failed}</p><button className="secondary-button" type="button" onClick={()=>setRetry(value=>value+1)}>重新加载</button></span></div> : <WorkbenchLoading local title="正在读取原料详情"/> : <MaterialPriceBody detail={detail} batches={batches} notice={<>{notice}{failed&&<p role="alert" className={styles.error}>价格更新失败，当前显示上次读取的内容。<button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></p>}</>}/>;
  if(backLabel) return <Drawer title={detail?.material.code ?? materialId} label="原料详情" onClose={onClose} backLabel={backLabel} closeLabel="关闭原料详情" bodyClassName={styles.materialDrawerBody}>{body}</Drawer>;
  return <div inert={closing} className={`${styles.drawerLayer} ${closing?styles.closing:""}`} role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)close();}} onKeyDown={event=>recordDialogKeys(event)}>
    <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="原料价格详情">
      <header className={styles.drawerHeader}><div><span>原料详情</span><h2>{detail?detail.material.code:"正在读取"}</h2></div><div className={styles.drawerHeaderActions}><button className="icon-button" type="button" aria-label="关闭详情" ref={focusWithoutScroll} onClick={close}><X size={17}/></button></div></header>
      {body}
    </aside>
  </div>;
}

export function updateStatusLabel(status: ProcurementUpdate["status"]) { return ({ draft: "录入价格", returned: "继续修改", submitted: "待启用", scheduled: "等待定时启用", revalidation_required: "需要重新确认", published: "已启用", cancelled: "已取消" } as const)[status]; }
