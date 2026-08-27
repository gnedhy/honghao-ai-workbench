# 宏昊 AI 工作台

这是企业 AI 中台 V0.1 的独立研发项目，当前产品界面暂定名为“宏昊 AI”。当前阶段先由个人在 Windows 本地、小范围、低敏感数据环境中验证一条真实闭环，再决定是否扩展到 AI 团队。

## V0.1 目标

打通这条最小闭环：

`需求材料 → 个人与公共知识 → 智能体任务 → 调用 Skill → 需求诊断 → 分别确认修改 → 项目卡 / 个人知识 / 公共知识候选`

## 当前产物

- [宏昊 AI 平台开发总计划](./开工文档/2026-08-25_宏昊AI平台开发总计划.md)
- [V0.1 范围与暂缓清单](./开工文档/01-V0.1范围与暂缓清单.md)
- [核心数据与状态关系](./开工文档/02-核心数据与状态关系.md)
- [首条 Workflow 与验收样本](./开工文档/03-首条Workflow与验收样本.md)
- [第一周技术验证清单](./开工文档/04-第一周技术验证清单.md)
- [前端原型验证记录](./开工文档/05-前端原型验证记录.md)
- [双侧栏与顶部工具栏验证记录](./开工文档/06-双侧栏与顶部工具栏验证记录.md)
- [侧栏职责、品牌与视觉精修验证记录](./开工文档/07-侧栏职责与品牌优化验证记录.md)
- [品牌资产与侧栏控件修复验证记录](./开工文档/08-品牌资产与侧栏控件修复验证记录.md)
- [项目导航、界面动效与中文化验证记录](./开工文档/09-项目导航与界面动效验证记录.md)
- [知识库字阶、新会话与右栏下拉验证记录](./开工文档/10-知识库字阶与新会话验证记录.md)
- [工作提交按钮与品牌区精简验证记录](./开工文档/11-工作提交按钮与品牌区精简验证记录.md)
- [聊天与工作输入区 Codex 细节验证记录](./开工文档/12-聊天与工作输入区Codex细节验证记录.md)
- [工作模式项目上下文控件验证记录](./开工文档/13-工作模式项目上下文控件验证记录.md)
- [聊天、工作与项目菜单验证记录](./开工文档/14-聊天工作与项目菜单验证记录.md)
- [输入上下文、固定对话列与双模式侧栏验证记录](./开工文档/15-输入上下文与双模式侧栏验证记录.md)
- [轻项目重关联验证记录](./开工文档/16-轻项目重关联验证记录.md)

## 启动本地工作台

```powershell
npm.cmd install
uv sync --group dev
uv run python -m api.cli create-admin
npm.cmd run dev
```

`npm.cmd run dev` 会同时启动本地 API 与前端：

- 前端：`http://127.0.0.1:4173/`
- API 文档：`http://127.0.0.1:8000/docs`

