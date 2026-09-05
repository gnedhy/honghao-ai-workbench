import assert from "node:assert/strict";
import test from "node:test";
import { defaultProcurementPage, procurementWorkflowStage } from "../src/workbenches/procurementWorkflow.ts";

const update = (status: string, errorCount = 0, riskCount = 0) => ({ status, summary: { error_count: errorCount, risk_count: riskCount } }) as never;

test("procurement workflow routes active work to the correct stage", () => {
  assert.equal(defaultProcurementPage(null), "dashboard");
  assert.equal(defaultProcurementPage(update("draft")), "updates");
  assert.equal(procurementWorkflowStage(update("draft", 1)), 1);
  assert.equal(procurementWorkflowStage(update("draft", 0, 2)), 2);
  assert.equal(procurementWorkflowStage(update("draft")), 3);
  assert.equal(procurementWorkflowStage(update("scheduled")), 3);
});
