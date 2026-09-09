import assert from "node:assert/strict";
import test from "node:test";
import { defaultProcurementPage } from "../src/workbenches/procurementWorkflow.ts";

const update = (status: string, errorCount = 0, riskCount = 0) => ({ status, summary: { error_count: errorCount, risk_count: riskCount } }) as never;

test("采购入口将活动更新定位到统一台账", () => {
  assert.equal(defaultProcurementPage(null), "dashboard");
  assert.equal(defaultProcurementPage(update("draft")), "materials");
  assert.equal(defaultProcurementPage(update("revalidation_required")), "materials");
});
