# 公共组件与交互约定

管理员 AI 配置使用 `src/components/AIConfigSettings.tsx`，复用设置页卡片、菜单、确认弹窗和固定底部操作区；模型接入、预算与用量、并发与排队独立保存。用户模型选择的请求与权限保留在 `src/chat/ModelSelection.tsx`，通过 Composer 的 `modelControl` 插槽呈现（聊天同行、工作底部工具栏；项目入口为下方托盘），不把业务请求放入公共输入组件。当前隔离实现与验收见 [管理员 AI 配置](business/管理员AI配置.md)。

新增或调整界面前，先查下表，复用现有入口并在隔离示例验证。已有设计与行为直接适配；只有确实无法覆盖的新业务行为或可见效果才需要重新确认。

## 组件入口

| 用途 | 实现入口 | 可适配内容／实际消费者 |
| --- | --- | --- |
| 确认与放弃修改 | `src/components/Interaction.tsx` → `DiscardChangesDialog` | 标题、说明、按钮、危险／普通确认；设置、资料、反馈、采购、研发、销售 |
| 未保存保护 | 同文件 → `useUnsavedChanges`；`interactionNavigation.ts` | 业务提供 dirty、busy；取消保留输入，确认后继续原导航 |
| 会话输入与项目导航 | `Composer.tsx`／`Sidebar.tsx` | 业务提供正文、busy／只读、项目列表、实际概要及动作；公共组件不创建请求或保存草稿，底部输入与项目上下文复用既有图标及菜单；侧栏内部仅维护页面收起／筛选／五条展开显示；会话菜单由业务onConversationUpdate保存，组件不修改资源归属；业务提供onStop／stopDisabled，执行时右侧动作替换为停止，组件不读取或取消运行，真实消费者为 `ConversationScreen.tsx`／`App.tsx` |
| 分段选择 | `SegmentedControl.tsx` | 值、选项、可访问名称及整体 disabled 由业务提供；按选项数量等宽排版，指示底跟随当前项；聊天意图、任务面板、知识库和自动化现有消费者 |
| 抽屉 | `src/components/Drawer.tsx` | 标题、宽度、正文、关闭前检查；研发详情／编辑、采购版本／本轮记录、销售参数／历史、项目详情；关闭时同步归还焦点 |
| 个性化与指令 | `src/personalization/Personalization.tsx` | SettingsDialog 常显页签、ProjectDrawer 项目入口；复用 Drawer、Switch、DiscardChangesDialog 和安全 MessageBody。指令 Markdown 默认阅读、显式编辑；原生记忆只读查看两个汇总文件、单独确认整体清除。共用 settings-dialog 居中外框、内部滚动和固定操作区，外框 clip 防止聚焦卷走标题；版本冲突保留指令草稿。 |
| 会话管理 | `src/chat/ConversationManagement.tsx` → `SettingsDialog.tsx` | 工作台系统设置内的归档查看／恢复／永久删除；复用设置标题／日志列表、搜索、永久删除确认及安全Markdown预览，复用workspace owner／revision更新和busy出口；Sidebar归档入口指向同页 |
| 任务详情侧栏 | `ContextSidebar.tsx` → `src/tasks/TaskDetails.tsx` | 保留原 320px 侧栏与窄屏规则；任务面板用 React portal 将已有详情放入同一侧栏；运行记录共用 `useTaskRuns`，开始／停止复用执行 Hook，阶段卡片展开进度／结果或进入同任务会话；真实消费者为分组卡片、列表任务与运行记录 |
| 任务列表与运行记录展示 | `src/tasks/TaskPanelRows.tsx` | 复用任务面板的字号、状态图标、灰色表头及渐隐滚动；窄容器重排字段。请求、选择与详情出口仍在TaskBoardScreen；`previews/components/task-panel.html`以只读样例复用同一展示，不请求API或写入任务 |
| 折叠与滚动 | `Interaction.tsx` → `SettingsGroup`、`useMeasuredContent`、`useFadingScrollbars` | 异步高度、默认展开、收起 inert；设置、资料、帮助、授权记录；任务面板／右侧栏复用useFadingScrollbars，包含自身滚动容器 |
| 单选菜单、搜索单选与日期 | `src/components/WorkbenchMenus.tsx` | 普通单选、可选删除、搜索候选、日期区间；采购／研发看板、销售测算。部门树与多选继续使用 `OrganizationControls.tsx` |
| 开关 | `src/components/Switch.tsx` | 受控选中、禁用、忙碌；设置、授权、配方自动换算。确认及提交由业务提供 |
| 数字输入 | `src/components/DecimalInput.tsx` | 保留输入字符串、单位由外层展示；采购编辑、研发比例／投料、销售费用／系数。精度与校验不在组件内处理 |
| 台账与工具栏 | `src/components/WorkbenchLayout.tsx`；`WorkbenchSurface.module.css` | 结构与样式复用，列、宽度、筛选及权限由业务提供；采购／研发／销售 |
| 分页、记录筛选 | `LedgerPagination.tsx`、`RecordFilters.tsx` | 总数、页数、筛选状态；采购／研发／销售／反馈 |
| 原料只读详情与价格单元格 | `src/workbenches/ProcurementMaterialView.tsx` → `ReadOnlyMaterialDrawer`、`ledgerCell` | 采购排行、研发 `ResearchMaterialPrices`；调用方注入各自只读 GET。采购台账与分流的可写详情在 `ProcurementMaterialDrawer.tsx`，共用 `MaterialPriceBody` |
| 表单操作栏 | `WorkbenchLayout.tsx` → `FormFooter` | 左侧状态，右侧操作，主操作最后；研发编辑及项目创建／更名。台账顶部保存不迁入底部 |
| 客户报价编辑 | `src/workbenches/SalesQuoteEditor.tsx` → `salesQuoteSession.ts` | 销售内部展示／业务会话；状态、保存恢复、采用及退出由会话提供领域动作，复用 Drawer、DecimalInput、FormFooter 和 SalesProductPicker；公开工作台入口不变 |
| 独立测算工作区 | `src/workbenches/SalesCalculator.tsx` → `salesCalculatorWorkspace.ts`／`SalesCalculatorPanel.tsx` | 工作区／请求属业务 Hook；分档、命名、展开和拖拽属面板，修改提议参与退出保护；复用金额输入、菜单、选品和确认；纯逻辑在 `salesCalculatorModel.ts` |
| 研发详情与编辑 | `ResearchProductDrawer.tsx`／`ResearchFormulaEditor.tsx` → `researchEditSession.ts` | 业务内部维护产品身份、原因、可编辑基线、试算 token、draft revision、保存锁与冲突；复用共享退出契约、Drawer、金额输入和底部操作栏 |
| 研发展示与读取 | `ResearchProductView.tsx`／`researchModel.ts`／`researchData.ts` | 原详情、投料、冻结历史及显示口径；根列表合并读取、聚焦与定时取消，权限和写回由业务承担 |
| 看板容器 | `WorkbenchLayout.tsx` → `DashboardPanel` | 标题、内容及尺寸由业务组合；共用 `dashboardPanel` 样式，不统一业务布局 |
| 排行翻页 | `src/components/useMoverPaging.tsx` | 悬停、键盘、详情打开、后台和减少动态效果时暂停；采购／研发排行 |
| 数值／页面状态 | `PriceMovement.tsx`、`WorkbenchLayout.tsx` → `PageState`、`WorkbenchLoading` | 涨跌与无对比展示；错误与重试分开，不把失败当空数据 |
| 空集合／筛选无结果 | `WorkbenchLayout.tsx` → `EmptyState`；`WorkbenchSurface.module.css` | 默认48px灰色线条图标、opacity .4、16px间距；候选菜单用20px紧凑形式。任务五列／列表／运行、会话管理、个人记忆与空指令、反馈、管理员日志／人员、采购／研发／销售共用；完整内容区空状态占满可用区域并居中。业务空列表位于表格与横滚容器外，保留表头与分页；移动端只在空集合时填满剩余内容区，有记录时沿用原布局。侧栏、项目关联与部门树小提示保留纯文字。数据不足时保留必要原因及一期实际数值；加载、错误及权限提示不伪装成空数据。 |
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

