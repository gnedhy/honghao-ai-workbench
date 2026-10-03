import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "../clientId" || specifier === "./salesModel" ? specifier + ".ts" : specifier, context);
} });
const { defaults, initialPanels, initialSource, incompleteStep, tierError, tierRows } = await import("../src/workbenches/salesCalculatorModel.ts");

test("测算模板、初始来源和分档保留精度、缺失及特殊公摊语义", () => {
  const panels = initialPanels();
  assert.equal(new Set(panels.flatMap(panel => [panel.id, ...panel.steps.map(step => step.id)])).size, 14);
  assert.equal(incompleteStep(panels[0]), -1);
  assert.equal(incompleteStep({ ...panels[0], steps: defaults("domestic_direct", true) }), 0);
  assert.deepEqual(defaults("export_intermediary").map(step => [step.operation, step.value]), [["+", "0.75"], ["+", "1.65"], ["*", "1.15"]]);
  assert.deepEqual(initialSource([]), { kind: "manual", cost: "" });
  const ordinary = { id: "Q", code: "Q", name: "Q", source: "research", department: "研发五部", status: "ready", latest_cost: null, inventory_cost: "0", special_allocation: false };
  assert.deepEqual(initialSource([ordinary]), { kind: "product", product_id: "Q", basis: "inventory" });
  const tiers = [{ upper: "4.999999999999999999", amount: "0.5" }, { upper: null, amount: "0.8" }];
  assert.equal(tierError(tiers), "");
  assert.deepEqual(tierRows(tiers, "4.999999999999999998").map(row => row.active), [true, false]);
  assert.deepEqual(tierRows(tiers, "4.999999999999999999").map(row => row.active), [false, true]);
  assert.match(tierError([{ upper: "5", amount: "0.5" }, { upper: "5", amount: "0.8" }, { upper: null, amount: "1" }]), /高于/);
  assert.match(tierError([{ upper: null, amount: "1e2" }]), /无效/);
  assert.match(tierError([{ upper: "5", amount: "0" }]), /无上限/);
  assert.match(tierError([{ upper: null, amount: "1000000000.000000000000000001" }]), /无效/);
});
