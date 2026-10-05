# 公共组件与交互约定

新增或调整界面前，先查下表，复用现有入口并在隔离示例验证。已有设计与行为直接适配；只有确实无法覆盖的新业务行为或可见效果才需要重新确认。

## 组件入口

| 用途 | 实现入口 | 可适配内容／实际消费者 |
| --- | --- | --- |
| 确认与放弃修改 | `src/components/Interaction.tsx` → `DiscardChangesDialog` | 标题、说明、按钮、危险／普通确认；设置、资料、反馈、采购、研发、销售 |
| 未保存保护 | 同文件 → `useUnsavedChanges`；`interactionNavigation.ts` | 业务提供 dirty、busy；取消保留输入，确认后继续原导航 |
| 抽屉 | `src/components/Drawer.tsx` | 标题、宽度、正文、关闭前检查；`backLabel` 显示标题左侧返回箭头，可用 `onBack` 注入上层配方导航，未提供时关闭子层。返回与关闭共用 busy／关闭前检查和完整退出动效；下层原生抽屉打开时隐藏上层抽屉及遮罩，退出后恢复，上层保持挂载以保留状态，退出下层后按现有抽屉节奏滑入；研发详情／编辑、采购版本／本轮记录、销售参数／历史 |
| 折叠与滚动 | `Interaction.tsx` → `SettingsGroup`、`useMeasuredContent`、`useFadingScrollbars` | 异步高度、默认展开、收起 inert；设置、资料、帮助、授权记录 |
| 单选菜单、搜索单选与日期 | `src/components/WorkbenchMenus.tsx` | 普通单选、可选删除、搜索候选、日期区间；采购／研发看板、销售测算。部门树与多选继续使用 `OrganizationControls.tsx` |
| 开关 | `src/components/Switch.tsx` | 受控选中、禁用、忙碌；设置、授权、配方自动换算。确认及提交由业务提供 |
| 数字输入 | `src/components/DecimalInput.tsx` | 保留输入字符串、单位由外层展示；采购编辑、研发比例／投料、销售费用／系数。精度与校验不在组件内处理 |
| 台账与工具栏 | `src/components/WorkbenchLayout.tsx`；`WorkbenchSurface.module.css` | 结构与样式复用，列、宽度、筛选及权限由业务提供；采购／研发／销售 |
| 分页、记录筛选 | `LedgerPagination.tsx`、`RecordFilters.tsx` | 总数、页数、筛选状态；采购／研发／销售／反馈 |
| 原料只读详情与价格单元格 | `src/workbenches/ProcurementMaterialView.tsx` → `ReadOnlyMaterialDrawer`、`ledgerCell` | 采购排行、研发 `ResearchMaterialPrices` 及 `ResearchProductView` 投料穿透；调用方注入各自只读 GET。提供 `backLabel` 时复用原生下层抽屉，只显示当前层，保留父层状态及焦点，`notice` 说明当前价格与冻结核算单价。采购台账与分流的可写详情在 `ProcurementMaterialDrawer.tsx`，共用 `MaterialPriceBody` |
| 表单操作栏 | `WorkbenchLayout.tsx` → `FormFooter` | 左侧状态，右侧操作，主操作最后；研发编辑。台账顶部保存不迁入底部 |
| 客户报价编辑 | `src/workbenches/SalesQuoteEditor.tsx` → `salesQuoteSession.ts` | 销售内部展示／业务会话；状态、保存恢复、采用及退出由会话提供领域动作，复用 Drawer、DecimalInput、FormFooter 和 SalesProductPicker；公开工作台入口不变 |
| 独立测算工作区 | `src/workbenches/SalesCalculator.tsx` → `salesCalculatorWorkspace.ts`／`SalesCalculatorPanel.tsx` | 工作区／请求属业务 Hook；分档、命名、展开和拖拽属面板，修改提议参与退出保护；复用金额输入、菜单、选品和确认；纯逻辑在 `salesCalculatorModel.ts` |
| 研发详情与编辑 | `ResearchProductDrawer.tsx`／`ResearchFormulaEditor.tsx` → `researchEditSession.ts` | 业务内部维护产品身份、原因、可编辑基线、试算 token、draft revision、保存锁与冲突；复用共享退出契约、Drawer、金额输入和底部操作栏 |
| 研发展示与读取 | `ResearchProductView.tsx`／`researchModel.ts`／`researchData.ts` | 原详情、投料、冻结历史及显示口径；根列表合并读取、聚焦与定时取消，权限和写回由业务承担 |
| 看板容器 | `WorkbenchLayout.tsx` → `DashboardPanel` | 标题、内容及尺寸由业务组合；共用 `dashboardPanel` 样式，不统一业务布局 |
| 排行翻页 | `src/components/useMoverPaging.tsx` | 悬停、键盘、详情打开、后台和减少动态效果时暂停；采购／研发排行 |
| 数值／页面状态 | `PriceMovement.tsx`、`WorkbenchLayout.tsx` → `PageState`、`WorkbenchLoading` | 涨跌与无对比展示；错误与重试分开，不把失败当空数据 |
| 授权组合 | `src/components/ActivationGrants.tsx` | 采购／研发同界面，独立业务 scope；保留确认、权限查询和审计逻辑 |
| 历史记录 | `WorkbenchSurface.module.css` → `historyTimeline`、`historyDate` | 日期、事件和时间布局；采购／研发历史。子记录及冻结内容仍由业务负责 |

