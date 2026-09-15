# Procurement ledger surface brief

> 文档中的端口、构建号、测试结果与一次性授权为当次历史证据；不作为新任务授权。持续有效的界面约定按后续明确修订更新，现役入口见 [当前交接](../../docs/当前交接.md)。

## Draft price alignment fix — 2026-09-11

- User reported the 待发布价 header no longer centered above its input. Route: evolve / operate / small, restoration of the existing approved column alignment.
- Root cause: the high-specificity ledger-wide left-alignment selector overrode the draft column's existing centered rule. Exclude only draft_price from this generic selector; retain the existing centered rule for both header and cells.
- One CSS selector changed; no component, column order, prices, workflow or business data changes. Before correction the header/input center offset was 20.78125 px; after correction all 50 visible inputs match the header center exactly (0 px) on desktop and mobile. Saved draft price text also matches (simulated overview on the isolated instance).
- Isolated Vite build, actual computed alignment, unchanged column/value checks, desktop 1749×1272 and mobile 390×844 screenshots, console and detector checks pass. Small scoped self-review; no extra automated unit tests for the CSS-only change.
- Current evidence: `.impeccable/review/procurement-ledger/20260911-draft-alignment/manifest.json`. Local frontend updated after dist backup; API unchanged.

## Shared department ledger — 2026-09-11

- The Materials component also renders distribution details. Department mode filters the formal catalog by department IDs and provides range-selection controls; the original ledger pricing workflow, column order, comparison policy and personal preferences remain shared.
- See [distribution surface brief](./procurement-distribution.md) and its current evidence for the final desktop/mobile and cross-page write verification. All 107 RD5 material cells match their main-ledger equivalents. The earlier final comparison/history definitions below remain effective.

## Final catalog supplementation and history — 2026-09-11 19:46

- Ordinary updates compare the prior formal price. Additions-only batches retain existing materials' price comparisons; never search for the last nonzero movement. CF298 remains +20.7%, CF040 is 0.0%; existing 138 material comparisons exactly match v20.
- Reuse Movement for 暂无对比 with the gray centered 64px badge. Keep inventory quantity as the second column when entering edit; insert the draft price after current price without moving existing columns.
- Mark v21 as 28 added prices and 138 inherited comparisons. Its history panel shows only the 28 new prices and their gray no-comparison badges. Hide additions-only carry-forward rows in the existing material history; 138 existing materials retain 20 displayed periods. Underlying snapshots remain complete and immutable.
- 55 relevant backend tests, 28 frontend tests, typecheck, candidate build, security gate and desktop browser checks pass. No new full mobile acceptance claimed. Evidence and backups: `.scratch/ledger-supplement-fix-20260911-192905/`.
- Final runtime assets: index-MWrzSFkj.js / ProcurementWorkbench-DEzaTwpJ.js / index-nFsM9uwV.css. Older 19:04 and 19:25 comparison definitions are superseded.

## Approved inventory display refinement — 2026-09-11

- User screenshot approves a small evolve / operate increment. The subsequent user correction requires truncating the decimal portion without rounding: 21016.687 displays 21016. The original full quantity and unit remain in a native hover title; stored values and numeric sorting retain original precision.
- The user then requested zero stock to display — like inventory price. Actual zero and missing quantity display —; positive fractional stock still displays its integer portion (0.292 displays 0), with the full value on hover. Sorting continues to treat zero as numeric zero and missing as missing.
- 库存量 supports the existing ascending/descending header interaction, arrow indicator and aria-sort. Missing values remain last and zero is numeric; quantities displaying the same integer still sort by their original decimal values.
- Reuse the existing comparisonInfo button and Info icon beside 库存量. Its native title explains whole-number display, hovering for full values and sorting by original values. Rename the inventory price column and its display checkbox to 库存价格.
- No CSS, API, login, storage or formal price calculation changes. Verify the existing authenticated Chrome session with read-only page checks; do not sign into a test account on the production host name.
- 27 frontend tests, typecheck/build, actual ascending/descending interaction, full-value title attributes, shared info styles, desktop 1749×1272 and mobile 390×844 screenshots pass. No page overflow or console warnings/errors. Native operating-system tooltip pixels are not captured by page screenshots.
- Current evidence: `.impeccable/review/procurement-ledger/20260911-inventory-truncate/manifest.json`; this display refinement supersedes rounding in the earlier display evidence and full-decimal table rendering in the initial inventory section below.

