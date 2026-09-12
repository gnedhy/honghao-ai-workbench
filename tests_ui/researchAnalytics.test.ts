import assert from "node:assert/strict";
import test from "node:test";
import { rankCostGaps, priceCents, priceChange } from "../src/workbenches/researchAnalytics.ts";
const row = (name: string, latest_cost: string | null, inventory_cost: string | null, status = "ready") => ({ name, latest_cost, inventory_cost, status });

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
