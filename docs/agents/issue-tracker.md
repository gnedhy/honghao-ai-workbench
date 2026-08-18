# Issue tracker：GitHub

本仓库的规格与开发任务保存在 GitHub Issues：

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
- `to-spec`、`to-tickets`、`triage` 和 `implement` 均以 GitHub Issue 为正式任务来源。
- GitHub Issue 的依赖关系优先使用原生依赖；不可用时，在正文顶部使用 `Blocked by: #<number>`。
- 任务只有在全部阻塞项关闭后才可进入实现。
- 领取任务时使用当前 GitHub 用户作为负责人。
