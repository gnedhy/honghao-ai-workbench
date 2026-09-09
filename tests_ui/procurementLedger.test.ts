import assert from "node:assert/strict";
import test from "node:test";
import { buildLedgerRows, collectPriceEdits, draftLedgerChange, editedPriceChange, filterLedgerRows, formalLedgerChange, summarizeUpdate } from "../src/workbenches/procurementLedger.ts";
import type { ProcurementMaterial, ProcurementUpdate } from "../src/types.ts";

const material = (id: string, extra: Partial<ProcurementMaterial> = {}): ProcurementMaterial => ({ id, code: id, name: id, unit: "kg", price_date: "2026-09-08", updated_at: "", ...extra });
const defaults: Parameters<typeof filterLedgerRows>[1] = { query: "", movement: "all", scope: "all", editor: "", selectedPerson: "", current: null, sort: "code", sortDirection: "ascending", edit: null, values: {} };
const ids = (materials: ProcurementMaterial[], options: Partial<typeof defaults> = {}) => filterLedgerRows(buildLedgerRows(materials, options.current ?? null), { ...defaults, ...options }).map(row => row.material.id);

test("待发布项优先，保存后的变化按待发布价比较，编辑输入不移动行", () => {
  const list = [material("old", { published_price: "20", previous_published_price: "10" }), material("down", { published_price: "10", previous_published_price: "1" }), material("up", { published_price: "10", previous_published_price: "100" })];
  const current = { input_items: [{ material_id: "down", draft_price: "8" }, { material_id: "up", draft_price: "12" }], issues: [] } as unknown as ProcurementUpdate;
  assert.deepEqual(ids(list, {current, sort: "change", sortDirection: "descending"}), ["up", "down", "old"]);
  assert.deepEqual(ids(list, {current, sort: "change"}), ["down", "up", "old"]);
  const edit = {originals: {up: "12", down: "8"}, order: ["up", "down", "old"], sort: "change", sortDirection: "descending"};
  assert.deepEqual(ids(list, {current, edit, values: {up: "0", down: "100"}, sort: "change", sortDirection: "descending"}), edit.order);
  assert.deepEqual(ids(list, {sort: "change", sortDirection: "descending"}), ["down", "old", "up"]);
});

test("本次变化比较当前正式价，空输入撤回，未知基线不伪造涨跌", () => {
  const item = material("a", { published_price: "10", previous_published_price: "5" });
  assert.equal(draftLedgerChange(item, "12"), 20);
  assert.equal(draftLedgerChange(item, "8"), -20);
  assert.equal(draftLedgerChange(item, "10"), 0);
  assert.equal(draftLedgerChange(item, ""), "—");
  assert.equal(draftLedgerChange(item, "bad"), "不可比较");
  assert.equal(draftLedgerChange(material("b"), "12"), "首次定价");
  assert.equal(draftLedgerChange(material("b"), "12", {items: {b: {kind: "incomparable"}}} as never), "不可比较");
  assert.equal(draftLedgerChange(material("b", {published_price: "0"}), "12"), "不可比较");
  const list = [item, material("b", {published_price: "10", previous_published_price: "5"})];
  assert.deepEqual(ids(list, {movement: "up", sort: "change", sortDirection: "descending", edit: {originals: {}}, values: {a: "8", b: "12"}}), ["b", "a"]);
});

test("启用概况区分涨跌持平、不可比较及缺价", () => {
  const items = [{ draft_price: "12", change: .2 }, { draft_price: "8", change: -.2 }, { draft_price: "10", change: 0 }, { draft_price: "10", change: null }, { draft_price: null, change: null }];
  assert.deepEqual(summarizeUpdate(items as Parameters<typeof summarizeUpdate>[0]), { up: 1, down: 1, flat: 1, incomparable: 1, missing: 1 });
  assert.deepEqual(summarizeUpdate([]), { up: 0, down: 0, flat: 0, incomparable: 0, missing: 0 });
});

