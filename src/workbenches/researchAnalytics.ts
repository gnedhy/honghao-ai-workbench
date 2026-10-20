export type CostGapDirection = "all" | "latest" | "inventory";

// Decimal strings from the calculator are rounded before any price comparison.
export function priceCents(value: string | null | undefined): number | null {
  if (value == null) return null;
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const fraction = (match[3] ?? "").padEnd(3, "0");
  const cents = Number(BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1n : 0n));
  return Number.isFinite(cents) ? (match[1] ? -cents : cents) : null;
}

export function priceChange(current: string | null, previous: string | null): number | null {
  const left = priceCents(current), right = priceCents(previous);
  return left == null || right == null || right === 0 ? null : (left - right) / right * 100;
}

// History compares adjacent periods; the ledger keeps its last-price-movement comparison.
export function compareCostPeriods<T extends { record_type?: string; purchase_version?: number; products: { id: string; latest_cost: string | null }[] }>(versions: T[]) {
  let costVersion = Math.max(0, ...versions.filter(version => version.record_type === "backfill").map(version => version.purchase_version ?? 0));
  const previous = new Map<string, string | null>();
  return [...versions].reverse().map(version => {
    return { ...version, cost_version: version.record_type === "backfill" ? version.purchase_version : ++costVersion, products: version.products.map(row => {
      const before = previous.get(row.id), current = priceCents(row.latest_cost), prior = priceCents(before);
      previous.set(row.id, row.latest_cost);
      const direction = current == null || prior == null ? "none" : current === prior ? "stable" : current > prior ? "up" : "down";
      const reason = direction === "none" ? "本期或上期缺少成本记录，暂无对比" : `较上一期行情优先成本（元/kg）：${(prior! / 100).toFixed(2)} → ${(current! / 100).toFixed(2)}${prior === 0 && current !== 0 ? "；上期为零，无法计算百分比" : ""}`;
      return { ...(row as T["products"][number]), period_change: { direction, percent: direction === "stable" ? 0 : priceChange(row.latest_cost, before ?? null), reason } };
    }) };
  }).reverse();
}

type PricedLine = { kind: string; ref: string; quantity: string; unit_cost: string | null };
export function linePriceMovement(line: PricedLine, history: (readonly PricedLine[] | undefined)[] | undefined) {
  const current = priceCents(line.unit_cost);
  if (!(Number(line.quantity) > 0) || current == null) return null;
  for (const lines of history ?? []) {
    const matches = lines?.filter(item => item.kind === line.kind && item.ref === line.ref && Number(item.quantity) > 0) ?? [];
    const before = matches[0], prior = priceCents(before?.unit_cost);
    // Missing or ambiguous evidence breaks the chain; never infer a replacement material.
    if (!before || prior == null || matches.some(item => priceCents(item.unit_cost) !== prior)) return null;
    if (current !== prior) return { direction: current > prior ? "up" as const : "down" as const, current: line.unit_cost!, previous: before.unit_cost! };
  }
  return null;
}

export function rankCostGaps<T extends { name: string; status: string; latest_cost: string | null; inventory_cost: string | null }>(products: T[], direction: CostGapDirection) {
  return products.flatMap(product => {
    if (product.status !== "ready" || product.latest_cost == null || product.inventory_cost == null) return [];
    const latest = priceCents(product.latest_cost), inventory = priceCents(product.inventory_cost);
    if (latest == null || inventory == null) return [];
    const gap = (latest - inventory) / 100;
    if (gap === 0 || (direction === "latest" && gap < 0) || (direction === "inventory" && gap > 0)) return [];
    return [{ ...product, gap }];
  }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}
export function yieldNeedsReview(row: {yield: string; source_kind?: string; yield_source?: {kind: string}}) {
  return Number(row.yield) > 1 && !(row.source_kind === "erp_bom" && ["mes_mean", "bom_ratio_sum", "user_confirmed"].includes(row.yield_source?.kind ?? ""));
}

const numberFormatter = new Intl.NumberFormat("zh-CN", {minimumFractionDigits:2,maximumFractionDigits:2});
export function numberText(value: string | null | undefined) {
  const cents = priceCents(value);
  return cents == null ? "—" : numberFormatter.format(cents / 100);
}

export function yieldValue(value: string) {
  const parts = value.trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!parts) return "—";
  const fraction = parts[2] ?? "";
  return `${BigInt(parts[1]) * 100n + BigInt(fraction.padEnd(2,"0").slice(0,2))}${fraction.length > 2 ? `.${fraction.slice(2)}` : ""}`;
}
export const yieldText = (value: string) => `${numberText(yieldValue(value))}%`;

const basisNames: Record<string,string> = {confirmed_manual_inventory_price:"确认库存",confirmed_purchase_reference_inventory_price:"采购参考",confirmed_historical_inventory_price:"历史参考",reference_mean:"参考均价",unpriced_zero_assumption:"缺价零算",erp_inventory_fallback:"库存兜底",zero_input:"零量忽略",latest:"行情价格",historical_latest:"当期价格",current_latest_fallback:"行情补位",current_inventory_fallback:"库存补位",inventory:"库存价格",recipe:"引用产品",composite:"复配核算",missing:"缺少价格"};
export function basisLabel(line: {basis:string;price_ref?:string;price_refs?:string[]}) {
  if (line.basis.startsWith("cf232_")) return "浓度折价";
  if (line.price_refs?.length) return "参考均价";
  if (line.price_ref) return "参考取价";
  return basisNames[line.basis] ?? "核算依据";
}

// Match the existing backend access scope without rewriting the source department.
export const researchDepartment = (row: {department?: string | null}): string => row.department || "研发五部";

type CostRecordDate = {effective_date?: string; recorded_at: string; record_type?: string};
export function compareCostRecords(a: CostRecordDate, b: CostRecordDate) {
  const date = (row: CostRecordDate) => (row.effective_date || row.recorded_at).slice(0,10);
  return date(a).localeCompare(date(b)) || Number(a.record_type !== "backfill")-Number(b.record_type !== "backfill") || a.recorded_at.localeCompare(b.recorded_at);
}

export function dailyCostRecords<T extends CostRecordDate>(records: T[]): T[] {
  // One plotted value per date; frozen duplicates remain available in the history list.
  return [...new Map([...records].sort(compareCostRecords).map(row => [(row.effective_date || row.recorded_at).slice(0,10), row])).values()];
}

// Index once per overview revision; never scan every product's entire history on a tab change.
export function indexCostHistory<T extends {id: string; effective_date?: string; recorded_at: string; record_type?: string}>(versions: {effective_date?: string; recorded_at: string; products: T[]}[]) {
  const result = new Map<string, T[]>();
  for (const version of versions) for (const row of version.products) {
    const records = result.get(row.id) ?? [];
    records.push({...row, effective_date: row.effective_date || version.effective_date, recorded_at: row.recorded_at || version.recorded_at});
    result.set(row.id, records);
  }
  for (const records of result.values()) records.sort(compareCostRecords);
  return result;
}
