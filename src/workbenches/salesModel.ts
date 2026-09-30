export type Mode = "domestic_direct" | "domestic_intermediary" | "export_direct" | "export_intermediary";
export const modes: Record<Mode,string> = {domestic_direct:"国内直接厂",domestic_intermediary:"国内中间商",export_direct:"外贸直接厂",export_intermediary:"外贸中间商"};
export const reasons = ["客户现用价格","产品功能溢价","高浓／开稀价格对照","其他客户常规售价","客户议价","其他"];
export type Parameters = Partial<Record<"allocation"|"freight"|"barrel"|"tax"|"profit"|"reverse"|"export_addition_1"|"export_addition_2"|"export_multiplier",string|null>>;
export type Product = {id:string;code:string;name:string;source:string;department:string;latest_cost:string|null;inventory_cost:string|null;status:string;special_allocation:boolean;source_version:string|null;source_label?:string;source_date?:string|null};
export type Item = {product_id:string;external_name:string;cost_basis:"latest"|"inventory";parameters:Parameters;final_price:string|null;pricing_reasons:string[];pricing_note:string;reference_prices?:Record<string,string>;product?:Product;cost?:string|null;actual_basis?:string;result?:{normal_price:string;break_even_price:string|null}|null;trial_id?:string|null;manual_price_confirmed?:boolean;adopted?:boolean;voided?:boolean;manual_price?:boolean;adjustment_reason?:string};
export type Batch = {id:string;owner_id:string;revision:number;name:string;mode:Mode;customer_name:string;customer_code:string;uncoded:boolean;salesperson:string;items:Item[];created_at:string;updated_at:string;adjusted:boolean};
export type Trial = {customer_name?:string;customer_code?:string;uncoded?:boolean;salesperson?:string;id:string;batch_id:string;batch_name:string;created_at:string;actor_id:string;actor_name?:string;mode:Mode;items:Item[]};
export type Quote = {id:string;batch_id:string;batch_name:string;product_id:string;version:number;status:"active"|"superseded"|"void";created_at:string;actor_id:string;actor_name?:string;mode:Mode;current_customer_code?:string;current_uncoded?:boolean;customer_name:string;customer_code:string;salesperson:string;item:Item};
export const base = "/api/workbenches/sales";
export const pendingProductIds = (items:Pick<Item,"product_id"|"adopted"|"adjustment_reason">[]) => items.filter(row=>!row.adopted||!!row.adjustment_reason).map(row=>row.product_id);
export function adoptionExceptions(items:Item[], products:Product[], productIds:string[]) {
 const live = new Map(products.map(product => [product.id, product]));
 const selected = items.filter(item => productIds.includes(item.product_id));
 const changed = (item:Item) => {
  const current = live.get(item.product_id), saved = item.product;
  if(!current||!saved)return true;
  const keys = Object.keys(saved) as (keyof Product)[];
  return keys.length !== Object.keys(current).length || keys.some(key => !Object.hasOwn(current,key) || saved[key] !== current[key]);
 };
 return {
  stale: selected.filter(changed),
  belowBreakEven: selected.filter(item => item.final_price != null && item.result?.break_even_price != null && Number(item.final_price) < Number(item.result.break_even_price)),
 };
}
export function patchItems(items:Item[],ids:string[],patch:Partial<Item>,parameters:Parameters = {}):Item[] {
 return items.map(item => ids.includes(item.product_id) && (!item.adopted || !!item.adjustment_reason) ? {...item,...patch,parameters:{...item.parameters,...parameters},result:null,trial_id:null,manual_price_confirmed:false} : item);
}
export const parameterLabels:Record<keyof Parameters,string> = {allocation:"公摊（元）",freight:"运费（元）",barrel:"桶费（元）",tax:"税提成系数",profit:"利润系数",reverse:"反推核算比例",export_addition_1:"外贸加项一（元）",export_addition_2:"外贸加项二（元）",export_multiplier:"外贸系数"};
export const decimalText = (value:string|null|undefined) => value?.replace(/^(-?)\.(\d+)$/, "$10.$2") ?? "";

export type SalesEvent = {id:string;actor_id:string;actor_name?:string;created_at:string;kind:string;reason?:string;customer_code?:string;before?:string;after?:string;product_ids?:string[]};

export type QuoteListStatus = "pending" | "partial" | "adopted" | "void";