## Approved inventory columns — 2026-09-11

- Latest approved increment: evolve / operate / small, Impeccable adapt under orchestrate-ui-craft. Reuse the current table, typography, row height, filters, paging and local horizontal scrolling; no global design or component-library change.
- User explicitly approved implementation and updating the current service after isolated verification and backup. Only the existing 138 active materials are updated from 原料行情总表, matching codes exactly.
- Daily column order: 原料编号 / 库存量 / 单位 / 最新价格 / 库存价 / 价格变化 / 价格日期 / 修改人 / 状态. The quantity preserves source precision and zero; blank or zero inventory prices display —. 上版价格 remains an optional display column and the formal comparison baseline.
- Existing saved preferences add inventory quantity and replace previous price with inventory price once, preserving other selections, browsing mode and page size. Subsequent custom preferences remain user controlled.
- Inventory has its own source-attributed storage, separate from formal price history and shared price updates. Original zero prices remain in source evidence. Permission filtering follows procurement price fields. No new public import API or modal is introduced.
- Verify actual 138-row data on an isolated copy, all 20 existing procurement business-table fingerprints unchanged, repeat import idempotence, invalid input rollback, source/catalog change rejection, later price activation, permissions, migration and saved settings. Browser coverage: desktop 1749×1272 and mobile 390×844, pagination, search, missing price, zero quantity and table-local horizontal scrolling.
- Current inventory evidence: `.impeccable/review/procurement-ledger/20260911-inventory/manifest.json`. Historical scope limits below remain historical; the current explicit implementation request authorizes this inventory update and local service refresh, without commit or push.

## Current approved collaboration scope — 2026-09-09

- This section supersedes the older 137-material, single-buyer, automatic risk-confirmation and hidden-import decisions below. Approved route: evolve / operate / large; retain existing typography, monochrome actions, status colors, tables and drawers. No global design-token changes.
- Four flat pages: 采购看板 / 原料价格 / 数据分流 / 价格历史. The ledger section is named 价格台账; the workbench is 原料价格管理 (user-approved rename, 2026-09-11). Ledger opens the shared catalog, no department navigation children or personal ownership. Round/history participant filters retain edits and show latest saved values. Unpriced cells show —, status 未定价.
- Daily edit/import saves do not change formal prices. Authorized users separately confirm risks and activate; managers administer delegation. Department membership is admin-only and references one current formal snapshot, never copies prices.
- Imported v1–v20 retain source sheet/cell/date and non-single raw values. Formal comparisons use the preceding formal version. Original buyers are source attribution, not fabricated system actors. Saved changes show actual actor/name/time/reason/before/after, including traceable cancelled actions.
- Approved environment boundary: isolated acceptance on 8012 only. Existing 8000 database/service and GitHub Issue/PR production activation gates remain unchanged. No formal migration/cutover, commit or push.
- Desktop 1440, 1024 maximum font, 390 and 110%-equivalent viewport are checked. Tables may scroll internally; page itself must not overflow. Native browser zoom and physical touch are not claimed as tested.
- Current acceptance evidence: `.impeccable/review/procurement-collaboration/20260909-isolated/manifest.json`; detailed scope and limits in the adjacent acceptance note. Old dated sections below remain historical, not current requirements.

- Surface: procurement workbench / material ledger and material detail drawer.
- Change type: evolve; medium impact; existing Honghao workbench design remains authoritative.
- Goal: keep 137+ materials usable through an internally scrolling ledger, an optional saved pagination mode, and safer identity/price editing.
- Interaction: ledger toolbar and header remain visible; pagination supports 25/50/100 and 10–200 custom sizes; identity edits require a before/after confirmation; forms use a drawer-bottom panel.
- Responsive: validate at 1440px, 1024px, 390px, and a 110% zoom-equivalent viewport; tables scroll locally and mobile detail uses the full viewport.
- Constraints: no global-shell changes, no new UI library or date picker, no production data mutation during visual review, and no commit before user confirmation.
- Verification: backend tests, frontend tests, typecheck, production build, security gate, browser console, internal scrolling, pagination, mobile overflow, and drawer form spacing.

## Approved ledger layout — 2026-09-08

