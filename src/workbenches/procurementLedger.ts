import type { ProcurementBatch, ProcurementIssue, ProcurementMaterial, ProcurementUpdate } from "../types";

export function editedPriceChange(value: string, reference: string | null | undefined): number | null {
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || reference == null) return null;
  const amount = Number(value), base = Number(reference);
  if (!Number.isFinite(amount) || !Number.isFinite(base)) return null;
  return base === 0 ? amount === 0 ? 0 : null : (amount - base) / Math.abs(base) * 100;
}

export function summarizeUpdate(items: ProcurementUpdate["input_items"]) {
  return items.reduce((counts, item) => {
    if (item.draft_price == null) counts.missing++;
    else if (item.change == null) counts.incomparable++;
    else if (item.change > 0) counts.up++;
    else if (item.change < 0) counts.down++;
    else counts.flat++;
    return counts;
  }, { up: 0, down: 0, flat: 0, incomparable: 0, missing: 0 });
}

export function collectPriceEdits(values: Record<string, string>, originals: Record<string, string>) {
  const normalize = (value: string) => value.trim().replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return Object.entries(values).filter(([id, value]) => value.trim() && normalize(value) !== normalize(originals[id] ?? ""))
    .map(([material_id, price]) => ({ material_id, price: price.trim() }));
}

export function buildLedgerRows(materials: ProcurementMaterial[], update: ProcurementUpdate | null) {
  const inputs = new Map(update?.input_items.map(item => [item.material_id, item]));
  const issues = new Map<string, ProcurementIssue[]>();
  for (const issue of update?.issues ?? []) {
    if (issue.status === "resolved") continue;
    issues.set(issue.material_id, [...(issues.get(issue.material_id) ?? []), issue]);
  }
  return materials.map(material => {
    const input = inputs.get(material.id);
    const problems = issues.get(material.id) ?? [];
    const missing = problems.some(issue => issue.kind === "missing_price" && issue.status === "open");
    const risk = problems.find(issue => issue.kind === "price_spike");
    const state = missing ? "待补价" : risk?.status === "open" ? "待确认" : risk?.status === "reviewed" ? "已确认" : !input ? "未录入" : "待发布";
    return { material, input, problems, missing, risk, state, pending: missing || risk?.status === "open" };
  });
}

export function formalLedgerChange(item: ProcurementMaterial, comparison?: ProcurementBatch["comparison"]) {
  const entry = comparison?.items[item.id];
  if (entry) return entry.change == null ? null : entry.change * 100;
  return item.published_price == null ? null : editedPriceChange(item.published_price, item.previous_published_price);
}

export function draftLedgerChange(item: ProcurementMaterial, value: string, comparison?: ProcurementBatch["comparison"]): number | string {
  if (!value.trim()) return "—";
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || !Number.isFinite(Number(value))) return "不可比较";
  if (item.published_price == null) return comparison?.items[item.id]?.kind === "incomparable" ? "不可比较" : "首次定价";
  return editedPriceChange(value, item.published_price) ?? "不可比较";
}

export function filterLedgerRows(rows: ReturnType<typeof buildLedgerRows>, options: {
  query: string; movement: string; scope: string; editor: string; selectedPerson: string;
  current: ProcurementUpdate | null; comparison?: ProcurementBatch["comparison"];
  sort: string; sortDirection: "ascending" | "descending";
  edit: { originals: Record<string, string>; order?: string[]; sort?: string; sortDirection?: string } | null; values: Record<string, string>;
}) {
  const { query, movement, scope, editor, selectedPerson, current, comparison, sort, sortDirection, edit, values } = options;
  const roundOnly = Boolean(current && scope !== "all");
  const editOrder = edit?.order && edit.sort === sort && edit.sortDirection === sortDirection ? new Map(edit.order.map((id, index) => [id, index])) : null;
  const value = (row: typeof rows[number]): number | string | null => {
    const item = row.material;
    if (sort === "price_date") return item.published_price_date || null;
    if (sort === "change") {
      const change = edit ? draftLedgerChange(item, values[item.id] ?? edit.originals[item.id] ?? "", comparison) : row.input ? draftLedgerChange(item, row.input.draft_price ?? "", comparison) : formalLedgerChange(item, comparison);
      return typeof change === "number" ? change : null;
    }
    const raw = sort === "draft_price" ? edit ? values[item.id] ?? edit.originals[item.id] : row.input?.draft_price : sort === "previous_latest_price" ? item.previous_published_price : item.published_price;
    return raw == null || !/^\d+(\.\d+)?$/.test(String(raw).trim()) || !Number.isFinite(Number(raw)) ? null : Number(raw);
  };
  return rows.filter(row => {
    const item = row.material, change = formalLedgerChange(item, comparison);
    const missing = item.published_price == null && comparison?.items[item.id]?.kind !== "incomparable";
    const matchesMovement = movement === "all" || (movement === "up" && change !== null && change > 0) || (movement === "down" && change !== null && change < 0) || (movement === "flat" && change === 0) || (movement === "missing" && missing) || (movement === "incomparable" && !missing && change === null);
    const matchesScope = !current || scope === "all" || (scope === "involved" && Boolean(row.input)) || (scope === "missing" && row.missing) || (scope === "risk" && row.risk?.status === "open");
    const people = roundOnly ? item.round_participants : item.participants;
    const sourceMatches = !roundOnly && Boolean(selectedPerson && item.source_purchasers?.includes(selectedPerson));
    return `${item.code} ${item.name}`.toLowerCase().includes(query.trim().toLowerCase()) && matchesMovement && matchesScope && (!editor || people?.some(person => person.id === editor) || sourceMatches);
  }).sort((a, b) => {
    if (editOrder) return (editOrder.get(a.material.id) ?? rows.length) - (editOrder.get(b.material.id) ?? rows.length);
    const pendingOrder = Number(Boolean(b.input)) - Number(Boolean(a.input));
    if (pendingOrder) return pendingOrder;
    const codeOrder = a.material.code.localeCompare(b.material.code, "zh-CN", { numeric: true });
    if (sort === "code") return sortDirection === "ascending" ? codeOrder : -codeOrder;
    const av = value(a), bv = value(b);
    if (av === null || bv === null) return av === bv ? codeOrder : av === null ? 1 : -1;
    const result = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
    return (sortDirection === "ascending" ? result : -result) || codeOrder;
  });
}
