# Procurement dashboard price movers

- Target: `src/workbenches/ProcurementWorkbench.tsx` / PriceMovers and shared ProcurementMetrics; evolve / operate / medium. Existing CSS and user-approved direction remain the visual authority; no Shadcn or new dependencies.
- Approved plan: original `.impeccable/mocks/procurement-movers/20260908-carousel/index.html`; latest user correction on 2026-09-09 requests two-column ranking and airport-board-like flip transitions. Current official version first, each version sorted by absolute nonzero percentage, then earlier versions; ten entries per page and at most three pages. Desktop uses two columns/five rows across the dashboard width; mobile uses one column. Repeated materials in distinct versions remain distinct events.
- Snapshot contract: comparison percentages and prior values use each version's official comparison. Names, codes, prices and dates use that same immutable version detail, never current ledger prices. Only necessary batch details are fetched. No inquiry data, draft, scheduled price or historical operation totals enter the ranking. Adjacent distribution remains current-version-only.
- Controls: eight-second automatic advance; hover, focus and hidden tabs suspend advance. Selecting a page keeps keyboard focus inside the card; automatic advance resumes after both hover and focus leave. Reduced-motion preference disables automatic advance. Keyboard actions have no animation.
- User refinement: no playback text or icon and no selected square background. Only a short active-page line and quiet inactive dots remain; keep 28×32px hit areas and keyboard-only focus outlines.
- Countdown refinement: the active line fills left to right over eight seconds. Its CSS animation completion triggers the next page, so the visible progress and actual switch share one clock; hover/focus/visibility pause the animation itself. Reduced motion renders a static selected line and keeps manual switching.
- Price hierarchy refinement: name and price pair occupy the primary line. Both prices use the same size; new prices differ by darker color and modest weight. Metadata is only version and price date. No repeated material code or redundant current/historical text. At narrow widths the price pair wraps as a unit. Automatic/pointer page switches rotate complete rows around their horizontal center with perspective and opacity: 150ms per row, same-row left/right synchronized, 30ms stagger across five row pairs (270ms total). CSS transitions retarget on interruption; keyboard and reduced-motion switches remain immediate. No fabricated intermediate values or character scrambling.
- Layout: stable shared page height; all pages participate in sizing while hidden pages are invisible and absent from accessibility navigation. Mobile wraps controls and metadata locally with no page-level horizontal overflow.
- Metrics fix: overview and dashboard share one renderer with identical names/order/data: 跟踪原料 / 正式价格变动 / 待处理异常 / 最新价格版本. Procurement-scoped specificity overrides the shared three-column rule regardless of CSS load order; four desktop columns and two mobile columns, with the shared third-item colspan explicitly cleared. Other workbenches are untouched.
- Latest acceptance: independent code and desktop/mobile screenshot review passed; 1440px and 1024px desktop layouts verified; 390px overview/dashboard two-by-two and single-column ranking have no page overflow. All three ranking pages contain ten actual snapshot records. Row-pair transform/opacity/delay sampled mid-transition, card height remains 427.25px on the tested desktop layout, keyboard switches use 0s. 13 frontend tests, typecheck/build and security gate passed. No business data writes during UI checks.
- States: loading, retryable snapshot failure, no comparable nonzero movements, fewer than three pages. No fabricated filler records or reconstructed prices.
- Dashboard scope: user removed 行情资讯 on 2026-09-09. Remove its placeholder card, mock news, unused icon and dedicated styles; no backend or business data changes. Ranking remains the final full-width dashboard panel.
- Boundaries: no data writes, schema or permissions changes, no commits or push. UI workflow retained the incumbent card design and provided scoped visual and interaction checks.

## 2026-09-11 主页复用与紧凑高度

- 用户在主页批注批准：采购入口说明改为符合当前功能的文案；“价格关注”直接复用采购看板排行榜。随后要求控制主页高度。此次为 evolve / operate / small，沿用现有 PriceMovers、日期菜单、涨降幅与分页样式，不启用 Shadcn 或新依赖。
- 入口文案：维护原料采购价格，跟踪价格波动与历史版本。
- 主页与采购看板使用同一个 PriceMovers 及历史缓存。主页 compact 每页6项，桌面两列三行、每行至少60px；窄屏一列六行、每行至少62px。完整采购看板仍为每页10项。现有最多30项的排行范围不变，主页分成5页，完整看板分成3页。
- 首要动作仍为“进入工作台”；原有指标和价格趋势保留。读取中、读取失败可重试、无涨价/降价的状态复用现有组件，主页空态高度一并压缩。没有新的业务字段、写入或权限变化。
- 实际页面验证：1749×1272 下主页排行541px降至321px；390×844 下548px，单列且无横向溢出。两处所有排行记录与顺序一致；主页分页每页6项，完整看板每页10项。日期范围、涨降幅切换和键盘分页通过，控制台无错误；10项价格分析测试和类型检查/构建通过。
- 当前最终证据：`.impeccable/review/procurement-home/current.json`。之前未压缩高度的截图只作本次修订前基线。

### 后续确认：适配主页剩余高度

用户标注排行榜下方的大块留白，要求适配该区域高度。当前以此要求替代固定紧凑高度：主页详情使用纵向 flex，标题、指标和趋势保留内容高度，排行榜及其行网格填充剩余空间，底部保留30px正常内边距。每页6项与完整工作台的既有分页不变；可用高度不足时保留行的最小高度并正常滚动。趋势与指标之间的既有间距保留。

最终实测：1749×1272 下卡片约493px且无内部滚动，底部间距30px；1749×1000 下卡片321px、行高60px，滚动后页脚可见；390×844 下卡片548px、单列六行且无横向溢出。桌面分页、降幅切换、类型检查/构建与样式检测通过，控制台无错误。最终证据更新为 current.json 指向的 20260911-fit 运行。

### 最新确认：主页固定前10项，不翻页

用户明确要求主页直接显示10项、左右各5项、不翻页。此要求替代上文主页每页6项的安排：主页截取当前方向的前10项，移除分页控件与轮播语义，不再自动切页；实际不足10项时按实显示。桌面两列五行沿用剩余高度自适应，窄屏单列展示；日期范围和涨降幅切换保留。结果多于10项时，页脚注明显示前10项。完整采购看板仍沿用最多30项、每页10项及分页轮播。

验证：1749×1272 下左右各5项，底部30px边距，无分页控件与轮播语义，间隔检查内容保持不变；390×844 下10项单列、无横向溢出。降幅当前6项按实展示；完整看板仍有3页、每页10项。类型检查、构建和样式检测通过，控制台无错误。当前证据指向 20260911-static10。
