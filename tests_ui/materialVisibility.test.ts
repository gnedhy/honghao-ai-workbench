import assert from "node:assert/strict";
import test from "node:test";
import {dailyProcurementOverview, isDailyMaterial} from "../src/materialVisibility.ts";
import type {ProcurementOverview} from "../src/types.ts";

test("明确不用标注隐藏，正常编号、缺价及回收原料仍可查看", () => {
  for (const code of ["(此品号不用）二次氨水", "CF032(已停）", "CF290D（已停）", "CF001【停用】", "不用"]) {
    assert.equal(isDailyMaterial({code}), false, code);
  }
  assert.equal(isDailyMaterial({code:"CF001", name:"（此品号不用）原料"}), false);
  for (const code of ["CF001", "回收CF232", "不饱和聚酯", "不用水清洗剂", "CF032", "CF290D"]) {
    assert.equal(isDailyMaterial({code}), true, code);
  }
});

test("日常台账过滤不修改原始原料、历史、草稿及部门关联", () => {
  const data = {
    materials:[{id:"old",code:"(此品号不用）二次氨水"},{id:"normal",code:"CF001",published_price:null}],
    metrics:{material_count:2,open_issue_count:1},
    batches:[{id:"v1",items:[{material_id:"old",latest_price:"9"}]}],
    departments:[{material_ids:["old","normal"]}],
    current_update:{items:[{material_id:"old",price:"10"}]},
    capabilities:{can_edit:false,can_manage_catalog:false},
  } as unknown as ProcurementOverview;
  const before = structuredClone(data);
  const view = dailyProcurementOverview(data);
  assert.deepEqual(view.materials.map(item=>item.id),["normal"]);
  assert.equal(view.metrics.material_count,1);
  for (const key of ["batches","departments","current_update","capabilities"] as const) assert.equal(view[key],data[key]);
  assert.deepEqual(data,before);
});
