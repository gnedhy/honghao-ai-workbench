# 静态工作台接入

这是新增工作台的唯一接入维护入口。当前正式模块仍为采购、研发和销售；本页与隔离示例不批准启用总经办或其他新模块。先按 [项目规则](../../AGENTS.md)确认业务范围，再使用 [开发流程](skill-workflow.md)和[回归地图](workbench-regression.md)。

## 按现有入口接入

| 位置 | 维护内容 |
| --- | --- |
| [types](../../src/types.ts) | 明确的工作台／页面类型和页面名称；保持共享类型，不导入业务实现 |
| [workbenchRegistry](../../src/workbenchRegistry.ts) | 静态元数据、导航顺序、图标、设置名称和反馈上下文；示例数据只用于标明的 prototype |
| [WorkbenchModuleSlot](../../src/workbenches/WorkbenchModuleSlot.tsx) | 明确的 lazy import 和对应 props 适配；active 但未注册时显示受保护占位 |
| 所属工作台 | 数据源、读取／写入、权限、计算、草稿和退出保护；复用[组件索引](../components.md)，不把业务表单移进 App |
| [App](../../src/App.tsx) | 身份、模块状态、选中／展开页面与公共协调；编辑器不按页面或 preview/full 加 key |
| [服务端授权](../../api/authorization.py)及模块路由 | 当前权限、状态、字段和写事务验证；前端可见性不替代服务端校验 |

ModuleBoundary 按用户 ID／工作台 ID 隔离错误。chunk 加载失败使用“重新加载页面”清除浏览器模块缓存；单纯重置 React.lazy 的失败边界不能证明恢复。真实编辑器继续使用 beforeunload 保护刷新。

同用户资料变化保留会话。权限变化重新读取状态；首次失败阻断，已有成功状态的后台失败标明“上次确认”并保留输入，重试不重新挂载编辑器。当前权限低于查看级别时立即隐藏对应入口；最终写入由服务端判断。

## 最小接入任务模板

复制下面各行到任务说明，填写具体对象后实施，不需要另建注册框架。

接入时同步 [工作台契约](../../scripts/workbench-contracts.json)，自动核对前后端 ID、页面、导航、lazy 入口和实际测试。新增模块与功能扩展都按 [持续质量保障](continuous-quality.md)提交本次产品变更声明；包含数据版本/迁移、旧请求/记录兼容以及受影响下游，不沿用旧声明冒充本次验收。

- 范围：工作台 ID、页面 ID、已批准业务、prototype／active／off；未批准事项。
- 数据与权限：GET 来源、初次／后台／空／失败表现、取消旧读取；查看／编辑／管理级别，写事务中的权限和版本检查。
- 状态：每个草稿创建、保留、失效和清理的时点；dirty、busy、冲突、保存结果分别由哪个业务模块负责。
- 出口：局部返回、切页、搜索、导航、注销和刷新；通过 [confirmWorkbenchLeave](../../src/components/interactionNavigation.ts) 等待所有已挂载编辑器。新模块使用 `workbench-before-leave`，现有三个事件兼容保留。
- 挂载：用户／业务对象身份决定 key；同对象后台刷新保留输入，不因页面或 preview/full 给业务根换 key；批准退出后由宿主清理已退出局部会话；卸载取消读取、监听、定时器及待决确认。
- 验证：实际消费者、请求和写入次数、取消保持输入、忙碌拒绝离开、真实错误恢复、只读／撤权、冻结记录；定向通过后保留完整门禁。
- 性能：按 [性能预算](performance-budget.md)登记模块构建、浏览器及实库 profile，固定负载实际采样；验证全部指标和样本，预算变化提供本次证据。
- 恢复：代码／构建证据与恢复位置；代码回退不删除合法业务数据；提交、推送和正式替换遵循当前授权。

## 可执行隔离示例

[StaticWorkbenchExample](../../previews/components/StaticWorkbenchExample.tsx)包含注入的只读数据源、权限、加载／空／失败／重试、preview/full、本地草稿、忙碌和共享退出。它只引用已有 `PageState`、`WorkbenchLoading`、`useUnsavedChanges`，不调用业务 API。新模块可按这个具体组件补自己的业务操作，无需插件平台或全局 store。

[check-app](../../scripts/check-app.mjs) 的独立 Vite 服务器仅在测试中将示例注入未注册 slot；正式 App 和构建不导入它。[fixture](../../tests/test_app_ui.py)准备合成 PostgreSQL 数据、随机 API 端口和 test 身份，未拦截 API 返回 503。示例验证权限拒绝、读取失败重试、进入、草稿取消保持、忙碌和放弃后退出，并检查不写业务表。

按 README 配置专用测试库后执行 `uv run --locked pytest tests/test_app_ui.py -q -s`；完整验收执行 `npm run verify`。不把维护者 `.scratch` 路径或本机凭据复制为新协作者的启动配置。

反馈独立维护于 [useAppFeedback](../../src/appFeedback.ts)与[FeedbackDialog](../../src/components/FeedbackDialog.tsx)：草稿保留在本次登录，30 秒／聚焦／可见性单飞读未读，窗口卸载取消请求；普通关闭保留新建草稿，身份变化清空会话。反馈不成为工作台业务状态仓库。

新增模块或关键任务还须同步 [生产监测约定](operations-monitoring.md)的实际检查、责任和恢复入口；统一 verifier 保护 moduleChecks 的完整性。

## 聊天与任务增强

H04 沿此静态条目接入 [CodexRuntime](../../api/codex_runtime.py)、聊天所属 [useConversationExecution](../../src/chat/useConversationExecution.ts)及实际会话消费者；记录真实运行、SSE 和恢复，不添加工作台 ID。具体接口与权限／预算见 [H04 合同](../business/项目AI工作区-H04运行接入.md)。完成后的正文／任务读取失败有明确提示和重新对账，身份失效优先清理；后台运行与页面 busy 分开。

H05 延续聊天／任务条目，列表与消息读取、提交回执和草稿归 `src/chat/` 所属 Hook，项目抽屉与任务历史复用公共控件。公共 Composer、Sidebar 和分段控件只接收受控值／提议。任务 403 与身份失效分开，迟到回执检查当前能力；真实消费者、0008／快照恢复和退出范围见 [H05 合同](../business/项目AI工作区-H05项目与任务界面.md)及本项 `docs/changes` 声明，没有新的工作台注册。

H03 的 chat/tasks 使用同一静态契约文件的 `modules` 条目，校验真实模块 ID、业务维护者、权限、数据、退出恢复与实际消费者；不登记为职能工作台，不建立运行时注册器。已有工作台检查保持不变。任务范围验证可选 `--scope chat` 或 `--scope tasks`，涉及身份、迁移、公共类型和跨模块变更仍以 `--scope all` 收尾。文件、规则和技能实际接口在 H06/H07 接入时补齐对应合同与回归。
