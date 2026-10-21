import {HelpHint} from "../components/HelpHint";
import {PriceCards} from "../components/PriceCards";
import {useCallback, useId, useEffect, useRef, useState, type ReactNode} from "react";
import {ChevronRight, Check, ArrowLeft, ArrowUp, ArrowDown} from "lucide-react";
import {yieldNeedsReview, linePriceMovement, basisLabel} from "./researchAnalytics";
import {Drawer as SharedDrawer} from "../components/Drawer";
import {fetchJson} from "../api";
import type {ResearchMaterialDetail} from "../types";
import {ReadOnlyMaterialDrawer} from "./ProcurementMaterialView";
import {type Adjustment, type Calculation, type Product, type ComparisonBasis, type Formula, type RecordRow, type LineHistory, cost, numberText, yieldValue, yieldText, yieldBasis, basisText, adjustmentReasons} from "./researchModel";
import p from "../components/WorkbenchSurface.module.css";
import s from "./ResearchWorkbench.module.css";
export function ProductLink({ name, onClick, disabled = false }: { name: string; onClick: () => void; disabled?: boolean }) { return <button className={p.materialLink} type="button" disabled={disabled} onClick={onClick}><span><strong title={name}>{name}</strong></span><ChevronRight size={16} aria-hidden="true"/></button>; }
export function Money({ value, unit = "元/kg" }: { value: string | null | undefined; unit?: string }) { return <strong title={value == null ? "缺少核算价格" : `${value} ${unit}`}>{cost(value)}</strong>; }
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
  return <span className={`${s.movement} ${value == null ? s.muted : value > 0 ? s.up : value < 0 ? s.down : s.stable}`} title={`${change?.reason?.replaceAll("最新优先", "行情优先") || "行情优先成本与最近一次不同价格比较，金额先四舍五入到两位；相同价格延续上次变化"}${comparisonLabel}${value == null ? "" : `；变化 ${value}%`}`}>{value == null ? "暂无对比" : value !== 0 && Math.abs(value) < 0.01 ? `${value > 0 ? "+" : "-"}<0.01%` : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`}</span>;
}
export function Status({ row }: { row: Product }) { return <span className={`${s.status} ${row.status !== "ready" ? s.attention : ""}`}>{({ ready: "可核算", missing: "成本待完善", updating: "更新中", failed: "更新失败" } as Record<string, string>)[row.status] ?? row.status}{row.has_draft ? " · 有草稿" : ""}</span>; }

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

function PriceBasis({line}: {line: Calculation["lines"][number]}) {
  const label = basisLabel(line), detail = basisText(line).trim();
  const plain = !line.price_ref && !line.price_refs?.length && ["latest", "inventory", "historical_latest", "recipe", "composite", "missing"].includes(line.basis);
  const hint = !plain && detail && detail !== label ? detail : undefined;
  return hint ? <HelpHint label={label} detail={hint}/> : <span className={s.priceBasis}>{label}</span>;
}

function MaterialDrilldown({line, historicalDate, onClose}: {line: Calculation["lines"][number]; historicalDate?: string; onClose: () => void}) {
  const references = line.price_refs ?? [line.price_ref ?? line.ref];
  const [selectedReference, setSelectedReference] = useState(references[0]);
  const reference = references.includes(selectedReference) ? selectedReference : references[0];
  const loadMaterial = useCallback((code: string, signal?: AbortSignal) =>
    fetchJson<ResearchMaterialDetail>(`/api/workbenches/research/material-prices/by-code/${encodeURIComponent(code)}`, {signal}), []);
  return <ReadOnlyMaterialDrawer materialId={reference} batches={[]} loadMaterial={loadMaterial} refreshEveryMs={60000} onClose={onClose} backLabel="返回配方与成本" notice={<><p className={s.explanation}>当前原料价格与完整价格历史。{historicalDate ? `${historicalDate} 历史成本中的` : "本层成本中的"}核算单价为 {cost(line.unit_cost)} 元/kg（{basisText(line)}）。</p>{references.length > 1 && <Menu title={`查看参考料：${reference}`}><Options options={references.map(code => ({value: code, label: `${code} · ${cost(line.price_reference_values?.find(v => v.code === code)?.unit_cost)}`}))} value={reference} onChange={setSelectedReference} close/></Menu>}</>}/>;
}

export function FormulaDetails({ formula, latest, inventory, history, onRef, policy, onPolicyChange, historicalDate, trend, busy = false }: { formula: Formula; latest: Calculation | null; inventory: Calculation | null; history?: LineHistory[]; onRef: (id: string) => void; policy: "latest" | "inventory"; onPolicyChange: (policy: "latest" | "inventory") => void; historicalDate?: string; trend?: ReactNode; busy?: boolean }) {
  const panelId=useId();
  const [material, setMaterial] = useState<Calculation["lines"][number] | null>(null);
  if (!latest || !inventory) return <p className={s.notice}>此配方尚未启用，请补充投料并试算。</p>;
  const result = policy === "latest" ? latest : inventory;
  const missing = [...new Set(result.missing_materials)];
  const totalInput = Number(result.total_input);
  const previousLines = history?.map(record => (record.calculations?.[policy]?.[formula.id ?? ""] ?? (formula.id === (record.product_id ?? record.formula?.id) ? record[policy] : undefined))?.lines);
  const priceMovement = (line: Calculation["lines"][number]) => {
    const movement = linePriceMovement(line, previousLines);
    if (!movement) return null;
    const Icon = movement.direction === "up" ? ArrowUp : ArrowDown;
    const label = `核算单价${movement.direction === "up" ? "上涨" : "下降"}：${cost(movement.previous)} → ${cost(movement.current)} 元/kg`;
    return <span className={s.linePriceMovement} data-direction={movement.direction} role="img" aria-label={label} title={`${label}；按${policy === "latest" ? "行情" : "库存"}优先口径延续该投料上次变价，不受配方或收率更新影响。`}><Icon size={13} aria-hidden="true"/></span>;
  };
  return <><PriceCards label="产品成本口径" panelId={panelId} value={policy} onChange={onPolicyChange} disabled={busy} items={[{key:"latest",label:"产品成本 · 行情优先",amount:<Money value={latest.cost}/>,unit:"元/kg",description:<CostSource result={latest}/>},{key:"inventory",label:"产品成本 · 库存优先",amount:<Money value={inventory.cost}/>,unit:"元/kg",description:<CostSource result={inventory}/>} ]}/>{trend}{formula.adjustment_reason && <p className={s.explanation}>调整原因：{formula.adjustment_reason}{formula.adjustment_note && ` · ${formula.adjustment_note}`}{formula.editor_name && ` · 编辑：${formula.editor_name}`}{formula.activator_name && ` · 启用：${formula.activator_name}`}</p>}
    {(formula.department || formula.source_kind) && <p className={s.explanation}>{formula.department || "部门未记录"}{formula.source_kind === "erp_bom" ? " · ERP BOM" : ""}{formula.yield_source ? ` · 收率依据：${formula.yield_source.kind === "mes_mean" ? `MES工单平均（${formula.yield_source.count}行）` : yieldBasis[formula.yield_source.kind] || "来源未记录"}` : ""}</p>}
    {missing.length > 0 && <div role="alert" className={s.notice}>{policy === "latest" ? "行情优先" : "库存优先"}缺少核算价格：{missing.join("、")}。{result.cost_source === "manual" ? "当前口径采用已指定的手动成本。" : "当前口径自动成本待完善。"}</div>}
    {yieldNeedsReview(formula) && <div className={s.notice}>原表收率为 {yieldText(formula.yield)}，已保留原值，请核对。</div>}
    <div className={s.formulaSummary}><span>本层收率 <strong title={`${yieldValue(formula.yield)}%`}>{yieldText(formula.yield)}</strong></span><span>总投料 <strong title={`${result.total_input} kg`}>{numberText(result.total_input)} kg</strong></span><span>折合产出 <strong title={`${result.output_quantity} kg`}>{numberText(result.output_quantity)} kg</strong></span></div>
    <div className={s.sectionHeading}><h3>投料明细 · {result.lines.length} 条</h3></div>
    <div key={policy} id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${policy}`} className={`${s.detailTable} ${p.materialPricePanel}`}><table className={`${p.table} ${s.formulaDetailsTable}`}><thead><tr><th>顺序</th><th>投料内编</th><th>配方比例</th><th>实际投料</th><th>核算单价</th><th>取价依据</th><th>金额</th></tr></thead><tbody>{result.lines.map((line,index) => <tr key={index}><td>{index+1}</td><td>{line.restricted_reference ? <span title="跨部门引用，仅提供核算价格">{line.code}<small> · 跨部门引用</small></span> : <ProductLink name={line.code} disabled={busy} onClick={() => line.kind === "material" ? setMaterial(line) : onRef(line.ref)}/>}</td><td title={`${formula.lines[index]?.ratio ?? (Number(line.quantity) / totalInput * 100)}%`}>{formula.lines[index]?.ratio != null ? `${numberText(formula.lines[index].ratio)}%` : formulaRatio(line.quantity, totalInput)}</td><td title={`${line.quantity} kg`}>{numberText(line.quantity)}<small className={s.cellUnit}>kg</small></td><td><Money value={line.unit_cost}/><small className={s.cellUnit}>/kg</small>{priceMovement(line)}</td><td><PriceBasis line={line}/></td><td><Money value={line.amount} unit="元"/></td></tr>)}</tbody></table></div>
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
