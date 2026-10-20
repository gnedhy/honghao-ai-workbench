import assert from "node:assert/strict";
import test from "node:test";
import {compareCodes,preferredTrendId,trendEligibleIds} from "../src/codeOrder.ts";

test("内编候选 A–Z 自然排序，忽略大小写并保留完整内编", () => {
  const codes = ["RH-14C（32%）", "A-10", "CF132", "a-2", "CF14", "P-338-1"];
  assert.deepEqual([...codes].sort(compareCodes), ["a-2", "A-10", "CF14", "CF132", "P-338-1", "RH-14C（32%）"]);
  assert.equal(compareCodes("CF005", "cf005"), 0);
  assert.equal(codes[0], "RH-14C（32%）");
});

test("走势默认按当前范围同一口径两期有效值判断，零价有效且同日重复不凑期数",()=>{
 const range={start:"2026-09-01",end:"2026-10-01"};
 const rows=[
  {id:"zero",date:"2026-09-01",values:[0,null]}, {id:"zero",date:"2026-09-02",values:["0",null]},
  {id:"split",date:"2026-09-01",values:[1,null]}, {id:"split",date:"2026-09-02",values:[null,2]},
  {id:"duplicate",date:"2026-09-01",values:[1]}, {id:"duplicate",date:"2026-09-01",values:[2]},
  {id:"outside",date:"2026-08-31",values:[1]}, {id:"outside",date:"2026-09-01",values:[2]},
  {id:"bad",date:"2026-09-01",values:["",null]}, {id:"bad",date:"2026-09-02",values:["NaN",Infinity]},
 ];
 assert.deepEqual([...trendEligibleIds(rows,range)],["zero"]);
 const items=[{id:"missing",code:"A-1"},{id:"two",code:"A-10"},{id:"zero",code:"A-2"}];
 assert.equal(preferredTrendId(items,new Set(["two","zero","not-authorized"])),"zero");
 assert.equal(preferredTrendId(items,new Set()),"missing");
 assert.equal(preferredTrendId([],new Set(["not-authorized"])),"");
 assert.equal(items[0].id,"missing");
});
