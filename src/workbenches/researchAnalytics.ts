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
      const reason = direction === "none" ? "本期或上期缺少成本记录，暂无对比" : `较上一期最新优先成本（元/kg）：${(prior! / 100).toFixed(2)} → ${(current! / 100).toFixed(2)}${prior === 0 && current !== 0 ? "；上期为零，无法计算百分比" : ""}`;
      return { ...(row as T["products"][number]), period_change: { direction, percent: direction === "stable" ? 0 : priceChange(row.latest_cost, before ?? null), reason } };
    }) };
  }).reverse();
}

export function costComparisonRecord<T extends { latest_cost: string | null; inventory_cost: string | null }>(history: T[], index: number, policy: "latest" | "inventory") {
  const current = priceCents(history[index]?.[`${policy}_cost`]);
  if (current == null) return undefined;
  for (const previous of history.slice(index + 1)) {
    const value = priceCents(previous[`${policy}_cost`]);
    if (value == null) return undefined;
    if (value !== current) return previous;
  }
  return undefined;
}

export function linePriceMovement(line: { kind: string; ref: string; quantity: string; unit_cost: string | null }, previous: { kind: string; ref: string; quantity: string; unit_cost: string | null }[] | undefined) {
  if (!(Number(line.quantity) > 0)) return null;
  const before = previous?.find(item => item.kind === line.kind && item.ref === line.ref && Number(item.quantity) > 0);
  const current = priceCents(line.unit_cost), prior = priceCents(before?.unit_cost);
  if (current == null || prior == null || current === prior) return null;
  return { direction: current > prior ? "up" as const : "down" as const, current: line.unit_cost!, previous: before!.unit_cost! };
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
