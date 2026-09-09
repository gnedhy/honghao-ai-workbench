import type { ProcurementBatchDetail } from "../types";

type PriceMaterial = {
  code: string;
  latest_price?: string | null;
  previous_latest_price?: string | null;
};

type PriceHistoryItem = {
  material_code: string;
  latest_price?: string | null;
  recorded_at: string;
};

type PriceRecord = {
  latest_price?: string | null;
};

export function buildPriceMovement(materials: PriceMaterial[]) {
  const counts = { rising: 0, falling: 0, stable: 0, unavailable: 0 };
  const ranked: Array<{ code: string; changePercent: number }> = [];

  for (const material of materials) {
    const current = toNumber(material.latest_price);
    const previous = toNumber(material.previous_latest_price);
    if (current === null || previous === null || (previous === 0 && current !== 0)) {
      counts.unavailable += 1;
      continue;
    }
    if (current === previous) {
      counts.stable += 1;
      continue;
    }
    const changePercent = Number((((current - previous) / previous) * 100).toFixed(2));
    counts[changePercent > 0 ? "rising" : "falling"] += 1;
    ranked.push({ code: material.code, changePercent });
  }

  ranked.sort((left, right) => Math.abs(right.changePercent) - Math.abs(left.changePercent));
  return { counts, ranked };
}

export function buildPriceTrend(history: PriceHistoryItem[], materialCode: string) {
  return history
    .filter((item) => item.material_code === materialCode)
    .map((item) => ({ recordedAt: item.recorded_at, value: toNumber(item.latest_price) }))
    .filter((item): item is { recordedAt: string; value: number } => item.value !== null)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

export function buildPublishedPriceMovement(materials: Array<{ id: string; code: string }>, comparison?: { up: number; down: number; unchanged: number; first: number; missing: number; items?: Record<string, { change: number | null }> }) {
  const ranked = materials.flatMap(item => {
    const change = comparison?.items?.[item.id]?.change;
    return change != null && Number.isFinite(change) && change !== 0 ? [{ code: item.code, changePercent: change * 100 }] : [];
  }).sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
  const counts = { rising: comparison?.up ?? 0, falling: comparison?.down ?? 0, stable: comparison?.unchanged ?? 0, first: comparison?.first ?? 0, unavailable: comparison?.missing ?? 0 };
  return { ranked, counts, comparable: counts.rising + counts.falling + counts.stable };
}

export function buildRangeDistribution(batches: ProcurementBatchDetail[], range: { start: string; end: string }) {
  const ordered = [...batches].sort((a, b) => (b.price_date || b.published_at).localeCompare(a.price_date || a.published_at) || b.version - a.version);
  const latest = ordered.find(batch => (batch.price_date || batch.published_at).slice(0, 10) <= range.end);
  const previous = ordered.find(batch => (batch.price_date || batch.published_at).slice(0, 10) <= range.start);
  if (!latest) return null;
  const counts = { rising: 0, falling: 0, stable: 0, first: 0, unavailable: 0, incomparable: 0 };
  const ranked: Array<{ code: string; changePercent: number }> = [];
  for (const item of latest.items) {
    const prior = previous?.items.find(row => row.material_id === item.material_id);
    const source = latest.snapshot_sources?.[item.material_id];
    const priorSource = previous?.snapshot_sources?.[item.material_id];
    const current = toNumber(source?.raw_price ?? item.latest_price);
    const before = toNumber(priorSource?.raw_price ?? prior?.latest_price);
    if (source && !["number", "missing"].includes(source.price_kind)) { counts.incomparable++; continue; }
    if (current === null) { counts.unavailable++; continue; }
    if (priorSource && !["number", "missing"].includes(priorSource.price_kind)) { counts.incomparable++; continue; }
    if (before === null) { counts.first++; continue; }
    if (current === before) { counts.stable++; continue; }
    if (before === 0) { counts.incomparable++; continue; }
    const changePercent = (current - before) / before * 100;
    counts[changePercent > 0 ? "rising" : "falling"]++;
    ranked.push({ code: item.code, changePercent });
  }
  return { counts, ranked, comparable: counts.rising + counts.falling + counts.stable };
}

export function countValidPrices(history: PriceRecord[]) {
  return history.filter((item) => toNumber(item.latest_price) !== null).length;
}

export function moverDateRange(end: string, preset: "14d" | "1m" | "3m") {
  const [year, month, day] = end.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  if (preset === "14d") start.setUTCDate(start.getUTCDate() - 14);
  else {
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - (preset === "1m" ? 1 : 3));
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay));
  }
  return { start: start.toISOString().slice(0, 10), end };
}