test("编辑价格即时比较，保留零价及不可比较口径", () => {
  assert.equal(editedPriceChange("20", "10"), 100);
  assert.equal(editedPriceChange("9", "10"), -10);
  assert.equal(editedPriceChange("0", "10"), -100);
  assert.equal(editedPriceChange("0", "0"), 0);
  assert.equal(editedPriceChange("1", "0"), null);
  assert.equal(editedPriceChange("", "10"), null);
  assert.equal(editedPriceChange("bad", "10"), null);
  assert.equal(editedPriceChange("12", null), null);
});

test("表内修改包含跨页零价，忽略空输入与相同数值", () => {
  assert.deepEqual(collectPriceEdits({ a: "0012.00", b: "", c: "0", d: " 13.50 ", e: "bad" }, { a: "12", b: "10" }), [
    { material_id: "c", price: "0" }, { material_id: "d", price: "13.50" }, { material_id: "e", price: "bad" },
  ]);
});

test("台账按本轮归属区分未参与、未变价、零价、缺价与风险", () => {
  const materials = ["untouched", "same", "zero", "missing", "risk", "reviewed"].map(id => ({id, code:id, name:id, unit:"kg", price_date:"2026-09-08", updated_at:"", draft_status:"draft", draft_price:"10"})) as never;
  const update = {
    input_items: ["same", "zero", "missing", "risk", "reviewed"].map(material_id => ({material_id, draft_price:material_id === "missing" ? null : material_id === "zero" ? "0" : "10"})),
    issues: [
      {material_id:"missing",kind:"missing_price",status:"open"},
      {material_id:"risk",kind:"price_spike",status:"open"},
      {material_id:"reviewed",kind:"price_spike",status:"reviewed"},
    ],
  } as never;
  const rows=buildLedgerRows(materials,update);
  assert.deepEqual(rows.map(row=>row.state),["未录入","待发布","待发布","待补价","待确认","已确认"]);
  assert.equal(rows.filter(row=>row.input).length,5);
  assert.equal(rows.filter(row=>row.pending).length,2);
  assert.equal(rows[0].input,undefined);
  assert.equal(rows[2].input?.draft_price,"0");
  assert(buildLedgerRows(materials,null).every(row=>!row.input && !row.pending));
});

test("人员筛选保留历史参与和原表来源，本轮只匹配实际保存且不改当前署名", () => {
  const buyer = { id: "buyer", name: "采购员" }, other = { id: "other", name: "另一人" };
  const materials = [
    material("history", { participants: [buyer, other], round_participants: [other], price_modifier: { kind: "system", ...other } }),
    material("source", { source_purchasers: [buyer.name] }),
    material("round", { participants: [buyer], round_participants: [buyer] }),
  ];
  const current = { input_items: materials.map(item => ({ material_id: item.id, draft_price: "10" })), issues: [] } as unknown as ProcurementUpdate;
  const options = { editor: buyer.id, selectedPerson: buyer.name, current };
  assert.deepEqual(ids(materials, options), ["history", "round", "source"]);
  assert.deepEqual(ids(materials, { ...options, scope: "involved" }), ["round"]);
  assert.deepEqual(ids(materials, { ...options, scope: "involved", editor: "absent", selectedPerson: "未参与" }), []);
  assert.equal(materials[0].price_modifier?.name, other.name);
  assert.deepEqual(ids(materials, { ...options, current: null, scope: "involved" }), ["history", "round", "source"]);
});

test("正式价格分类使用正式版本比较，草稿反向变化与原文异常不能改变分类", () => {
  const materials = [
    material("up", { published_price: "12", previous_published_price: "10", draft_price: "1" }),
    material("down", { published_price: "8", previous_published_price: "10", draft_price: "100" }),
    material("flat", { published_price: "10", previous_published_price: "10" }),
    material("range"), material("missing"), material("first", { published_price: "10" }),
  ];
  const comparison = { previous_version: 1, up: 1, down: 1, unchanged: 1, first: 1, missing: 1, items: {
    range: { previous: null, change: null, kind: "incomparable" },
    first: { previous: null, change: null, kind: "first" },
  } };
  for (const [movement, expected] of Object.entries({ up: ["up"], down: ["down"], flat: ["flat"], missing: ["missing"], incomparable: ["first", "range"] })) {
    assert.deepEqual(ids(materials, { movement, comparison }), expected);
  }
  assert.equal(formalLedgerChange(materials[0], { ...comparison, items: { up: { previous: "11", change: .1, kind: "up" } } }), 10);
});