项目图标显示入口为 `ProjectMark.tsx`：既有8种lucide图标及6色显示，无请求或权限计算；真实消费者为 Sidebar、Composer、ProjectDrawer。外观保存和未知回执保留由 ProjectDrawer 业务层负责。

侧栏项目名称与项目下会话使用相同字号，并对齐文字左缘；最近筛选的全部／聊天／工作使用等高菜单行，不沿用人员菜单首项额外留白。筛选、项目归属与模式判定留在业务层，共用菜单只提供选择与键盘操作。

ProjectDrawer 按现有原生details模式统一名称、图标搜索、颜色／图标单选和保存，图标悬停／键盘聚焦显示小笔；保存状态在项目标题右侧保留title／可访问文本和绿／黄区分。颜色及图标的原生单选框覆盖整个可见选项，保持键盘单选和焦点反馈，避免模态框中1px焦点目标导致内嵌浏览器崩溃。下方直接列会话／任务，使用两行标题、独立任务状态及整行悬停反馈；不再消费SegmentedControl／FormFooter。SegmentedControl 现有聊天及知识页面的两项消费者继续共用等宽grid与白色指示底。

聊天业务Hook保留接受正文并按当前会话读取；运行回调携带真实run，仅任务运行刷新任务。任务请求取消／代次和失权由useChatWorkspace管理，公共Composer／菜单不持有请求。正常对话完成状态仅保留可访问文本，运行／停止及失败恢复仍由ConversationScreen受控展示。

聊天模块私有 `src/chat/MessageBody.tsx` 负责 Markdown／GFM 呈现与原文复制，`src/chat/RunActivity.tsx` 负责真实运行详情按需读取及公开摘要；请求、错误、身份和终态缓存留在聊天模块。`ConversationScreen` 的消息定位复用原生按钮／滚动和details，不新增公共业务请求控件。实际消费者为聊天／工作正文与历史处理记录，验证表格局部横滚、53输入定位、终态保留和撤权。

