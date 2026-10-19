import {fetchJson} from "../api";
import {numberText} from "./researchAnalytics";
export type InputLine = { code: string; kind: "material" | "recipe" | "composite"; ref: string; restricted_reference?: boolean; price_ref?: string; price_refs?: string[]; quantity: string; ratio?: string; source_row?: number | null };
export type Adjustment = { adjustment_reason?: string; adjustment_note?: string };
export type Formula = Adjustment & { manual_costs?: Partial<Record<"latest" | "inventory", string | null>>; edited_by?: string; activated_by?: string; editor_name?: string; activator_name?: string; ratio_linked?: boolean; ratio_base?: string; id?: string; name?: string; owner?: string; department?: string; source_kind?: string; yield_source?: {kind:string; count?:number; source_rows?:number[]}; kind?: string; yield: string; lines: InputLine[]; sheet?: string; source_row?: number | null };
export type Calculation = { auto_cost?: string | null; manual_cost?: string | null; cost_source?: "auto" | "manual"; difference?: string | null; cost: string | null; yield: string; total_input: string; output_quantity: string; missing_materials: string[]; lines: (InputLine & { unit_cost: string | null; amount: string | null; basis: string; price_reference_values?: {code: string; unit_cost: string | null; basis: string}[] })[] };
export type Graph = { latest: Record<string, Calculation>; inventory: Record<string, Calculation> };
export type ComparisonBasis = { record_type?: string; purchase_version?: number; effective_date?: string; latest_cost?: string | null };
export type Product = { cost_details?: Partial<Record<"latest" | "inventory", Pick<Calculation, "auto_cost" | "cost_source" | "difference">>>; comparison_basis?: ComparisonBasis | null; lifecycle?: "active" | "draft" | "inactive"; id: string; name: string; owner: string; department?: string; source_kind?: string; yield_source?: {kind:string; count?:number; source_rows?:number[]}; yield: string; lines: number | InputLine[]; revision: number; has_draft: boolean; status: string; latest_cost: string | null; inventory_cost: string | null; change: { percent: number | null; reason: string }; recorded_at: string; missing_materials: string[]; sheet?: string; source_row?: number | null };
export type RecordRow = Product & { purchase_version?: number; period_change?: { direction: string; percent: number | null; reason: string }; latest: Calculation; inventory: Calculation; formula: Formula; graph?: Formula[]; calculations?: Graph; reason?: string; effective_date?: string; record_type?: "formal" | "backfill"; event_id?: string; id: string; product_id?: string };
export type Version = { cost_version?: number; record_type?: "formal" | "backfill"; purchase_version?: number; effective_date?: string; id: string; reason: string; recorded_at: string; products: RecordRow[] };
export type Detail = { capabilities?: {can_activate:boolean}; referenced_by?: {id:string;name:string}[]; product: Product; latest: Calculation | null; inventory: Calculation | null; recipes: Formula[]; calculations?: Graph; draft: { revision: number; formula: Formula; simulation_token?: string; simulation?: Simulation | null } | null; history: RecordRow[]; draft_revision: number; options: { owners: string[]; materials: { code: string }[]; recipes: { id: string; name: string }[]; composites: { id: string; name: string }[] } };
export type Simulation = { current_latest: Calculation; current_inventory: Calculation; latest: Calculation; inventory: Calculation; affected: { id: string; name: string }[]; simulation_token: string; blocking: string[]; warnings: string[] };
export const base = "/api/workbenches/research";
export const productPath = (id: string) => `${base}/products/${encodeURIComponent(id)}`;
export const request = <T,>(url: string, method: string, body: unknown) => fetchJson<T>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const cost = (value: string | null | undefined) => { const text = numberText(value); return text === "—" ? text : `¥${text}`; };
export {numberText, yieldValue, yieldText} from "./researchAnalytics";
export const yieldBasis: Record<string,string> = {user_confirmed:"业务确认指定",manual_edit:"编辑时调整",bom_ratio_sum:"BOM明细比例合计"};
export const date = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export const formulaVersionLabel = (row: Product) => row.lifecycle === "draft" || !row.revision ? "新配方 · 尚未启用" : `${row.lifecycle === "inactive" ? "已停用 · " : ""}配方 v${row.revision}`;
export const lineCount = (row: Product) => Array.isArray(row.lines) ? row.lines.length : row.lines;
export const errorText = (error: unknown) => error instanceof Error ? error.name === "TimeoutError" ? "数据读取超过15秒，请重试。" : error.message : "操作未完成，请重试。";
export const basis: Record<string, string> = { confirmed_manual_inventory_price: "已确认库存核算价", confirmed_purchase_reference_inventory_price: "采购参考价（库存核算）", confirmed_historical_inventory_price: "历史库存参考价", reference_mean: "参考原料有价算术平均", unpriced_zero_assumption: "未提供价格，按0核算", erp_inventory_fallback: "BOM缺价，采用ERP库存", zero_input: "零投料不参与核算", cf232_latest: "CF232行情价格×浓度", cf232_inventory: "CF232库存价×浓度", cf232_historical_latest: "CF232当期价×浓度", cf232_current_latest_fallback: "CF232当前行情价格×浓度", cf232_current_inventory_fallback: "CF232当前库存价×浓度", latest: "行情价格", historical_latest: "当期行情价格", current_latest_fallback: "当前行情价格补位", current_inventory_fallback: "当前库存价格补位", inventory: "库存价格", recipe: "引用产品成本", composite: "复配计算成本", missing: "缺少价格" };
export const basisText = (line: { basis: string; price_ref?: string; price_refs?: string[]; price_reference_values?: {unit_cost: string | null}[] }) => {
  const label = basis[line.basis] ?? line.basis;
  if (line.price_refs?.length) {
    const values = line.price_reference_values;
    return `${label} · ${line.price_refs.join("／")}${values ? `（${values.filter(v => v.unit_cost != null).length}/${values.length}有价）` : ""}`;
  }
  return `${label}${line.price_ref ? ` · 按${line.price_ref}取价` : ""}`;
};
export const adjustmentReasons = ["配方优化", "实际投料修正", "收率修正", "成本核对修正", "临时成本测算", "其他"];
export const recordDate = (row: { effective_date?: string; recorded_at: string }) => (row.effective_date || row.recorded_at).slice(0, 10);
