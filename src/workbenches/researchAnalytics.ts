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
