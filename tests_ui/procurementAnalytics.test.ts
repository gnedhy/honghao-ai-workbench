import assert from "node:assert/strict";
import test from "node:test";
import { buildPriceMovement, buildRangeDistribution, buildPublishedPriceMovement, buildPriceTrend, buildVersionMovers, moverDateRange, sortBatchPrices, countValidPrices } from "../src/workbenches/procurementAnalytics.ts";
import type { ProcurementBatchDetail } from "../src/types.ts";

const batch = (version: number, prices: Record<string, string | null>, dates: Record<string, string> = {}): ProcurementBatchDetail => ({
  id: `b${version}`, version, published_at: `2026-09-0${version}`, price_date: `2026-09-0${version}`, item_count: Object.keys(prices).length,
  items: Object.entries(prices).map(([code, latest_price]) => ({ material_id: code, code, name: code, unit: "kg", latest_price })),
  snapshot_sources: Object.fromEntries(Object.entries(prices).map(([code, raw_price]) => [code, { price_date: dates[code] ?? `2026-09-0${version}`, raw_price, price_kind: raw_price?.includes("-") ? "range" : "number", sheet: null, cell: null }])),
});

test("排行按原料最近两次有效价格，跳过沿用快照，跨版本去重并按绝对幅度排序", () => {
  const result = buildVersionMovers([
    batch(3, { A: "12", B: "5", C: "20", D: "8", E: null, F: "2-3" }, { B: "2026-09-02" }),
    batch(1, { A: "5", B: "10", C: "10", D: null, E: "0", F: "2" }),
    batch(2, { A: "10", B: "5", C: "20", D: null, E: "3", F: "3" }),
  ]);
  assert.deepEqual(result.map(row => [row.materialId, row.changePercent]), [["B", -50], ["F", 50], ["A", 20]]);
  assert.equal(result[0].date, "2026-09-02");
  assert.equal(result[0].version, 2);
  assert.equal(new Set(result.map(row => row.materialId)).size, result.length);
  assert.equal(buildVersionMovers([batch(1, { A: "1" })]).length, 0);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`M${i}`, "1"]));
  // Keep all candidates so each direction can select its own top thirty.
  assert.equal(buildVersionMovers([batch(1, many), batch(2, Object.fromEntries(Object.keys(many).map(key => [key, "2"]))) ]).length, 40);
});

test("时间范围使用最新正式日期向前推月，取期初之前最近价格，不拿缺失基线凑数", () => {
  const dated = (version: number, date: string, prices: Record<string, string | null>) => ({ ...batch(version, prices, Object.fromEntries(Object.keys(prices).map(code => [code, date]))), price_date: date });
  const history = [dated(4, "2026-09-08", { A: "8", B: "5" }), dated(3, "2026-09-01", { A: "8", B: "6" }), dated(2, "2026-08-04", { A: "10" }), dated(1, "2026-06-01", { A: "16" })];
  assert.deepEqual(buildVersionMovers(history).map(row => row.materialId), ["B"]);
  assert.deepEqual(buildVersionMovers(history, 1).map(row => [row.materialId, row.changePercent, row.previousDate]), [["A", -20, "2026-08-04"]]);
  assert.equal(buildVersionMovers(history, 3)[0].changePercent, -50);
  const monthEnd = [dated(3, "2026-03-31", { A: "8" }), dated(2, "2026-03-01", { A: "9" }), dated(1, "2026-02-28", { A: "10" })];
  assert.equal(buildVersionMovers(monthEnd, 1)[0].changePercent, -20);
});

test("日期范围覆盖十四天、跨月与闰年，自定义截止日不使用未来快照", () => {
  assert.deepEqual(moverDateRange("2026-09-08", "14d"), { start: "2026-08-25", end: "2026-09-08" });
  assert.equal(moverDateRange("2024-03-31", "1m").start, "2024-02-29");
  assert.equal(moverDateRange("2026-01-31", "3m").start, "2025-10-31");
  const history = [batch(1, { A: "10" }), batch(2, { A: "8" }), batch(3, { A: "20" })];
  const result = buildVersionMovers(history, { start: "2026-09-01", end: "2026-09-02" });
  assert.equal(result[0].changePercent, -20);
  assert.equal(result[0].version, 2);
  assert.equal(buildVersionMovers(history, { start: "2026-08-01", end: "2026-09-02" }).length, 0);
  assert.equal(buildVersionMovers(history, { start: "2026-09-02", end: "2026-09-01" }).length, 0);
});

