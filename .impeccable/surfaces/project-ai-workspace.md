# 项目 AI 工作区

- Mode: Operate。H02 页面约定；H04 文本执行与 H05 项目／连续任务界面已在隔离预览实现，尚未正式启用。当前范围以[领域与交互](../../docs/business/项目AI工作区-领域与交互.md)、[H04 合同](../../docs/business/项目AI工作区-H04运行接入.md)及 [H05 界面](../../docs/business/项目AI工作区-H05项目与任务界面.md)为准；文件／下载由 H06、规则／技能由 H07 开放。
- Target: `src/screens/ConversationScreen.tsx`、`src/screens/TaskBoardScreen.tsx`、`src/components/Composer.tsx`、`src/components/Sidebar.tsx`、`src/components/ContextSidebar.tsx`。沿用现有聊天空状态、侧栏、菜单和职能工作台的抽屉与反馈。
- THESIS：在同一任务内持续沟通与交付，项目组织资料和执行要求，正文与真实成果优先。
- OWN-WORLD：`src/styles.css` 的白色内容、浅灰侧栏、公共字体、深色操作、边框与动效；不更换 DESIGN、组件库或另造职能工作台。
- STORY：新聊天 → 按需选项目与聊天／工作意图 → 取得真实消息接受回执 → 幂等启动运行 → 查看正文与运行历史 → 同任务补充。聊天不建任务；重新进入先对账实际活动运行及其输入，不用最新用户消息推断。项目详情当前提供实际归属、会话／任务与更名。
- FIRST VIEWPORT：空态显示现有输入区及意图选择；会话态突出正文和明确选中的任务，分别显示会话项目与任务冻结归属，运行状态紧邻对应输入。正文保留原始换行，执行中输出不与已保存回复重复；状态不堆成全局指标卡。
- Navigation：沿用项目分组与实际会话展开；项目更多操作打开单个详情抽屉，可更名并处理 revision 冲突。任务看板、搜索及上下文返回传明确 taskId 后进入来源会话；多任务历史明确选择任务。运行列表／详情只显示真实状态、时间、正文、停止说明与已报告用量等安全字段。
- Reuse：TopBar、Sidebar、Composer 结构，SegmentedControl、WorkbenchMenus、Drawer、FormFooter、DiscardChangesDialog、useUnsavedChanges、confirmWorkbenchLeave、PageState／WorkbenchLoading。聊天／项目业务 Hook 管理请求、草稿、提交键、接受／启动恢复与身份清理，任务 Hook 管理运行读取／停止；Composer 无业务状态，公共组件只承担受控呈现和操作提议。
- States：初次加载、空、错误重试、刷新失败、只读／失权、dirty、保存／接受／启动停止回执 busy、部分失败、版本冲突、执行中／等待／完成／停止／受阻、断线确认中。后台执行不等同页面 busy；任务接口 403 独立清理任务能力并拦截迟到接受回执，保留可用聊天。管理员查看旧无主记录仅只读，不可输入、提交、执行或更名。
- Menus：只有真实可用动作进入菜单；撤下假计划模式、知识引用、工作流页面及搜索结果、模型切换、文件选择与样本技能数字，保留原源码与历史数据。知识库保持关闭；H06／H07 能力未开放，不放空功能标签。禁用动作说明具体原因，不能以点击后关闭菜单冒充调用。
- Responsive：宽屏延续当前三栏；窄屏侧栏与上下文按现有开关展开，主会话占满可用宽度，输入工具换行且提交与停止保留文字/可访问名称；正文换行，不整页横向溢出。占位文字复用 `--muted`；会话直属状态反馈横向留白为桌面 24px、600px 以下 14px，不改公共状态组件。
- Accessibility：键盘可完成导航、选择、提交及停止；焦点与 Esc 沿用公共菜单/抽屉，Drawer 通过 layout effect 同步清理焦点与监听。状态变化适度 aria-live，失败用明确错误文本，不能仅靠颜色；减少动态效果沿用现有规则。文件下载的键盘验证随 H06 完成。
- Exit：消息／项目 dirty 与回执 busy 参加共享对象和页面出口检查，含侧栏、搜索、新聊天、任务、模式、项目关联、注销、抽屉和浏览器出口；取消保留草稿，布局开合不丢输入。后台任务不随卸载取消；身份变化与撤权清理优先，不等待 dirty 确认。可选 `X-Workspace-Actor` 仅与认证账号比对；账号切换清理旧页面并刷新身份，不提交旧草稿、不注销新 cookie。具体保留边界见业务约定。
- Verification：H05 type／lint 与 69 项 Node 检查通过，5 项定向浏览器场景覆盖实际 App 的 1440／1024／390 视口，含 `h05-identity-switch-never-submits-old-draft`；H03／H04 实际消费者回归通过。UUID 项目创建回执在隔离 PG 快照恢复后去重通过。真实 Ubuntu 内核 0.160／DeepSeek 验证聊天不建任务、工作产生 1 个任务／1 次运行并完成；同任务继续运行由 previousRuns=1 到 currentRuns=2，状态 completed，本次 wall=55444ms、modelNetwork=21879ms、reported=2483 tokens。截图见 [desktop](../review/desktop.png)、[mobile](../review/mobile.png)、[user-1024](../review/user-1024.png)、[native-work](../review/native-work.png)。finish reviewer 的两项修复已解决，结论仅为隔离预览可交付；532 项 API／完整门禁通过且无跳过，最终四张截图复核无视觉阻塞；PR CI及集成交付见 [#77](https://github.com/gnedhy/honghao-ai-workbench/issues/77)，不代表部署或正式启用。