环境要求：Node.js 24、Python 3.12 和 [uv](https://docs.astral.sh/uv/)。Node 依赖由 `package-lock.json` 管理，Python 依赖由 `uv.lock` 管理。

默认运行数据保存在仓库内的 `.data/`，其中 `.data/controlled-work/` 是后续任务使用的默认受控工作目录；整个数据目录都不会提交到 Git。可通过 `HONGHAO_DATA_DIR` 指定其他本地数据目录；测试始终使用独立临时目录，不会读写正式数据。

默认运行环境为 `test`。测试与正式实例必须使用不同的数据目录、账号、数据库、文件和密钥；同一数据目录一旦写入运行配置，不能改作另一种环境启动。正式实例应显式设置：

```powershell
$env:HONGHAO_ENVIRONMENT = "production"
$env:HONGHAO_DATA_DIR = "D:\HonghaoAI\production-data"
```

### 首次创建本地管理员

系统不提供默认账号、默认密码或自助注册。首次启动前交互创建系统管理员；如设置了 `HONGHAO_DATA_DIR`，应先设置环境变量再执行：

```powershell
uv run python -m api.cli create-admin
```

密码使用随机盐和 `hashlib.scrypt` 保存；浏览器只接收 HttpOnly、SameSite=Strict 的本地登录会话 Cookie。账号停用或角色变化后，既有登录会话会立即失效。

### 顶层功能模块状态

测试环境默认只启用工作台，知识库、AI 会话、自动化和任务看板保持关闭；全新的正式环境默认关闭全部模块。系统管理员可在“系统设置 → 常规”中选择“关闭 / 原型 / 启用”；保存后显示为待生效状态，重启当前服务后应用。配置保存在当前 `HONGHAO_DATA_DIR`，不会影响另一套实例。

测试环境仍可在首次启动时使用环境变量指定初始状态：

```powershell
$env:HONGHAO_MODULE_WORKBENCH_MODE = "active"
$env:HONGHAO_MODULE_KNOWLEDGE_MODE = "off"
$env:HONGHAO_MODULE_CHAT_MODE = "off"
$env:HONGHAO_MODULE_AUTOMATION_MODE = "off"
$env:HONGHAO_MODULE_TASKS_MODE = "off"
npm.cmd run dev
```

- `active`：开放真实功能。
- `prototype`：开放并明确标注为功能原型。
- `off`：隐藏入口，相关业务接口同时返回不可用。

配置缺失时使用上述默认值；配置值非法时服务拒绝启动，不会静默开放模块。

正式环境禁止通过 `HONGHAO_MODULE_*_MODE` 绕过后台门禁。将模块改为“启用”前，管理员必须确认业务负责人、数据安全和代码审查三项均已通过；审查确认会随待生效配置一同保存，重启时再次校验。发布仍由管理员或 IT 使用审核后的版本标签手动完成；系统不提供一键发布。

### 职能工作台模块状态

四个职能工作台默认保持当前原型，可分别通过环境变量切换为 `prototype`、`active` 或 `off`：

```powershell
$env:HONGHAO_WORKBENCH_PROCUREMENT_MODE = "prototype"
$env:HONGHAO_WORKBENCH_RESEARCH_MODE = "prototype"
$env:HONGHAO_WORKBENCH_SALES_MODE = "prototype"
$env:HONGHAO_WORKBENCH_MANAGEMENT_MODE = "prototype"
npm.cmd run dev
```

- `prototype`：显示明确标注的示例界面。
- `active`：启用真实模块；真实实现尚未接入时，界面会安全阻断，不展示示例数据。
- `off`：隐藏该职能入口；后续真实业务接口也必须使用同一开关阻断。

配置只在启动时读取，修改后需要重启。影子验证应使用单独的 `HONGHAO_DATA_DIR` 和测试数据副本；正式实例发生异常时，先把对应模块切回 `prototype` 或 `off`，不要删除模块数据。当前 UI 基线可从标签 `workbench-ui-baseline-2026-08-25` 恢复。

模块迁移前先停止本地服务，并创建不会覆盖已有文件的 SQLite 一致性备份：

```powershell
uv run python scripts/backup_database.py .data/honghao.db .data/backups/pre-procurement-v1.db
```

统一验证命令：

```powershell
npm.cmd run verify
```

## 在另一台电脑继续开发

首次在新电脑上接续项目：

```powershell
gh auth login
gh repo clone gnedhy/honghao-ai-workbench
cd honghao-ai-workbench
npm.cmd install
uv sync --group dev
uv run python -m api.cli create-admin
npm.cmd run dev
```

后续开始工作前同步远端更新：

```powershell
git pull --ff-only
```

## 当前阶段

1. 完成立项基线与“个人 AI 会话优先”的 V0.2 信息架构方案。
2. 已完成 React + Vite + TypeScript 前端原型，并形成固定桌面左栏、页面级可收起右侧工具栏、PC 三栏与移动端双抽屉工作台。
3. 已完成 FastAPI + SQLite 本地运行骨架、会话与轻项目的稳定关联，以及从工作提交创建持久任务的真实数据闭环。
4. 知识基础已具备 PDF 原件隔离上传、人工安全确认、限时文本解析、待审 Markdown 版本、来源追溯和资源级读取边界；知识模块继续保持关闭，待文档管理与发布审核界面完成后再启用。

当前视觉方案：

- [V0.5 Codex 视觉规范](./设计概念/V0.5-Codex视觉规范.md)
- [V0.5 Codex 视觉基准](./设计概念/Codex视觉基准-V0.5.png)
- [V0.4 高端视觉方向说明](./设计概念/V0.4-高端视觉方向说明.md)
- [V0.4 石墨仪器台候选](./设计概念/高端视觉候选-V0.4-石墨仪器台.png)
- [V0.2 信息架构说明](./设计概念/V0.2信息架构说明.md)
- [V0.2 概念生成说明](./设计概念/V0.2概念生成说明.md)
- [V0.3 Taste 视觉评审](./设计概念/V0.3-Taste视觉评审.md)
- [Taste 融合候选 V0.3](./设计概念/Taste融合候选-V0.3.png)
- [Taste 方向 A：墨蓝编辑系统](./设计概念/Taste方向-A-墨蓝编辑系统.png)
- [Taste 方向 B：雾蓝精密](./设计概念/Taste方向-B-雾蓝精密.png)
- [Taste 方向 C：石墨纸张](./设计概念/Taste方向-C-石墨纸张.png)
- [智能体会话工作模式](./设计概念/智能体会话工作模式-V0.2-概念稿.png)
- [知识库](./设计概念/知识空间-V0.2-概念稿.png)
- [自动化 Skill](./设计概念/自动化Skill-V0.2-概念稿.png)
- [任务看板](./设计概念/任务看板-V0.2-概念稿-v2.png)
- [个人资料菜单](./设计概念/个人资料菜单-V0.2-状态稿.png)

## 研发原则

- Markdown 是知识正文的权威来源，SQLite 保存状态、版本、关系、任务运行和可重建索引。
- PDF 等原文件是不可覆盖的来源资产；Markdown 版本必须保留来源 ID、文件名与哈希，解析失败不得删除原件或生成伪正文。
- 智能体只可操作受控工作目录；正式修改必须先生成预览并由人确认。
- 固定工作流负责业务阶段和人工关口；智能体执行器只在节点内运行有界循环，并记录每轮事件、预算与停止原因。
- 产品界面统一使用“待确认修改”；内部数据模型保留技术名称 `ChangeSet`。
- V0.1 只持久化用户主动提交的会话消息，不保存模型临时推理过程；任务结束时只提出知识、失败样本和 Skill 改进候选。
- 个人知识由本人确认后沉淀；公共知识候选需单独确认，并在独立审核后发布。
- 数据安全审查和代码审查贯穿研发，但不取代产品主线。