背景信息窗口复用原生details：桌面悬停／移开显示与隐藏，键盘展开键／Escape及触屏点开可用，三行居中以K显示数量；不显示剩余比例和阈值行，历史context_usage保留原值；背景信息窗口由ConversationScreen读取真实运行DTO，复用原生details和Composer的contextInfo展示槽，仅工作模式显示；Composer不计算用量或发起压缩。工作模式收到原生整理事件时，RunActivity复用重试分隔线布局，居中显示灰色文档图标及「正在精简上下文」，没有按钮；停止状态优先，整理结束恢复普通处理记录。失败重试复用workspace.accept及原提交凭据规则，居中按钮和两侧细线由CSS排版，不新增接口。执行Hook按会话、输入和刷新代次确认状态；自动启动期间隐藏旧处理提示及待执行消息选择，真实未启动输入仍可选择并恢复执行。

任务简短名称复用taskPresentation.ts的taskTitle；ConversationScreen、TaskBoardScreen、ProjectDrawer、ContextSidebar及全局搜索使用同一显示规则，完整目标在详情保留。Sidebar三点菜单复用WorkbenchOptionMenu，可选icon不改变原无图标消费者；重命名及归档恢复复用Drawer／useUnsavedChanges。

任务面板的状态列／任务卡片复用适配后的src/tasks/BoardColumn.tsx，匹配逻辑在src/tasks/taskFilters.ts；来源与许可证见third_party/dashi-taskboard。Sidebar置顶组和行内图钉共用原会话业务保存入口；桌面悬停淡入、键盘与触屏可用。

状态列复用原生overflow、共享渐隐滚动条和可聚焦region；五卡高度上限在视口较矮时收紧，不截断任务集合。任务卡片阶段动作由BoardColumn进入既有TaskDetails或会话回调，单个选中任务维护执行连接，未给每张卡片增加轮询。

人工验收沿用TaskDetails、tool-action与共享busy出口；任务卡片的查看并验收只展开结果，侧栏明确确认后POST严格revision和最新run_id。TaskRun凭据、Task.review／completed由业务保存，公共侧栏不写状态；状态列按可用宽度排为五／三／二／一列，每列继续复用五卡高度上限。

H05闭环接入：ConversationUpdate公共类型由src/types.ts提供，src/api.ts兼容再导出；Sidebar不依赖业务API实现。TaskBoardScreen选择任务／运行都通过App的统一退出回调，验收busy不可卸载详情或归档来源，单任务默认选择由App统一提供给面板及侧栏；执行Hook向业务调用方传原始401／403／404。归档过滤的实际消费者包含Sidebar、ProjectDrawer及全局搜索。最新验证与后续影响见[H05收尾](history/records/项目AI工作区-H05闭环收尾-2026-10-08.md)。

ProjectDrawer 底部移除操作复用 admin-form-actions、DiscardChangesDialog 和项目 PATCH 保存／未知回执核对；日常项目消费者过滤 removed，历史来源消费者保留完整项目索引。

个人账号的 AIUsageView 是只读展示组件，不发请求；ProfileDialog 持有本人统计读取／范围／取消与重试，权限范围和密码继续复用原组件。AI使用情况常显在我的权限范围上方，四项轻字号统计条、月份活动日历、窄屏两列及局部横滚；不使用SettingsGroup折叠该区域。统计范围复用WorkbenchOptionMenu，账号页局部640px宽；运行情况单列、说明分行，窄屏日历默认显示最近日期。同账号范围切换保留上一份结果并局部提示更新，数据绑定actor，账号变化隐藏；错误明确保留结果并可重试，不卸载统计造成弹窗收缩。权限行统一字号，防止项目AI工作区继承16px。

H05切换稳定性：TaskBoardScreen在原选择区提示读取，计数在页头、清除在固定工具栏；ConversationScreen／ConversationManagement同步过滤当前来源，预览重读保留正文并继续逐次鉴权。WorkbenchMenus选择关闭归还焦点使用preventScroll；设置／反馈内容切换不重复淡入，弹窗开启关闭动效不变。见[本轮记录](history/records/项目AI工作区-H05切换稳定性修复-2026-10-12.md)。

运行任务选择复用 WorkbenchOptionMenu 的 side/right 原生顶层弹层和视口避让，公共表面样式支持固定定位，避免 app-main 裁切；PriceDateRangeMenu 打开时限制横向位置，覆盖采购、研发、销售消费者。工作台目录未首次确认前保持 loading，不将尚未读取视为空集合。实际消费者检查及未覆盖项见[菜单与工作台检查](history/records/工作台切换与菜单裁切修复-2026-10-12.md)。

台账及管理员日志的“显示”菜单打开时调用 WorkbenchMenus 的 positionWorkbenchDisplayMenu，按视口及最近滚动容器的上下空间避让。标题和底部浏览设置固定，字段列表在可用高度内独立滚动，重开回到列表顶部，滚动不传递给页面；只有极小空间容不下固定控件时保留整层滚动兜底。采购台账／分发、研发产品／原料、销售和审计日志共用，销售横向避让仍由其原入口负责。