export function quoteListStatus(batch: Batch, records: Quote[]): QuoteListStatus {
 const current = new Set(records.filter(row => row.batch_id === batch.id && row.status === "active").map(row => row.product_id));
 const pending = batch.items.filter(row => !row.voided && (!row.adopted || !!row.adjustment_reason)).length;
 if (current.size && pending) return "partial";
 if (current.size) return "adopted";
 if (pending) return "pending";
 return batch.items.some(row => row.voided) ? "void" : "pending";
}

export function quoteTrendPoints(records: Quote[], productId: string, mode: Mode, start: string, end: string) {
 const price = (value: string | null | undefined) => value == null || value.trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);
 return records.filter(row => row.product_id === productId && row.mode === mode && row.created_at.slice(0, 10) >= start && row.created_at.slice(0, 10) <= end)
  .sort((a, b) => a.created_at.localeCompare(b.created_at))
  .map(row => ({
   date: new Date(row.created_at).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}),
   reference: price(row.item.result?.normal_price),
   adopted: price(row.item.final_price),
  }))
  .filter(point => point.reference !== null || point.adopted !== null);
}

export function defaultParameters(product: Product, mode: Mode, basis: "latest" | "inventory" = "latest"): Parameters {
 const cost = quoteCost(product, basis);
 const allocation = cost == null || product.special_allocation ? null : cost < 5 ? "0.5" : cost < 10 ? "0.8" : cost < 15 ? "1.2" : cost < 20 ? "1.5" : cost < 25 ? "1.8" : cost < 30 ? "2.2" : "2.5";
 return {allocation,freight:"0.3",barrel:"0.5",tax:mode === "domestic_direct" ? "1.11" : "1.09",profit:"1.1",reverse:mode === "domestic_direct" ? "1.07" : "1.04",export_addition_1:"0.75",export_addition_2:"1.65",export_multiplier:"1.15"};
}

export function costStatus(product: Product): string {
 if (product.status === "failed") return "核算失败";
 if (product.status === "updating") return "核算更新中";
 if (product.latest_cost == null && product.inventory_cost == null) return "缺少可用成本";
 if (product.latest_cost == null || product.inventory_cost == null) return "部分缺价已回退";
 return "正式成本";
}

export function productSourceText(product: Product): string {
 const label = product.source_label || costStatus(product);
 if (product.source === "procurement" && /^[a-f0-9]{64}$/i.test(product.source_version || "")) {
  return `暂无正式采购价 · ${product.inventory_cost == null ? "无可用库存价" : "库存价可用"}`;
 }
 return [label, product.source_version, product.source_date?.slice(0, 10)].filter(Boolean).join(" · ");
}

function quoteCost(product: Product, basis: "latest" | "inventory"): number | null {
 if (product.status !== "ready" && product.status !== "missing") return null;
 const valid = (value: string | null, kind: "latest" | "inventory") => value != null && (product.source === "research" || kind === "latest" || Number(value) > 0);
 const first = basis === "latest" ? product.latest_cost : product.inventory_cost;
 if (valid(first, basis)) return Number(first);
 const other = basis === "latest" ? "inventory" : "latest";
 const fallback = other === "latest" ? product.latest_cost : product.inventory_cost;
 return valid(fallback, other) ? Number(fallback) : null;
}

export function quoteReference(product: Product, basis:"latest"|"inventory" = "latest", overrides:Parameters = {}) {
 const cost = quoteCost(product, basis);
 if (cost == null) return {direct:null, intermediary:null, export:null};
 const tier = cost < 5 ? .5 : cost < 10 ? .8 : cost < 15 ? 1.2 : cost < 20 ? 1.5 : cost < 25 ? 1.8 : cost < 30 ? 2.2 : 2.5;
 const value = (key:keyof Parameters, fallback:number) => overrides[key] == null || overrides[key] === "" ? fallback : Number(overrides[key]);
 const allocation = overrides.allocation === "" ? NaN : value("allocation", product.special_allocation ? NaN : tier);
 const domestic = (tax:number, reverse:number) => !Number.isFinite(allocation) ? null : Math.round((cost + allocation + value("freight",.3) + value("barrel",.5)) * value("tax",tax) * value("profit",1.1) * value("reverse",reverse) * 100) / 100;
 const exportPrice = Math.round((cost + value("export_addition_1",.75) + value("export_addition_2",1.65)) * value("export_multiplier",1.15) * 100) / 100;
 return {direct:domestic(1.11,1.07), intermediary:domestic(1.09,1.04), export:exportPrice};
}