- Mode: calibrate / operate / medium; approved B preview at `.impeccable/mocks/procurement-ledger/20260908-table-toolbar/index.html` (user: 可以，修改一下).
- Heading groups edit/import and saved-round enable/ellipsis actions; count stays with the title. Editing shows only save/cancel and its shared date/reason band. Daily view has no enable action.
- Saved-round summary is a compact band; nonzero pending counts remain actionable. Enable retains all existing permissions and blocking conditions. More keeps records/cancel without adding a workflow stage.
- One table frame contains a wrapping toolbar, independent row scroll area and pagination; menus are not clipped by row scrolling. Narrow layouts wrap heading/actions and fields; only table rows scroll horizontally.
- Preserve source data, business rules, saved preferences, existing global typography and app shell. No global design changes. Visual verification uses the independent test instance, not demo writes.
- Current evidence: `.impeccable/review/procurement-ledger/20260908-enable-overview/manifest.json`. Browser plugin absent; cached Playwright/Edge used. Physical touch and native browser zoom are untested in this increment.

## Approved enable overview

- Enable confirmation leads with input-item count and up/down/flat counts, keeping incomparable and missing separate. High-risk counts derive from current unresolved/reviewed issues. Complete baseline coverage is described separately.
- Details collapsed by default, scroll internally when expanded. Immediate/scheduled buttons select timing, final labels are 确认启用/确认排期; no repeated risk confirmation.
- Verification:9 frontend tests including count partition, typecheck/build, security,1440 and390 max-font browser checks; no enable mutations. Incumbent UI authority and business APIs unchanged.

## Approved confirmation visual cleanup

- Save dialog: compact locked date, price review before reason, consistent-reference label in header only, separate risk hint column, desktop width620px and local table scrolling on narrow screens.
- Current-round states use plain aligned text; completed state and evidence link are distinct. Evidence expands into title/reason with a lightweight right-side collapse action; no repeated material identifier.
- Changes scoped to existing TSX/CSS; business logic untouched. Browser checks cover state expansion, modal order, locked date text, focus restore,390px maximum font and console;8frontend tests, typecheck/build and security pass.

## Approved single price confirmation — 2026-09-08

- User approved one price/risk confirmation at save across bulk, detail and import. Save previews show reference/new prices, direction and high-risk flags; one reason is used for writing and risk audit in one transaction. Enable remains a separate timing decision, not repeated risk review.
- Preview uses server date-specific references. Submission checks baseline identity and each reference under the write transaction, rejecting stale confirmations without partial writes. Legacy callers do not auto-confirm; inherited or revalidation issues retain the explicit review path. Missing price still blocks enable.
- Editing recalculates visible percentage immediately; authoritative save preview identifies each row's formal or prior-inquiry reference. No database migration, demo writes or dependency changes.
- Verification: 178 API and 8 frontend tests, build/security gate; isolated browser verifies all three high-risk write entrances become enable-ready, modal cancel/failure retains inputs, and 1440/1024/390 max-font layout. Independent scoped review passed; final screenshots include deliberate simulated failure/retry state.

## Approved compact toolbar A — 2026-09-09

- User selected A including the table: 36px controls, light removable text conditions, compact left-aligned table, header sorting and one comparison explanation. Existing display controls remain unchanged.
- Personnel includes source and historical participation; pending conditions use actual round participation. Formal comparison never switches to draft values; nulls sort last, signed changes retained, hidden sorting columns reset to code.
- New-material modal polish removes repeated prose, places units inside price input and aligns department choices; validation and submission unchanged.
- 19 frontend tests, typecheck/build and security gate passed. Independent code and desktop/mobile screenshot review passed. Browser verified 19 rising items, person participation, sorting, input retention, clear-search preservation, hidden-column fallback, page reset and 390px no page overflow. No business writes; display preferences restored.
- A temporary browser tab stopped responding during cancel-edit; a fresh tab was used for remaining read-only checks. Native cancel completion in that tab was not verified.

## Approved save interaction refinement — 2026-09-08

- User approved moving date/reason to the save confirmation window, renaming the action to 启用价格, equal action button sizing and hiding import while a current round exists.
- Editing keeps only modified count in the band. Save opens a native modal dialog using the existing enable-confirmation visual style. Confirm performs the existing atomic bulk write; closing/retry preserves inputs, existing round date stays locked, and keyboard focus returns to Save on cancel.
- No-draft daily actions: edit/import. Saved-round actions: edit/enable/ellipsis. Editing actions: save/cancel. Permission and unfinished-issue checks remain unchanged.
- Checked 1440/1024/390, maximum font, validation, failed save/retry, actual isolated save, date locking and equal button heights. No production demo mutations or new dependencies.
