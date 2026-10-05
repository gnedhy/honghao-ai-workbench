import {useCallback, useEffect, useRef, useState, type ReactNode} from "react";
import {ChevronRight, Check, ArrowLeft, ArrowUp, ArrowDown} from "lucide-react";
import {linePriceMovement} from "./researchAnalytics";
import {Drawer as SharedDrawer} from "../components/Drawer";
import {fetchJson} from "../api";
import type {ResearchMaterialDetail, ResearchMaterialPrices} from "../types";
import {ReadOnlyMaterialDrawer} from "./ProcurementMaterialView";
import {type Adjustment, type Calculation, type Product, type ComparisonBasis, type Formula, type RecordRow, cost, yieldText, basis, adjustmentReasons} from "./researchModel";
import p from "../components/WorkbenchSurface.module.css";
import s from "./ResearchWorkbench.module.css";
export function ProductLink({ name, onClick, disabled = false }: { name: string; onClick: () => void; disabled?: boolean }) { return <button className={p.materialLink} type="button" disabled={disabled} onClick={onClick}><span><strong title={name}>{name}</strong></span><ChevronRight size={16} aria-hidden="true"/></button>; }
export function Money({ value, unit = "元/kg" }: { value: string | null | undefined; unit?: string }) { return <strong title={value == null ? "缺少核算价格" : `${cost(value)} ${unit}`}>{cost(value)}</strong>; }
export function ReasonFields({ value, onChange, expanded = false }: { value: Adjustment; onChange: (value: Adjustment) => void; expanded?: boolean }) {
  const options = <Options options={adjustmentReasons.map(label => ({value:label,label}))} value={value.adjustment_reason || ""} onChange={adjustment_reason => onChange({...value,adjustment_reason})} close/>;
  return <div className={s.reasonFields}><div><span>调整原因</span>{expanded ? <div className={s.reasonOptions}>{options}</div> : <Menu title={value.adjustment_reason || "请选择调整原因"}>{options}</Menu>}</div><label>调整说明{value.adjustment_reason === "其他" ? "（必填）" : "（选填）"}<textarea aria-label="调整说明" maxLength={1000} rows={2} value={value.adjustment_note || ""} onChange={event => onChange({...value,adjustment_note:event.target.value})}/></label></div>;
}
export function CostSource({ result }: { result?: Pick<Calculation, "auto_cost" | "cost_source" | "difference"> | null }) {
  return result?.cost_source === "manual" ? <small className={s.costSource}><span>手动</span> {result.auto_cost == null ? "自动核算异常" : `自动 ${cost(result.auto_cost)}`} · 差额 {cost(result.difference)}</small> : null;
}
export function Movement({ change, comparisonBasis }: { change: Product["change"]; comparisonBasis?: ComparisonBasis | null }) {
  const value = change?.percent;
  const comparisonLabel = comparisonBasis ? `；比较基准：${comparisonBasis.record_type === "backfill" ? `历史回算${comparisonBasis.purchase_version ? ` · 采购 v${comparisonBasis.purchase_version}` : ""}` : "正式成本记录"} ${comparisonBasis.effective_date || ""} · ${cost(comparisonBasis.latest_cost)} 元/kg` : "";
  return <span className={`${s.movement} ${value == null ? s.muted : value > 0 ? s.up : value < 0 ? s.down : s.stable}`} title={`${change?.reason || "最新优先成本与最近一次不同价格比较，金额先四舍五入到两位；相同价格延续上次变化"}${comparisonLabel}${value == null ? "" : `；变化 ${value.toFixed(1)}%`}`}>{value == null ? "暂无对比" : value !== 0 && Math.abs(value) < 0.1 ? `${value > 0 ? "+" : "-"}<0.1%` : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`}</span>;
}
export function Status({ row }: { row: Product }) { return <span className={`${s.status} ${row.status !== "ready" ? s.attention : ""}`}>{({ ready: "可核算", missing: "待补价格", updating: "更新中", failed: "更新失败" } as Record<string, string>)[row.status] ?? row.status}{row.has_draft ? " · 有草稿" : ""}</span>; }

export function Menu({ title, icon, children, className = "", chevron = true, count = 0 }: { title: string; icon?: ReactNode; children: ReactNode; className?: string; chevron?: boolean; count?: number }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = (focus = false) => { if (menu.current) menu.current.open = false; if (focus) menu.current?.querySelector("summary")?.focus(); };
  useEffect(() => { const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); }; document.addEventListener("pointerdown",outside); return () => document.removeEventListener("pointerdown",outside); }, []);
  return <details ref={menu} className={`${p.columnMenu} ${className}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (menu.current?.open && ["ArrowDown","ArrowUp"].includes(event.key) && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); event.stopPropagation(); const options = Array.from(menu.current.querySelectorAll<HTMLButtonElement>("button[data-menu-option]")); const index = options.indexOf(document.activeElement as HTMLButtonElement); options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus(); }
  }}><summary>{icon}{title}{count > 0 && <em>{count}</em>}{chevron && <ChevronRight size={13}/>}</summary><div>{children}</div></details>;
}
export function Options({ options, value, onChange, close = false }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; close?: boolean }) {
  return <div className={p.filterGroup}>{options.map(option => <button type="button" data-menu-option key={option.value} aria-pressed={value === option.value} onClick={event => { onChange(option.value); if (close) { const menu = event.currentTarget.closest("details"); if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); } } }}>{option.label}{value === option.value && <Check size={14}/>}</button>)}</div>;
}
export function OwnerMenu({ owners, value, onChange, emptyLabel = "全部负责人" }: { owners: string[]; value: string; onChange: (value: string) => void; emptyLabel?: string }) { return <Menu title={value || emptyLabel} className={p.personMenu}><Options options={[{value:"",label:emptyLabel},...owners.map(owner => ({value:owner,label:owner}))]} value={value} onChange={onChange} close/></Menu>; }

