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
