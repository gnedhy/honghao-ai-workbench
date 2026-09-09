import assert from "node:assert/strict";
import test from "node:test";
import { previewProcurementExcel, previewProcurementImport } from "../src/api.ts";

test("Excel 预览内容可直接用于日常导入预览", async (t) => {
  const content = "编号,名称,单位,最新价\nCF006,CF006,kg,75\n";
  t.mock.method(globalThis, "fetch", async (path, init) => {
    if (String(path).endsWith("excel-preview")) return Response.json({selection: {content, blocked: 0}});
    assert.equal(JSON.parse(init.body).content, content);
    return Response.json({importable_count: 1});
  });
  const result = await previewProcurementExcel(new File(["fixture"], "fixture.xlsx"));
  const preview = await previewProcurementImport("fixture.xlsx", "2026-09-08", result.selection!.content);
  assert.equal(preview.importable_count, 1);
});

test("结构化校验错误显示文字而不是对象", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({detail: [{msg: "价格内容不能为空"}]}, {status: 422}));
  await assert.rejects(previewProcurementImport("fixture", "2026-09-08", ""), /价格内容不能为空/);
});
