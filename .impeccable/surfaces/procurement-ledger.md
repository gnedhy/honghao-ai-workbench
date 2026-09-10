# Procurement ledger surface brief

## Current approved collaboration scope — 2026-09-09

- This section supersedes the older 137-material, single-buyer, automatic risk-confirmation and hidden-import decisions below. Approved route: evolve / operate / large; retain existing typography, monochrome actions, status colors, tables and drawers. No global design-token changes.
- Four flat pages: 采购看板 / 原料台账 / 数据分流 / 价格历史. Ledger opens the 460-item shared catalog, no department navigation children or personal ownership. Round/history participant filters retain edits and show latest saved values. Unpriced cells show —, status 未定价.
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