test("范围分布保留持平和无期初价，区间及零基准不可比较，不读取截止日后版本", () => {
  const history = [batch(1, { A: "10", B: "10", C: "5", D: null, E: "2", F: "0", G: "3" }), batch(2, { A: "12", B: "8", C: "5", D: "4", E: "2-3", F: "1", G: null }), batch(3, { A: "1" })];
  const result = buildRangeDistribution(history, { start: "2026-09-01", end: "2026-09-02" });
  assert.deepEqual(result?.counts, { rising: 1, falling: 1, stable: 1, first: 1, unavailable: 1, incomparable: 2 });
  assert.equal(result?.comparable, 3);
  assert.equal(buildRangeDistribution(history, { start: "2026-08-01", end: "2026-08-20" }), null);
});

test("版本明细按列双向排序，涨跌带符号，空值和区间始终最后，同值按编号", () => {
  const data = batch(2, { A: "12", B: "5", C: "2-3", D: "12" });
  data.comparison = { previous_version: 1, up: 2, down: 1, unchanged: 0, first: 0, missing: 1, items: {
    A: { previous: "10", change: 0.2, kind: "up" }, B: { previous: "10", change: -0.5, kind: "down" },
    C: { previous: null, change: null, kind: "incomparable" }, D: { previous: "10", change: 0.2, kind: "up" },
  }};
  const codes = (column: string, direction: "ascending" | "descending") => sortBatchPrices(data, column, direction).map(item => item.code);
  assert.deepEqual(codes("change", "descending"), ["A", "D", "B", "C"]);
  assert.deepEqual(codes("change", "ascending"), ["B", "A", "D", "C"]);
  assert.deepEqual(codes("current", "descending"), ["A", "D", "B", "C"]);
  assert.deepEqual(codes("current", "ascending"), ["B", "A", "D", "C"]);
  assert.deepEqual(codes("previous", "descending"), ["A", "B", "D", "C"]);
  assert.deepEqual(codes("previous", "ascending"), ["A", "B", "D", "C"]);
  assert.deepEqual(codes("code", "descending"), ["D", "C", "B", "A"]);
  assert.deepEqual(data.items.map(item => item.code), ["A", "B", "C", "D"]);
});

test("看板使用正式版本统计，保留未变原料且不混入草稿", () => {
  const result = buildPublishedPriceMovement([
    { id: "a", code: "A" },
    { id: "b", code: "B" },
    { id: "c", code: "C" },
    { id: "d", code: "D" },
  ], { up: 1, down: 2, unchanged: 1, first: 0, missing: 0, items: { a: { change: 0.945525 }, b: { change: -0.1 }, c: { change: -1 }, d: { change: 0 } } });
  assert.deepEqual(result.counts, { rising: 1, falling: 2, stable: 1, first: 0, unavailable: 0 });
  assert.equal(result.comparable, 4);
  assert.equal(result.ranked.find(item => item.code === "A")?.changePercent.toFixed(1), "94.6");
  assert.equal(buildPublishedPriceMovement([{ id: "d", code: "D" }], { up: 0, down: 0, unchanged: 1, first: 0, missing: 0 }).comparable, 1);
});

test("采购价格分析区分涨跌、持平和不可比较数据", () => {
  const result = buildPriceMovement([
    { code: "UP", latest_price: "12", previous_latest_price: "10" },
    { code: "DOWN", latest_price: "9", previous_latest_price: "10" },
    { code: "SAME", latest_price: "8", previous_latest_price: "8" },
    { code: "NEW", latest_price: "5", previous_latest_price: null },
    { code: "ZERO", latest_price: "0", previous_latest_price: "0" },
  ]);

  assert.deepEqual(result.counts, { rising: 1, falling: 1, stable: 2, unavailable: 1 });
  assert.equal(result.ranked[0]?.code, "UP");
  assert.equal(result.ranked[0]?.changePercent, 20);
  assert.equal(result.ranked[1]?.code, "DOWN");
  assert.equal(result.ranked[1]?.changePercent, -10);
});

test("采购价格趋势按时间顺序保留有效询价点", () => {
  const result = buildPriceTrend([
    { material_code: "RM-01", latest_price: "12.5", recorded_at: "2026-08-31T08:00:00Z" },
    { material_code: "OTHER", latest_price: "99", recorded_at: "2026-08-30T08:00:00Z" },
    { material_code: "RM-01", latest_price: null, recorded_at: "2026-08-29T08:00:00Z" },
    { material_code: "RM-01", latest_price: "10", recorded_at: "2026-08-30T08:00:00Z" },
  ], "RM-01");

  assert.deepEqual(result.map((point) => point.value), [10, 12.5]);
});

test("有效价格期数不包含缺价记录", () => {
  assert.equal(countValidPrices([
    { latest_price: "10" },
    { latest_price: null },
    { latest_price: "" },
    { latest_price: "12.5" },
  ]), 2);
});
