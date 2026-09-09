# 宏昊 AI 工作台

这是以职能工作台为核心的本地 Web 应用，产品界面名为“宏昊 AI”。当前优先完成采购原料成本管理，再按业务需要推进其他职能工作台；不以完成整套 AI 平台为本轮交付前提。

## 当前目标

优先完成并验收工作台闭环：

`原料目录 → 共同录价 → 波动核对 → 授权启用 → 部门引用 → 价格历史追溯`

知识库、AI 会话、任务、自动化、Harness、Skill 和 Workflow 均为后续待评估能力，不承诺固定加入顺序，也不在本轮删除现有实现和数据。当前范围以 [工作台优先决策](./docs/adr/0008-工作台优先与候选验收边界.md) 为准。

## 早期规划与设计记录

以下材料保留用于追溯，不替代上面的当前目标或代表已上线能力。

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

### 构建后的单入口运行

单入口运行不需要 Vite 开发服务器。先构建，再由 FastAPI 同源提供页面和 API；端口 8000 不代表正式环境，环境由数据目录标记及运行配置决定：

```powershell
npm.cmd run build
npm.cmd run serve
```

提交或启用模块前运行完整门禁：

```powershell
npm.cmd run security:check
npm.cmd run verify
```

安全检查为只读操作；发现硬编码凭据、误纳入仓库的数据文件、动态执行、危险 HTML 或未批准的免登录 API 时会直接失败。模块正式启用还必须完成业务确认、数据安全审查、代码审查和回退演练，详见 `docs/security/模块启用审查清单.md`。

浏览器访问 `http://127.0.0.1:8000/`。`/api/health` 只表示服务进程存活，`/api/readiness` 同时检查数据目录、数据库、迁移版本和模块配置；readiness 返回 503 时不得将实例视为可用。

默认只监听本机。只有明确配置 HTTPS 和 Windows 防火墙后，才可使用 `--host 0.0.0.0` 暴露到局域网。

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

密码使用随机盐和 `hashlib.scrypt` 保存；浏览器只接收 HttpOnly、SameSite=Strict 的本地登录会话 Cookie。账号停用、系统管理权限或范围等级变化后，既有登录会话会立即失效。

权限采用“每个授权范围独立设置”：普通账号可在采购、研发、销售、总经办工作台和知识库分别获得查看、编辑或管理权限。查看只能读取授权数据；编辑可以新建、修改、导入和提交；管理可以审核、退回、确认、发布及管理范围内业务。系统管理独立设置并自动拥有全部范围。部门仅为人员资料。敏感字段同时校验最低权限与允许范围，未配置开放范围时仅系统管理员可访问。

采购采用共同录价、独立启用授权：编辑人员可录价，管理员及配置的授权管理人员可以授予和撤销启用权；获授权者不能转授权。价格写入及启用仍受敏感字段策略控制。其他模块维持原有复核边界，详见 `docs/adr/0007-采购共同录价与正式价格分流.md`。

### 采购真实数据的隔离验收

四个平级入口：采购看板、原料台账、数据分流、价格历史。当前在用原料 138 项、20 期价格版本；原始来源中的 322 项无价原料已可恢复归档，不再显示为在用。v20 本期已报 30 项、沿用 108 项。版本详情比较上一价格版本；看板按所选时间范围比较有效价格，涨幅和降幅分别排序。区间价和异常原文单独保留，不取均值。

首次迁入与日常上传分开。管理员可通过 `uv run python -m api.cli procurement-history <xlsx路径>` 只读预检；加 `--apply --actor-id <管理员ID> --sha256 <预检哈希>` 才写入空采购库。日常页面支持 CSV/TXT 与单工作表、单价格日期的 XLSX 预览，未知编号不自动建目录，空白不清空现价。

`scripts/procurement_acceptance.py` 只在新空目录准备初始导入验收样本、随机测试账号及快照；不会自动复现后续归档和人工修改，不能替代已验收数据库的备份。账号文件保存在仓库外，不修改原始 Excel。

2026-09-09 当前本机状态：8012 是已验收程序与采购数据基准；8020 是同一固化程序、合并后候选数据的独立验收副本，用户已验收。新 production 候选库仍未启用，旧 `.data` 为 test，不是正式库。候选库保留旧库的项目、会话、消息和任务，采购域整体取自 8012。8020 的试操作不自动回写候选库。详细对比与发布边界见 [验收收尾记录](./docs/验收收尾-2026-09-09.md)。提交、推送不等于合并或正式上线，正式启用仍需既有 Issue/PR 与审查记录。

### 运维、备份与恢复

统一使用 `python -m api.cli` 管理当前 `HONGHAO_DATA_DIR`：

```powershell
uv run python -m api.cli migrate
uv run python -m api.cli doctor
uv run python -m api.cli backup
```

`backup` 默认在当前数据目录的 `backups/` 下创建唯一快照，包含 SQLite、运行配置、PDF 原件、Markdown 和 SHA-256 清单。**当前不会打包采购来源 Excel**：完整备份须额外保留 `controlled-work/procurement-sources/`，按 `procurement_source_imports.sha256` 校验；恢复到新目录时还需更新 `stored_path`，不能依赖原实例文件。程序及构建产物也应单独固化。也可指定其他位置：

```powershell
uv run python -m api.cli backup --destination "D:\HonghaoAI\snapshots"
```

恢复命令默认只做完整性校验，不写入数据：

