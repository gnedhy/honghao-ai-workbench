# 公共组件与交互约定

新增或调整界面前，先查下表，复用现有入口并在隔离示例验证。已有设计与行为直接适配；只有确实无法覆盖的新业务行为或可见效果才需要重新确认。

## 组件入口

| 用途 | 实现入口 | 可适配内容／实际消费者 |
| --- | --- | --- |
| 确认与放弃修改 | `src/components/Interaction.tsx` → `DiscardChangesDialog` | 标题、说明、按钮、危险／普通确认；设置、资料、反馈、采购、研发 |
| 未保存保护 | 同文件 → `useUnsavedChanges`；`interactionNavigation.ts` | 业务提供 dirty、busy；取消保留输入，确认后继续原导航 |
| 抽屉 | `src/components/Drawer.tsx` | 标题、宽度、正文、关闭前检查；研发详情／编辑、采购版本／本轮记录 |
| 折叠与滚动 | `Interaction.tsx` → `SettingsGroup`、`useMeasuredContent`、`useFadingScrollbars` | 异步高度、默认展开、收起 inert；设置、资料、帮助、授权记录 |
| 搜索单选与日期 | `src/components/WorkbenchMenus.tsx` | 标签、候选、日期区间；采购／研发看板。部门树与多选继续使用 `OrganizationControls.tsx` |
| 开关 | `src/components/Switch.tsx` | 受控选中、禁用、忙碌；设置、授权、配方自动换算。确认及提交由业务提供 |
| 数字输入 | `src/components/DecimalInput.tsx` | 保留输入字符串、单位由外层展示；采购编辑、研发比例／投料。精度与校验不在组件内处理 |
| 台账与工具栏 | `src/components/WorkbenchLayout.tsx`；`WorkbenchSurface.module.css` | 结构与样式复用，列、宽度、筛选及权限由业务提供；采购／研发 |
| 分页、记录筛选 | `LedgerPagination.tsx`、`RecordFilters.tsx` | 总数、页数、筛选状态；采购／研发／反馈 |
| 表单操作栏 | `WorkbenchLayout.tsx` → `FormFooter` | 左侧状态，右侧操作，主操作最后；研发编辑。台账顶部保存不迁入底部 |
| 看板容器 | 同文件 → `DashboardPanel` | 标题、内容及尺寸由业务组合；共用 `dashboardPanel` 样式，不统一业务布局 |
| 排行翻页 | `src/components/useMoverPaging.tsx` | 悬停、键盘、详情打开、后台和减少动态效果时暂停；采购／研发排行 |
| 数值／页面状态 | `PriceMovement.tsx`、`WorkbenchLayout.tsx` → `PageState`、`WorkbenchLoading` | 涨跌与无对比展示；错误与重试分开，不把失败当空数据 |
| 授权组合 | `src/components/ActivationGrants.tsx` | 采购／研发同界面，独立业务 scope；保留确认、权限查询和审计逻辑 |
| 历史记录 | `WorkbenchSurface.module.css` → `historyTimeline`、`historyDate` | 日期、事件和时间布局；采购／研发历史。子记录及冻结内容仍由业务负责 |

公共样式原位迁移为 `WorkbenchSurface.module.css`，保留已验收选择器及级联顺序；业务专用研究样式留在 `ResearchWorkbench.module.css`。不把页面组件作为通用控件导出入口。

## 操作与展示

- 标题区放业务动作；工具栏左侧搜索／筛选，右侧显示设置。批量选择按业务需要接入。
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

加载状态回归：`node scripts/check-workbench-loading.mjs`，拦截全部业务请求，验证实际采购、研发、资讯、分流的加载与失败，以及研发走势加载与空结果的区别。

组件示例之外，必须检查采购、研发、设置、资料、帮助、反馈的实际消费者。业务回归覆盖采购跨页编辑及启用、研发原因／联动／试算／草稿锁定与恢复、权限、金额和冻结历史。正式前端替换须在隔离验收后执行。