公共样式原位迁移为 `WorkbenchSurface.module.css`，保留已验收选择器及级联顺序；业务专用研究样式留在 `ResearchWorkbench.module.css`。原料只读展示复用上表的现有业务入口，不把整页组件作为通用控件导出。

W6 将采购、分流、排行及研发消费者迁到上述入口，删除宿主的 `MaterialDrawer`／`ledgerCell` 兼容导出。公共展示没有写 API；可写详情、查询及价格会话由采购业务层维护。实际消费者检查见 [关键回归地图](agents/workbench-regression.md)。

W7 研发编辑会话按产品 ID 挂载，后台刷新不重新初始化填写；冲突保留输入，采用最新服务端可编辑基线并废弃旧凭证。取消本地填写不删除已存草稿，明确取消保存才删除当前 revision 草稿；原因弹窗、标题删除及停用也参加退出／忙碌保护。原料只读入口沿用 W6，维护与实际回归见 [W7 记录](history/records/W7-研发编辑试算与读取生命周期-2026-10-03.md)。

## 操作与展示

- 标题区放业务动作；工具栏左侧搜索／筛选，右侧显示设置。筛选、显示等操作菜单保留前置图标，不加尾箭头；负责人、部门等单选菜单保留尾箭头。台账显示菜单统一提供连续／分页及每页条数，勾选框使用深色选中态；批量选择按业务需要接入。
- 输入紧凑，单位紧邻；只读显示文字，锁定输入置灰。零不等于缺失；金额、百分比及原始精度遵循各自计算规则。
- 确认左取消右确认，危险操作红色。开关展示实际生效状态；授权确认失败时不提前变更。
- 所有关闭方式使用同一检查；忙碌期间不可离开。退出中正文不可交互，卸载后焦点返回原入口。
- 成功绿、待处理橙、失败红、中性灰；权限来源继续区分管理／额外／未授权。避免重复成功提示。
- 工作台列表、模块代码与首次业务读取共用 `WorkbenchLoading`，旋转图标配合业务名称；图表、资讯、数据分流和详情通过 `local` 复用内容区样式，减少动态效果时保留静态提示。
- 后台刷新保留已有内容；首次加载、空结果和失败分别展示。台账刷新不加整表、重排行或数字动画。

## 动效

统一参数在 `src/styles.css` 根变量：按压 120ms、短反馈 160ms、进入 190ms、抽屉 180ms、退出 140ms。曲线复用 `--ease-out` 与 `--ease-drawer`。

`useExitTransition` 负责退出期限、重复关闭保护及卸载清理；业务请求立即执行，不由动画完成事件判断成功。折叠保留高度过渡，异步内容经 ResizeObserver 更新，收起内容 inert。系统减少动态效果时关闭非必要过渡和自动排行；不恢复数字滚动。

## 隔离示例与回归

示例源码：`previews/components/`，不接入正式导航、不访问业务数据。运行 `node scripts/build-component-preview.mjs` 构建到忽略目录 `.scratch/component-preview`；可显式传入隔离前端输出目录，脚本拒绝正式 `dist`。

验收路径：`/previews/components/index.html`。覆盖正常、禁用、加载、失败、长文本、未保存确认、嵌套抽屉、日期及分页；减少动态效果跟随系统设置。

加载状态回归：`node scripts/check-workbench-loading.mjs`，拦截全部业务请求，验证实际采购、研发、资讯、分流的加载与失败，研发走势加载与空结果，销售重试与空结果，独立测算历史读取／失败／重试及计算请求失败、乱序。测算历史复用 `PageState`；读取成功前不能显示“暂无历史”。

自动依赖约定与精确兼容清单见 [frontend-boundaries.json](../scripts/frontend-boundaries.json)。采购台账纯辅助 `buildLedgerRows`／`filterLedgerRows`／`formalLedgerChange` 和图表刻度 `focusedTrendAxis`／`moverDateRange` 保留现有研发复用；原因、维护角色和移除条件统一在清单维护。`SettingsDialog`、`ProfileDialog`、`FeedbackDialog`、`ActivationGrants`、`OrganizationControls` 是现有业务组合界面，目录位置不代表纯控件；其他公共控件不能直接或经本地模块引用业务内部实现（含类型），请求由业务层提供。公开新闻类型位于 `src/types.ts`，资讯组件保留兼容类型再导出。

组件示例之外，局部修改检查受影响的实际消费者；共享组件或全局样式修改覆盖所有受影响页面，按引用定位采购、研发、设置、资料、帮助及反馈的使用点。业务回归按影响覆盖采购跨页编辑及启用、研发原因／联动／试算／草稿锁定与恢复、权限、金额和冻结历史。持续修复验收发现的问题；正式前端替换在隔离验收后按当前有效授权执行。

客户报价维护：`SalesWorkbench` 保留关联目录／批次／历史读取与详情入口；内部编辑组件按打开的原批次 ID 或 `new` 挂载，保存所得 ID／revision 不作 key。`salesModel` 维护纯快照、草稿合并、可编辑规则及原公式；业务 Hook 不向父级暴露 setter。原抽屉实现已移除，无兼容副本。实际挂载、旧成本、部分采用和调整版本回归见 [W4 记录](history/records/W4-客户报价编辑会话模块化-2026-10-02.md)。

W8 的静态元数据、lazy 适配、App 身份、反馈与隔离示例维护见 [静态工作台接入](agents/workbench-integration.md)；新增模块使用该页任务模板，正式启用仍须现有授权和门禁。