export function buildVersionMovers(batches: ProcurementBatchDetail[], months: 0 | 1 | 3 | { start: string; end: string } = 0) {
  const custom = typeof months === "object" ? months : null;
  const end = custom?.end ?? batches.map(batch => (batch.price_date || batch.published_at).slice(0, 10)).sort().at(-1);
  if (custom && (!/^\d{4}-\d{2}-\d{2}$/.test(custom.start) || !/^\d{4}-\d{2}-\d{2}$/.test(custom.end) || custom.start >= custom.end)) return [];
  let cutoff = "";
  if (custom) cutoff = custom.start;
  else if (months && end) cutoff = moverDateRange(end, months === 1 ? "1m" : "3m").start;
  const histories = new Map<string, Array<{ batchId: string; version: number; date: string; item: ProcurementBatchDetail["items"][number]; value: number }>>();
  for (const batch of [...batches].sort((a, b) => b.version - a.version)) {
    if (end && (batch.price_date || batch.published_at).slice(0, 10) > end) continue;
    for (const item of batch.items) {
      const source = batch.snapshot_sources?.[item.material_id];
      const value = toNumber(item.latest_price);
      if (value === null || (source && source.price_kind !== "number")) continue;
      const date = source?.price_date || batch.price_date || batch.published_at;
      if (end && date.slice(0, 10) > end) continue;
      const history = histories.get(item.material_id) ?? [];
      // Carry-forward snapshots are not new quotations.
      const carried = history.find(record => record.date === date && record.value === value);
      if (carried) {
        if (batch.price_date === date) { carried.batchId = batch.id; carried.version = batch.version; }
        continue;
      }
      history.push({ batchId: batch.id, version: batch.version, date, item, value });
      histories.set(item.material_id, history);
    }
  }
  return [...histories].flatMap(([materialId, history]) => {
    const [latest, prior] = history.sort((a, b) => b.date.localeCompare(a.date) || b.version - a.version);
    const previous = months ? history.find(record => record.date.slice(0, 10) <= cutoff) : prior;
    if (!previous || previous.value === 0 || latest.value === previous.value) return [];
    const changePercent = (latest.value - previous.value) / previous.value * 100;
    return Number.isFinite(changePercent) ? [{ ...latest, materialId, previous: previous.item.latest_price, previousDate: previous.date, changePercent }] : [];
  }).sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent) || a.item.code.localeCompare(b.item.code));
}

export function sortBatchPrices(batch: ProcurementBatchDetail, column: string, direction: "ascending" | "descending") {
  const value = (item: ProcurementBatchDetail["items"][number]) => {
    const comparison = batch.comparison?.items[item.material_id];
    if (column === "change") return comparison?.change != null && Number.isFinite(comparison.change) ? comparison.change : null;
    if (column === "previous") return toNumber(comparison?.previous_raw ?? comparison?.previous);
    return toNumber(batch.snapshot_sources?.[item.material_id]?.raw_price ?? item.latest_price);
  };
  return [...batch.items].sort((a, b) => {
    const code = a.code.localeCompare(b.code, "zh-CN", { numeric: true });
    if (column === "code") return direction === "ascending" ? code : -code;
    const av = value(a), bv = value(b);
    if (av === null || bv === null) return av === bv ? code : av === null ? 1 : -1;
    return (direction === "ascending" ? av - bv : bv - av) || code;
  });
}

function toNumber(value?: string | null) {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
