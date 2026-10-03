import { createClientId as id } from "../clientId";
import { money as format, type Mode, type Product } from "./salesModel";
export { money as format } from "./salesModel";

export type Operation = "+" | "-" | "*" | "/";
export type Tier = { upper: string | null; amount: string };
export type Step = {
  id: string;
  label: string;
  operation: Operation;
  value: string | null;
  automatic_allocation: boolean;
  fee: boolean;
  allocation_step?: boolean;
  tiers?: Tier[] | null;
};
export type Panel = {
  id: string;
  name: string;
  mode: Mode;
  direction: "forward" | "reverse";
  target_price: string;
  steps: Step[];
};
export type Source = {
  kind: "manual" | "product" | "snapshot";
  product_id?: string | null;
  basis?: "latest" | "inventory";
  cost?: string | null;
  special_allocation?: boolean;
  product_code?: string;
  source_version?: string;
};
export type Result = {
  price: string;
  target_cost: string | null;
  cost_gap: string | null;
  allocation_amount?: string;
  trail: { id: string; value: string }[];
};
export type Evaluation = {
  source: Source;
  results: { id: string; result: Result | null; error: string | null }[];
  default_allocation_tiers: Tier[];
};
export type Saved = {
  id: string;
  kind: "template" | "workspace";
  name: string;
  revision: number;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};
export type TierDraft = { panelId: string; stepId: string; rows: Tier[]; error: string };

export const dateLabel = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
export const basisLabel = (basis?: Source["basis"]) => basis === "inventory" ? "库存优先" : "最新优先";
export const operationLabel: Record<Operation, string> = { "+": "+", "-": "−", "*": "×", "/": "÷" };

export function defaults(mode: Mode, special = false): Step[] {
  const row = (label: string, operation: Operation, value: string | null, fee = false, automatic_allocation = false, allocation_step = false): Step =>
    ({ id: id(), label, operation, value, fee, automatic_allocation, allocation_step });
  if (mode.startsWith("export")) return [
    row("外贸加项一", "+", "0.75", true),
    row("外贸加项二", "+", "1.65", true),
    row("外贸系数", "*", "1.15"),
  ];
  return [
    row(special ? "特殊公摊" : "公摊", "+", special ? "" : null, true, !special, true),
    row("运费", "+", "0.3", true),
    row("桶费", "+", "0.5", true),
    row("税提成系数", "*", mode === "domestic_direct" ? "1.11" : "1.09"),
    row("利润系数", "*", "1.1"),
    row("反推核算比例", "*", mode === "domestic_direct" ? "1.07" : "1.04"),
  ];
}

export const makePanel = (name: string, special = false, mode: Mode = "domestic_direct"): Panel =>
  ({ id: id(), name, mode, direction: "forward", target_price: "", steps: defaults(mode, special) });
export const initialProduct = (products: Product[]) =>
  products.find(row => !row.special_allocation && row.latest_cost != null)
  ?? products.find(row => !row.special_allocation && row.inventory_cost != null)
  ?? products[0];
export const initialSource = (products: Product[]): Source => {
  const product = initialProduct(products);
  return product
    ? { kind: "product", product_id: product.id, basis: product.latest_cost != null ? "latest" : "inventory" }
    : { kind: "manual", cost: "" };
};
export const initialPanels = (special = false) => [makePanel("面板 1", special), makePanel("面板 2", special)];
export const fingerprint = (source: Source, panels: Panel[]) => JSON.stringify({ source, panels });
export const isAllocation = (step: Step) =>
  !!(step.allocation_step || step.automatic_allocation || step.tiers || step.label.includes("公摊"));
export const incompleteStep = (panel: Panel) => panel.steps.findIndex(step =>
  !step.label.trim() || (!step.automatic_allocation && !step.value?.trim()));

export function scaledDecimal(value: string): bigint | null {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d{1,18})?|\.\d{1,18})$/.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const amount = BigInt(whole || "0") * 10n ** 18n + BigInt(fraction.padEnd(18, "0") || "0");
  return amount <= 1_000_000_000n * 10n ** 18n ? amount : null;
}

export function tierError(rows: Tier[]): string {
  if (!rows.length) return "至少保留一档公摊";
  let lower = 0n;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (scaledDecimal(row.amount) == null) return `第 ${index + 1} 档公摊金额无效`;
    if (index === rows.length - 1) {
      if (row.upper !== null) return "最后一档须为无上限";
      continue;
    }
    const upper = row.upper == null ? null : scaledDecimal(row.upper);
    if (upper == null || upper <= lower) return `第 ${index + 1} 档成本上限须高于前一档`;
    lower = upper;
  }
  return "";
}

export function tierRows(rows: Tier[], cost?: string | null) {
  let lower = 0n;
  let lowerLabel = "0";
  const currentCost = scaledDecimal(cost ?? "");
  return rows.map(row => {
    const upper = row.upper == null ? null : scaledDecimal(row.upper);
    const active = currentCost != null && currentCost >= lower && (upper == null || currentCost < upper);
    const tier = { lower: lowerLabel, upper: row.upper ?? "无上限", bounded: row.upper != null, amount: format(row.amount), active };
    if (upper != null) { lower = upper; lowerLabel = row.upper!; }
    return tier;
  });
}
