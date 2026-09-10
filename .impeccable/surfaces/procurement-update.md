# 采购看板价格更新概况

- Target: `src/workbenches/ProcurementWorkbench.tsx`, `ProcurementWorkbench.module.css`, `procurementAnalytics.ts`; evolve / operate / medium.
- Approved 2026-09-10: mock `.impeccable/mocks/procurement-update/20260910/index.html` A, with explicit correction: preserve left ranking two columns, ten entries, directions, paging and animation; only change its grid span. No new dependency or global visual system.
- Desktop: 2:1 lower cards aligned with upper trend/distribution grid. <=1200px lower cards stack to preserve ranking readability; original mobile ranking rules unchanged. Update list long codes wrap.
- Current-material scope; select last price version on/before selected end date. Count actual snapshot source quotation dates, not publication dates; unchanged new quotations count. No draft/scheduled/cancelled writes. Missing provenance/price is counted separately, no date substitution. Interval source prices count as quotations, not precise prices.
- Presets use existing latest-version date anchor and 14d/1m/3m/custom menu. List only prior-to-range source quotes, oldest first, max five. All reported / unknown / no historical version / loading / retry error states explicit.
- Clicking a list item opens existing material detail readonly; closing restores focus. No price, account, permission or data mutation.
- Validation: 26 frontend tests and production build passed. Live 9/7–9/8 returns 30 reported /108 carried; default 14d returns138/0 (no fabricated rows). Desktop1920, narrow1000 and mobile390 screenshots + horizontal overflow checks; direction/paging10entries/detail readonly verified. Existing carousel logic unchanged.
- Scope: local UI change, no commit or push requested. Frozen recovery bundle remains the previous accepted release, not this new uncommitted UI build.