```powershell
uv run python -m api.cli restore "D:\HonghaoAI\snapshots\snapshot-..." --verify-only
```

真正恢复前必须先停止 API 和前端服务，然后显式二次确认；系统会先自动保留一份写入前快照：

```powershell
uv run python -m api.cli restore "D:\HonghaoAI\snapshots\snapshot-..." --apply --confirm RESTORE
```

Windows 更新与回退固定采用以下顺序：

1. 停止当前 `serve` 窗口或结束其受控进程。
2. 运行 `backup` 保存当前数据快照。
3. 更新代码并执行 `npm.cmd install`、`uv sync --group dev`、`npm.cmd run verify`。
4. 运行 `migrate` 和 `doctor`，再重新执行 `npm.cmd run build`、`npm.cmd run serve`。
5. 代码异常时回到上一个审核标签重新构建；数据异常时停止服务后使用 `restore --apply --confirm RESTORE`。

开机运行应由 IT 使用 Windows 任务计划程序调用仓库中的 `npm.cmd run serve`，工作目录必须固定为本仓库；不要配置多个实例共享同一 `HONGHAO_DATA_DIR`。

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

正式环境禁止通过 `HONGHAO_MODULE_*_MODE` 绕过后台门禁。将模块改为“启用”前，管理员必须确认业务负责人、数据安全、代码审查和回退演练四项均已通过；审查确认会随待生效配置一同保存，重启时再次校验。发布仍由管理员或 IT 使用审核后的版本标签手动完成；系统不提供一键发布。

### 职能工作台模块状态

四个职能工作台默认保持原型，可分别通过环境变量切换为 `prototype`、`active` 或 `off`。采购“原料成本管理”已完成首版真实模块；研发、销售和总经办仍使用安全阻断页等待后续接入：

```powershell
$env:HONGHAO_WORKBENCH_PROCUREMENT_MODE = "prototype"
$env:HONGHAO_WORKBENCH_RESEARCH_MODE = "prototype"
$env:HONGHAO_WORKBENCH_SALES_MODE = "prototype"
$env:HONGHAO_WORKBENCH_MANAGEMENT_MODE = "prototype"
npm.cmd run dev
```

- `prototype`：显示明确标注的示例界面。
- `active`：启用真实模块；除采购外，真实实现尚未接入的工作台会安全阻断，不展示示例数据。
- `off`：隐藏该职能入口；后续真实业务接口也必须使用同一开关阻断。

配置只在启动时读取，修改后需要重启。影子验证应使用单独的 `HONGHAO_DATA_DIR` 和测试数据副本；正式实例发生异常时，先把对应模块切回 `prototype` 或 `off`，不要删除模块数据。当前 UI 基线可从标签 `workbench-ui-baseline-2026-08-25` 恢复。

采购支持 CSV、TXT、单表 XLSX 和复制粘贴导入预览，台账展示最新价格，通过替代记录保留修正链，授权启用后形成不可变价格版本。采购接口限定在 `/api/workbenches/procurement/*`，数据使用独立的 `procurement_*` 表和 `workbench_procurement_schema_version` v5；核心 schema 保持 v5。原料价格与询价记录仍受对应敏感字段策略控制。

原料台账与本轮更新共用一张工作表；有活动更新时显示待发布价和行内补价；行内波动确认仅用于遗留未确认事项或重新核对，启用后恢复日常正式价格列。日常列偏好与本轮临时列设置分离。现有批次响应新增 `input_items`，包含该批次录入或复制的候选项（含未变价、零价和缺价）；原 `items` 仍只返回变价明细。前端按归属区分未调整与待补价，不根据空价格或日期猜测。

“编辑价格”支持台账跨页输入后统一保存；统一价格日期和修正原因，清空输入只撤回未保存修改，不删除已有报价。`POST /api/workbenches/procurement/prices/bulk-adjustments` 复用单项录价存储逻辑，在同一事务内完成整批写入，并校验编辑开始时的批次标识和更新时间；冲突或任一行失败均不写入。启用前，最新价格保持不变；批量确认窗口将原因和参考价一起提交，保存与波动确认在同一事务完成。价格基准或参考价变化时拒绝过期确认，输入保留供重新核对；未携带确认信息的单笔或旧接口仍保留待确认门槛。“取消更新”在本轮操作区以二次点击确认；只读操作记录使用抽屉，不占用表格高度。未保存修改在离开前提示，日常列偏好保持独立。

每轮候选价格使用现有工作批次明细保存，发布时由当前正式基线合并该批次变更；未录入项目保留正式价，缺价或未确认波动阻止启用。排期与已取消草稿不会混入下一轮；重新录入会重新计算风险，当前入口在保存时确认本次新价格；基线变化仍会使对应风险确认失效。正式价日期使用 `published_price_date`，询价日期继续使用 `price_date`。价格批次可打开只读快照，定时版本同时显示批准人和系统启用方式。

单机服务启动时补处理到期排期，运行期间每30秒检查，状态纳入 `/api/readiness`。暂停服务期间不会自动启用；新正式基线会将旧排期置为需要重新确认。采购回归测试使用独立临时数据目录，不能在当前演示库执行导入、取消或启用测试。

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

## 既有基础与后续边界

1. 已有“个人 AI 会话优先”的早期信息架构记录；当前优先级已调整为工作台，不据此自动继续旧路线图。
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
