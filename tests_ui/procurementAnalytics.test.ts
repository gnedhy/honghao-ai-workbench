import assert from "node:assert/strict";
import test from "node:test";
import { buildPriceMovement, buildPriceTrend, countValidPrices } from "../src/workbenches/procurementAnalytics.ts";

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