export function Drawer({ titleAction, title, label, onClose, onBack, backLabel, beforeClose, children, wide = false, busy = false }: { busy?: boolean; titleAction?: ReactNode; wide?: boolean; title: string; label: string; onClose: () => void; onBack?: () => void; backLabel?: string; beforeClose?: () => boolean | Promise<boolean>; children: ReactNode }) {
  return <SharedDrawer busy={busy} title={title} label={label} titleAction={titleAction} onClose={onClose} onBack={onBack} backLabel={backLabel} beforeClose={beforeClose} className={`${s.dialog} ${wide ? s.wideDialog : ""}`}>{children}</SharedDrawer>;
}

export function formulaRatio(quantity: string, total: number) {
  const amount = Number(quantity);
  return quantity.trim() && Number.isFinite(amount) && amount >= 0 && Number.isFinite(total) && total > 0 ? `${(amount / total * 100).toFixed(2)}%` : "—";
}

function MaterialDrilldown({line, historicalDate, onClose}: {line: Calculation["lines"][number]; historicalDate?: string; onClose: () => void}) {
  const [batches, setBatches] = useState<ResearchMaterialPrices["batches"]>([]);
  const loadMaterial = useCallback(async (code: string, signal?: AbortSignal) => {
    const base = "/api/workbenches/research/material-prices";
    const catalog = await fetchJson<ResearchMaterialPrices>(base, {signal});
    const material = catalog.materials.find(item => item.code === code);
    if (!material) throw new Error("此投料未关联当前原料价格目录");
    const detail = await fetchJson<ResearchMaterialDetail>(`${base}/${encodeURIComponent(material.id)}`, {signal});
    if (!signal?.aborted) setBatches(catalog.batches);
    return detail;
  }, []);
  return <ReadOnlyMaterialDrawer materialId={line.ref} batches={batches} loadMaterial={loadMaterial} refreshEveryMs={10000} onClose={onClose} backLabel="返回配方与成本" notice={<p className={s.explanation}>当前原料价格与完整价格历史。{historicalDate ? `${historicalDate} 历史成本中的` : "本层成本中的"}核算单价为 {cost(line.unit_cost)} 元/kg（{basis[line.basis] ?? line.basis}）。</p>}/>;
}

