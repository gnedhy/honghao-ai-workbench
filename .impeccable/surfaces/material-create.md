# 新增原料与修改人展示

> 文档中的端口、构建号、测试结果与一次性授权为当次历史证据；不作为新任务授权。持续有效的界面约定按后续明确修订更新，现役入口见 [当前交接](../../docs/当前交接.md)。

## 2026-09-09 局部精简修正

- 用户确认继续优化已提议的基础信息分组、完整价格输入区、轻量部门多选及弱化取消按钮；沿用现有极简方向，未改业务字段与保存流程。
- 桌面编号、名称并排，价格单行；部门三列浅灰标签，手机基础字段单列、部门两列。原生复选框保留键盘与选中语义。所有输入焦点统一单层深灰，消除价格内外双蓝框。
- 台账价格变化说明按用户补充要求改为原生 title 悬停说明和完整可访问名称，不再展开额外说明行。
- 类型检查和构建通过；8012 检查桌面、390px 无页面溢出、价格日期/录入说明条件显示、放弃填写保护；仅本地输入后丢弃，未写业务数据。

- Route: evolve / operate / medium. Incumbent monochrome procurement UI; no new dependencies or global design changes.
- Approved: A one-screen modal, then user-added optional price below name; user-specified modifier column after price date and attribution after history source.
- Toolbar order: 编辑价格 / 新增原料 / 导入报表. Admin-only catalog creation; editing mode retains its existing save/cancel controls.
- Fields: unique code, optional name/remark, optional price in yuan/kg, conditional price date and recording reason, multi-select department associations. Blank price stays unpriced; supplied price joins the shared pending round, never immediately changes formal prices.
- Catalog, associations and pending price save atomically. Existing authorization, revision/baseline checks, date rules and actual saved-event attribution remain authoritative. Archived codes and aliases remain reserved.
- Procurement editor filter lists active non-admin procurement editors. Default round remains empty when no participation. All-history also recognizes exact original purchaser names, without turning them into permissions or fabricated save events.
- Ledger modifier column shows latest actual saved actor and round participants; imported source names are explicitly labelled 原表采购员. Single-material history preserves actual saved-name snapshots or source purchaser attribution after price source; missing attribution is 未记录.
- Dialog uses native modal focus containment, dirty-input discard confirmation and focus return. Body scrolls independently while header/footer stay visible. Existing reduced-motion treatment is retained.
- Validation: 54 targeted API tests, 13 frontend tests, typecheck/build and security gate passed. Browser on isolated 8012 checked five-person roster, round-empty vs historical results, source attribution, dirty-input preservation, focus return, 1520x1272 and 390x844 layouts, and reduced-motion setting. No browser form submissions or real business-data changes. Independent code and screenshot review passed.
- Evidence: `.impeccable/review/material-create/20260909-final/manifest.json`. Physical mobile keyboard and touch are not claimed as tested. No production cutover, commit or push.
