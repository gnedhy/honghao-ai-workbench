import assert from "node:assert/strict";
import test from "node:test";
import {compareCostRecords,dailyCostRecords} from "../src/workbenches/researchAnalytics.ts";

test("成本详情按所属日期倒序，同日正式优先且不改冻结记录及涨跌",()=>{
  const rows=[
    {id:"current",effective_date:"2026-10-13",recorded_at:"2026-10-16T03:00:00Z",record_type:"formal",latest_cost:"5.93",change:{percent:6.08}},
    {id:"previous",effective_date:"2026-10-08",recorded_at:"2026-10-16T02:00:00Z",record_type:"formal",latest_cost:"5.59",change:{percent:-5.57}},
    {id:"erp",recorded_at:"2026-10-15T01:00:00Z",record_type:"formal",latest_cost:"5.92",change:{percent:-0.17}},
    {id:"replay",effective_date:"2026-10-13",recorded_at:"2026-10-19T01:00:00Z",record_type:"backfill",latest_cost:"5.93",change:{percent:6.08}},
  ];
  const before=structuredClone(rows);
  const sorted=[...rows].sort((a,b)=>compareCostRecords(b,a));
  assert.deepEqual(sorted.map(row=>row.id),["erp","current","replay","previous"]);
  assert.deepEqual(rows,before);
  assert.equal(rows[0].latest_cost,"5.93");
});

test("同日走势优先正式记录且保留缺价，不以回算或零价补位",()=>{
  const rows=[
    {id:"old-formal",effective_date:"2026-10-13",recorded_at:"2026-10-15",record_type:"formal",latest_cost:"1"},
    {id:"replay",effective_date:"2026-10-13",recorded_at:"2026-10-19",record_type:"backfill",latest_cost:"9"},
    {id:"formal",effective_date:"2026-10-13",recorded_at:"2026-10-16",record_type:"formal",latest_cost:null},
    {id:"zero",effective_date:"2026-10-08",recorded_at:"2026-10-19",record_type:"backfill",latest_cost:"0"},
  ];
  const before=structuredClone(rows);
  assert.deepEqual(dailyCostRecords(rows).map(row=>[row.id,row.latest_cost]),[["zero","0"],["formal",null]]);
  assert.deepEqual(rows,before);
  assert.deepEqual(dailyCostRecords([]),[]);
});