export function FormulaDetails({ formula, latest, inventory, comparison, onRef, policy, onPolicyChange, historicalDate, busy = false }: { formula: Formula; latest: Calculation | null; inventory: Calculation | null; comparison?: RecordRow; onRef: (id: string) => void; policy: "latest" | "inventory"; onPolicyChange: (policy: "latest" | "inventory") => void; historicalDate?: string; busy?: boolean }) {
  const [material, setMaterial] = useState<Calculation["lines"][number] | null>(null);
  const missing = [...new Set([...(latest?.missing_materials ?? []), ...(inventory?.missing_materials ?? [])])];
  if (!latest || !inventory) return <p className={s.notice}>此配方尚未启用，请补充投料并试算。</p>;
  const result = policy === "latest" ? latest : inventory;
  const totalInput = Number(result.total_input);
  const previous = comparison?.calculations?.[policy]?.[formula.id ?? ""] ?? (formula.id === (comparison?.product_id ?? comparison?.formula.id) ? comparison?.[policy] : undefined);
  const priceMovement = (line: Calculation["lines"][number]) => {
    const movement = linePriceMovement(line, previous?.lines);
    if (!movement) return null;
    const Icon = movement.direction === "up" ? ArrowUp : ArrowDown;
    const label = `核算单价${movement.direction === "up" ? "上涨" : "下降"}：${cost(movement.previous)} → ${cost(movement.current)} 元/kg`;
    return <span className={s.linePriceMovement} data-direction={movement.direction} role="img" aria-label={label} title={label}><Icon size={13} aria-hidden="true"/></span>;
  };
  return <><div className={s.dualCosts}><div><span>产品成本 · 最新优先</span><div className={s.costValue}><Money value={latest.cost}/><small>元/kg</small></div><CostSource result={latest}/></div><div><span>产品成本 · 库存优先</span><div className={s.costValue}><Money value={inventory.cost}/><small>元/kg</small></div><CostSource result={inventory}/></div></div>{formula.adjustment_reason && <p className={s.explanation}>调整原因：{formula.adjustment_reason}{formula.adjustment_note && ` · ${formula.adjustment_note}`}{formula.editor_name && ` · 编辑：${formula.editor_name}`}{formula.activator_name && ` · 启用：${formula.activator_name}`}</p>}
    {missing.length > 0 && <div role="alert" className={s.notice}>缺少核算价格：{missing.join("、")}。自动核算异常；已手动指定的口径采用手动成本。</div>}
    {Number(formula.yield) > 1 && <div className={s.notice}>原表收率为 {yieldText(formula.yield)}，已保留原值，请核对。</div>}
    <div className={s.formulaSummary}><span>本层收率 <strong>{yieldText(formula.yield)}</strong></span><span>总投料 <strong title={result.total_input}>{result.total_input} kg</strong></span><span>折合产出 <strong title={result.output_quantity}>{Number(result.output_quantity).toLocaleString("zh-CN", { maximumFractionDigits: 4 })} kg</strong></span></div>
    <div className={s.sectionHeading}><h3>投料明细 · {result.lines.length} 条</h3><div className={p.ledgerMode}><button aria-pressed={policy === "latest"} onClick={() => onPolicyChange("latest")}>最新优先</button><button aria-pressed={policy === "inventory"} onClick={() => onPolicyChange("inventory")}>库存优先</button></div></div>
    <div className={s.detailTable}><table className={`${p.table} ${s.formulaDetailsTable}`}><thead><tr><th>顺序</th><th>投料内编</th><th>配方比例</th><th>实际投料</th><th>核算单价</th><th>取价依据</th><th>金额</th></tr></thead><tbody>{result.lines.map((line,index) => <tr key={index}><td>{index+1}</td><td><ProductLink name={line.code} disabled={busy} onClick={() => line.kind === "material" ? setMaterial(line) : onRef(line.ref)}/></td><td>{formula.lines[index]?.ratio != null ? `${Number(formula.lines[index].ratio).toFixed(2)}%` : formulaRatio(line.quantity, totalInput)}</td><td title={line.quantity}>{line.quantity}<small className={s.cellUnit}>kg</small></td><td><Money value={line.unit_cost}/><small className={s.cellUnit}>/kg</small>{priceMovement(line)}</td><td>{basis[line.basis] ?? line.basis}</td><td><Money value={line.amount} unit="元"/></td></tr>)}</tbody></table></div>
    <p className={s.explanation}>本层成本＝投料金额合计 ÷ 总投料量 ÷ 本层收率。引用产品与复配原料沿整条计算链使用相同取价口径。</p>
    {material && <MaterialDrilldown line={material} historicalDate={historicalDate} onClose={() => setMaterial(null)}/>}

  </>;
}

export function HistoricalFormula({ record, initialPolicy = "latest", busy = false }: { record: RecordRow; initialPolicy?: "latest" | "inventory"; busy?: boolean }) {
  const [policy, setPolicy] = useState<"latest" | "inventory">(initialPolicy);
  const rootId = record.product_id ?? record.formula.id ?? record.id;
  const [path, setPath] = useState([rootId]); const current = path[path.length-1];
  const formula = current === rootId ? record.formula : record.graph?.find(item => item.id === current);
  const latest = current === rootId ? record.latest : record.calculations?.latest[current];
  const inventory = current === rootId ? record.inventory : record.calculations?.inventory[current];
  return <>{path.length > 1 && <button className={s.back} disabled={busy} onClick={() => setPath(path.slice(0,-1))}><ArrowLeft size={15}/>返回上层</button>}{formula && latest && inventory ? <><h3>{formula.name}</h3><FormulaDetails formula={formula} latest={latest} inventory={inventory} policy={policy} onPolicyChange={setPolicy} onRef={ref => setPath([...path,ref])} historicalDate={record.effective_date || record.recorded_at.slice(0,10)} busy={busy}/></> : <p className={s.notice}>该历史记录没有保存此引用的明细。</p>}</>;
}
