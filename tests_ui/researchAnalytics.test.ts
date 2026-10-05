import assert from "node:assert/strict";
import test from "node:test";
import { rankCostGaps, priceCents, priceChange, compareCostPeriods, costComparisonRecord, linePriceMovement } from "../src/workbenches/researchAnalytics.ts";
const row = (name: string, latest_cost: string | null, inventory_cost: string | null, status = "ready") => ({ name, latest_cost, inventory_cost, status });

test("投料单价比较沿对应成本口径追到最后变化基准，不把同价库存更新当新基准", () => {
  const history = [row("now", "12.55", "10.93"), row("same", "12.55", "10.90"), row("before", "12.57", "10.90")];
  assert.equal(costComparisonRecord(history, 0, "latest"), history[2]);
  assert.equal(costComparisonRecord(history, 0, "inventory"), history[1]);
  assert.equal(costComparisonRecord([history[0], row("missing", null, null), history[2]], 0, "latest"), undefined);
  const line = (ref: string, unit_cost: string | null, quantity = "10") => ({ kind: "material", ref, unit_cost, quantity });
  assert.equal(linePriceMovement(line("A", "15.5"), [line("A", "16")])?.direction, "down");
  assert.equal(linePriceMovement(line("A", "16"), [line("A", "15.5")])?.direction, "up");
  for (const [current, previous] of [[line("A", "1.004"), [line("A", "1")]], [line("A", "2"), [line("B", "1")]], [line("A", "2", "0"), [line("A", "1")]], [line("A", "2"), [line("A", "1", "0")]], [line("A", null), [line("A", "1")]]] as const) {
    assert.equal(linePriceMovement(current, [...previous]), null);
  }
  assert.equal(linePriceMovement(line("A", "1"), [line("A", "0")])?.direction, "up");
});

test("历史比较相邻期，同价不延续台账涨跌，正式成本接续独立编号", () => {
  const version = (record_type: string, purchase_version: number | undefined, latest_cost: string) => ({ record_type, purchase_version, products: [{ id:"A", latest_cost, change:{percent:10} }] });
  const source = [version("formal",undefined,"1.101"),version("backfill",21,"1.10"),version("backfill",20,"1.10"),version("backfill",19,"1.00")];
  const result = compareCostPeriods(source);
  assert.deepEqual(result.map(v => v.products[0].period_change.direction), ["stable","stable","up","none"]);
  assert.deepEqual(result.map(v => v.cost_version), [22,21,20,19]);
  assert.equal(result[2].products[0].period_change.percent,10);
  assert.equal(result[0].products[0].change.percent,10);
  assert.equal("period_change" in source[0].products[0],false);
  assert.equal(compareCostPeriods([version("formal",undefined,"1.20"),...source])[0].cost_version,23);
  assert.equal(compareCostPeriods([version("formal",24,"1.20"),...source])[0].cost_version,23, "采购期号不替代独立成本编号");
});

test("历史比较按产品匹配，区分零价同价、零基数涨价、新品和缺价", () => {
  const result = compareCostPeriods([{products:[{id:"B",latest_cost:"1"},{id:"A",latest_cost:"0.004"},{id:"new",latest_cost:"3"},{id:"missing",latest_cost:null}]},{products:[{id:"A",latest_cost:"0"},{id:"B",latest_cost:"0"},{id:"missing",latest_cost:"2"}]}]);
  assert.deepEqual(result[0].products.map(row => [row.period_change.direction,row.period_change.percent]),[["up",null],["stable",0],["none",null],["none",null]]);
});

test("正式记录仅含变化产品时，比较上一期仍有效的成本", () => {
  const result = compareCostPeriods([{products:[{id:"A",latest_cost:"2"}]},{products:[{id:"B",latest_cost:"3"}]},{products:[{id:"A",latest_cost:"1"},{id:"B",latest_cost:"2"}]}]);
  assert.equal(result[0].products[0].period_change.percent,100);
});

test("双成本差异按金额绝对值排列，保留正负方向及稳定内编顺序", () => {
  const rows = [row("P10", "10", "8"), row("P2", "2", "0"), row("P3", "1", "5"), row("same", "1", "1")];
  assert.deepEqual(rankCostGaps(rows, "all").map(r => [r.name, r.gap]), [["P3", -4], ["P2", 2], ["P10", 2]]);
  assert.deepEqual(rankCostGaps(rows, "latest").map(r => r.name), ["P2", "P10"]);
  assert.deepEqual(rankCostGaps(rows, "inventory").map(r => r.name), ["P3"]);
});
test("缺价和未完成的成本不参与，明确零成本有效，先四舍五入两位再比较", () => {
  const rows = [row("missing", null, "1"), row("updating", "20", "1", "updating"), row("failed", "20", "1", "failed"), row("invalid", "NaN", "1"), row("zero", "0", "1"), row("A", "1.001", "1"), row("B", "1.004", "1")];
  assert.deepEqual(rankCostGaps(rows, "all").map(r => r.name), ["zero"]);
  assert.equal(rankCostGaps(rows, "inventory")[0].gap, -1);
});

test("金额按十进制四舍五入到分，区间百分比及差额使用相同金额", () => {
  assert.deepEqual(["1.005","1.004","16.3765","15.88","-1.005","0.004"].map(priceCents), [101,100,1638,1588,-101,0]);
  assert.equal(priceChange("1.014", "1.005"), 0);
  assert.equal(priceChange("1.005", "1.004"), 1);
  assert.equal(priceChange("1", "0.004"), null);
  assert.equal(priceChange(null, "1"), null);
  assert.equal(priceCents("1000000000000000000000000000"), 1e29);
  assert.equal(rankCostGaps([row("P", "16.3765", "15.883")], "all")[0].gap, 0.5);
});