test("待发布条件包含未变价的已录入项，区分缺价与待确认并组合正式价格条件", () => {
  const materials = ["same", "missing", "risk", "reviewed", "untouched"].map(id => material(id, { published_price: "10", previous_published_price: "10" }));
  const current = {
    input_items: materials.filter(item => item.id !== "untouched").map(item => ({ material_id: item.id, draft_price: item.id === "missing" ? null : "10" })),
    issues: [{ material_id: "missing", kind: "missing_price", status: "open" }, { material_id: "risk", kind: "price_spike", status: "open" }, { material_id: "reviewed", kind: "price_spike", status: "reviewed" }],
  } as unknown as ProcurementUpdate;
  assert.deepEqual(ids(materials, { current, scope: "involved", movement: "flat" }), ["missing", "reviewed", "risk", "same"]);
  assert.deepEqual(ids(materials, { current, scope: "missing" }), ["missing"]);
  assert.deepEqual(ids(materials, { current, scope: "risk" }), ["risk"]);
  assert.deepEqual(ids(materials, { current, scope: "risk", movement: "up" }), []);
  assert.deepEqual(ids(materials, { current, query: " SaMe " }), ["same"]);
});

test("各数值列和日期双向排序始终空值置后，同值按自然编号稳定排列", () => {
  for (const [sort, field, low, high] of [
    ["latest_price", "published_price", "2", "12"],
    ["previous_latest_price", "previous_published_price", "2", "12"],
    ["price_date", "published_price_date", "2026-08-01", "2026-09-08"],
  ]) {
    const materials = [material("CF10", { [field]: high }), material("CF2", { [field]: high }), material("CF1", { [field]: low }), material("empty")];
    assert.deepEqual(ids(materials, { sort }), ["CF1", "CF2", "CF10", "empty"]);
    assert.deepEqual(ids(materials, { sort, sortDirection: "descending" }), ["CF2", "CF10", "CF1", "empty"]);
  }
  const materials = [material("CF10"), material("CF2"), material("CF1")];
  assert.deepEqual(ids(materials), ["CF1", "CF2", "CF10"]);
  assert.deepEqual(ids(materials, { sortDirection: "descending" }), ["CF10", "CF2", "CF1"]);
});

test("变化排序保留正负号而不是绝对波动，未知比较始终排最后", () => {
  const materials = [material("up", { published_price: "11", previous_published_price: "10" }), material("down", { published_price: "1", previous_published_price: "10" }), material("flat", { published_price: "10", previous_published_price: "10" }), material("unknown")];
  assert.deepEqual(ids(materials, { sort: "change" }), ["down", "flat", "up", "unknown"]);
  assert.deepEqual(ids(materials, { sort: "change", sortDirection: "descending" }), ["up", "flat", "down", "unknown"]);
});

test("待发布价排序使用表内输入，空白与非法数字不当成零，未输入项使用原值", () => {
  const materials = ["zero", "two", "original", "blank", "bad", "scientific"].map(id => material(id, { published_price: "999" }));
  const current = { input_items: materials.map(item => ({ material_id: item.id, draft_price: item.id === "zero" ? "0" : "10" })), issues: [] } as unknown as ProcurementUpdate;
  const options = { sort: "draft_price", current, edit: { originals: { original: "3", blank: "8" } }, values: { zero: "0", two: "2", blank: "", bad: "4..5", scientific: "1e2" } };
  assert.deepEqual(ids(materials, options), ["zero", "two", "original", "bad", "blank", "scientific"]);
  assert.deepEqual(ids(materials, { ...options, sortDirection: "descending" }), ["original", "two", "zero", "bad", "blank", "scientific"]);
  assert.equal(options.values.blank, "");
  assert.deepEqual(ids(materials, { sort: "draft_price", current }).slice(0, 2), ["zero", "bad"]);
});
