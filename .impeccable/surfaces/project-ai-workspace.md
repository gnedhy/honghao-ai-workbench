# 项目 AI 工作区

- Mode: Operate。H02 页面约定；H04 已实现最小文本执行消费者，完整项目界面／文件／技能仍由 H05—H07 实现，尚未正式启用。当前范围以[领域与交互](../../docs/business/项目AI工作区-领域与交互.md)及 [H04 合同](../../docs/business/项目AI工作区-H04运行接入.md)为准。
- Target: `src/screens/ConversationScreen.tsx`、`src/screens/TaskBoardScreen.tsx`、`src/components/Composer.tsx`、`src/components/Sidebar.tsx`、`src/components/ContextSidebar.tsx`。沿用现有聊天空状态、侧栏、菜单和职能工作台的抽屉与反馈。
- THESIS：在同一任务内持续沟通与交付，项目组织资料和执行要求，正文与真实成果优先。
- OWN-WORLD：`src/styles.css` 的白色内容、浅灰侧栏、公共字体、深色操作、边框与动效；不更换 DESIGN、组件库或另造职能工作台。
- STORY：新聊天 → 按需选项目、资料及真实技能 → 工作提交 → 查看正文/运行与成果 → 同任务补充或下载指定版本；项目详情编辑资料、规则与技能。
- FIRST VIEWPORT：空态显示现有输入区及意图选择；会话态突出正文和当前任务，运行状态紧邻相关回复，成果卡片有版本与下载。状态不堆成全局指标卡。
- Navigation：沿用项目分组与展开；项目更多操作打开单个详情抽屉，资料／规则／技能分段使用已有样式；任务看板定位 taskId 后进入来源会话，不以最近任务推断。
- Reuse：TopBar、Sidebar、Composer 结构，SegmentedControl、WorkbenchMenus、Drawer、DiscardChangesDialog、useUnsavedChanges、confirmWorkbenchLeave、PageState／WorkbenchLoading。业务层提供权限、真实能力、草稿与执行；公共组件只承担呈现和交互。
- States：初次加载、空、错误重试、只读／失权、dirty、上传／保存 busy、部分失败、版本冲突、执行中／等待／完成／停止／受阻、断线确认中。后台执行不等同页面 busy。
- Menus：只有真实可用动作进入菜单；撤下假计划模式、知识引用、工作流、模型切换及样本技能数字。禁用动作说明具体原因，不能以点击后关闭菜单冒充调用。
- Responsive：宽屏延续当前三栏；窄屏侧栏与上下文按现有开关展开，主会话占满可用宽度，输入工具换行且提交与停止保留文字/可访问名称；长文件路径与正文换行，不整页横向溢出。
- Accessibility：键盘可完成导航、选择、提交、停止及下载；焦点与 Esc 沿用公共菜单/抽屉，状态变化适度 aria-live，失败用明确错误文本，不能仅靠颜色；减少动态效果沿用现有规则。
- Exit：所有对象和页面出口参加共享 dirty/busy 检查，取消保留草稿；上传成功原件及后台任务不随卸载删除。身份变化与撤权清理优先，具体保留边界见业务约定。
- Verification：H02 文档一致性、术语与引用检查；H04 已补实际 App 的 1440／390 视口执行／停止／断线／撤权及旧回包与配置重试验证。H05—H07 继续完整页面、文件和技能的交互／权限／退出验证；证据见各阶段候选记录，本页不是截图或运行证据。
