# Issue tracker：GitHub

本仓库使用 GitHub Issues 保存规格与开发任务。用户直接提出的明确请求可以先在本地处理，不因尚无 Issue 阻塞；用户指定 Issue 时读取正文、标签及相关评论。

- 仓库：`gnedhy/honghao-ai-workbench`
- 操作工具：GitHub CLI `gh`
- Pull Request 不作为外部需求入口

## 常用操作

- 创建：`gh issue create`
- 查看：`gh issue view <number> --comments`
- 列表：`gh issue list`
- 评论：`gh issue comment <number>`
- 添加或移除标签：`gh issue edit <number>`
- 关闭：`gh issue close <number>`

多行 Issue 正文应先写入临时 Markdown 文件，再通过 `--body-file` 提交，避免 PowerShell 转义和换行问题。

## Skill 约定

- “发布到任务跟踪器”表示创建 GitHub Issue。
- “读取相关任务”表示读取对应 Issue 的正文、标签和评论。
- Skill 的磁盘文件、当前会话可用能力和显式调用是不同状态；按本次实际可用能力执行，不依赖旧 Skill 名称。缺少专用 Skill 时使用 `gh` 和本页约定，不自动安装替代品。
- 创建、评论、分配或关闭 Issue 依据当前请求或明确调用流程的授权执行；普通本地开发不自动发布到任务跟踪器。
- GitHub Issue 的依赖关系优先使用原生依赖；不可用时，在正文顶部使用 `Blocked by: #<number>`。
- 阻塞项只限制依赖其结果的实现，独立分析与准备可继续；按实际完成证据和有效决定解除依赖，不为开工而关闭未完成事项。
- 用户要求领取任务时使用当前 GitHub 用户作为负责人。

## 功能变更模板

用于工作台新增功能、修复与模块化任务；开发约定见 [协作指引](skill-workflow.md#工作台最小开发约定)，选择测试见 [回归地图](workbench-regression.md)。将字段替换为实际结果，未验证项明确保留。

```markdown
Parent / 依赖：
模块、问题与预期行为：
源码基线与范围：
状态归属：创建 / 保留 / 失效 / 清理；保存中断与重试语义。
数据与权限依赖：正式读取 / 写入；账号范围；是否涉及迁移。
公开入口与实际消费者：新增或改变的接口；兼容导出及移除条件。
验证范围：用例、固定样本、模拟 / 实库边界、命令、预期结果。
扩展接入：workbench-contracts 条目及本次 docs/changes 声明；数据/迁移和兼容边界，受影响下游与实际测试 ID。
验收证据：实际结果 / 耗时 / 基线失败 / 未运行 / 审查。
兼容与恢复：合法历史写入保留方式；代码、配置及数据的恢复边界。
交付状态：候选 / 本地提交 / 推送 / 合并 / 部署；各自证据或待办。
```
