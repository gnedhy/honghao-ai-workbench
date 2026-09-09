import assert from "node:assert/strict";
import test from "node:test";
import { PRICE_REASONS, REVIEW_REASONS, resolveReason } from "../src/workbenches/procurementReasons.ts";

test("原因选择只提交所选预设或合格的自定义原因", () => {
  assert.equal(resolveReason(undefined), "");
  assert.equal(resolveReason({ selected: "", custom: "尚未选择原因" }), "");
  for (const selected of [...PRICE_REASONS, ...REVIEW_REASONS]) {
    assert.equal(resolveReason({ selected, custom: "不会提交此文本" }), selected);
  }
  for (const custom of ["", "   ", "三个字", "字".repeat(201)]) {
    assert.equal(resolveReason({ selected: "other", custom }), "");
  }
  assert.equal(resolveReason({ selected: "other", custom: "  已核对报价  " }), "已核对报价");
  assert.equal(resolveReason({ selected: "other", custom: "字".repeat(200) }), "字".repeat(200));
});
