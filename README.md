# 宏昊 AI 工作台

面向企业日常业务的本地工作台，采购、研发和销售报价已正式启用。

2026 年 9 月 15 日已完成 PostgreSQL 正式切换，9 月 24 日正式启用销售报价及独立测算工具，9 月 29 日更新台账细节和研发产品成本 Excel 导出，9 月 30 日同步三期原料行情、更新趋势图、补齐系统更新日志并修复测算工具在普通 HTTP 下的加载问题；原账号与业务数据保留。[当前部署记录](docs/releases/测算工具HTTP兼容修复-2026-09-30.md) · [当前交接](docs/当前交接.md)。

## 已实现

| 工作台 | 主要能力 |
| --- | --- |
| 采购 | 原料价格与库存台账、共同录价、核对启用、部门分流、价格历史 |
| 研发 | 只读原料价格、双成本核算、配方与投料编辑、草稿试算、受控手动调整、引用链成本更新、Excel 导出 |
| 销售 | 销售看板、产品成本与报价参考、报价历史、客户报价保存采用及调整记录、独立测算工具 |
| 账号与授权 | 部门人员管理、分级权限、独立启用授权、操作记录 |

采购价格更新后自动同步研发成本；手动调整需记录原因、保存草稿并核对启用。其他功能保留现有源码，按已确认范围逐步开放。

## 参与开发

首次拉取后先读 [项目规则](AGENTS.md)和[开发协作指引](docs/agents/skill-workflow.md)，再准备下方本地环境。可以使用自己的编辑器、AI 工具和开发流程，无需安装维护者的个人 Skill；项目业务、设计、数据安全、验证及授权规范仍须遵守。

## 技术栈

| 层次 | 当前实现 |
| --- | --- |
| 前端 | React 19、TypeScript 7、Vite 8 |
| 界面与图表 | 项目自有公共组件、CSS / CSS Modules；Lucide 图标、Recharts 图表 |
| 后端 | Python 3.12、FastAPI、Uvicorn |
| 存储 | PostgreSQL 18、psycopg 3；附件保存在独立数据目录，数据库结构通过显式迁移管理 |
| 验证 | pytest / HTTPX 后端测试、Node.js 内置前端测试、Playwright 浏览器验证，以及类型、构建和安全检查 |
| 依赖管理 | npm 与 uv；使用仓库锁文件安装 |

依赖声明见 [package.json](package.json) 和 [pyproject.toml](pyproject.toml)，精确版本以 [package-lock.json](package-lock.json) 和 [uv.lock](uv.lock) 为准。Skill 是可选开发辅助，不属于应用运行技术栈。

## 本地启动

本机已部署的正式工作台：用户要求“启动服务”或“启动工作台”时，在项目根目录执行 `powershell.exe -NoProfile -File scripts/start-workbench.ps1`；也可双击 [启动工作台.cmd](启动工作台.cmd)。脚本读取现役 `active.json`，检查数据库服务与端口进程，未运行时调用现有正式入口，等待就绪后打开页面。`-CheckOnly` 检查部署配置、数据库服务和已有端口的进程归属，不启动应用。执行仍受工具审批和系统执行策略约束，不通过脚本绕过拦截。

需要 **Node.js 24、Python 3.12、uv 和 PostgreSQL 18**。先准备独立数据库、迁移账号及应用账号，再安装依赖：

```powershell
npm ci
npm exec -- playwright install chromium
uv sync --group dev
```

采购资讯在后端运行期间通过 Node.js、Playwright 和 Chromium 定时抓取；Playwright 不仅用于测试。新设备拉取、更新依赖或复制到独立部署目录后，都须完成[采购资讯运行依赖与验收](docs/运行与维护.md#采购资讯运行依赖与验收)，不能只部署 Python 与 `dist`。

按 [隔离启动步骤](docs/运行与维护.md#启动本地工作台)配置独立数据库、附件目录和端口。结构迁移使用 `uv run python -m api.cli migrate`，服务使用同库应用账号；连接凭据从受保护配置注入。默认开发代理指向 8000，与正式服务同机时使用文档中的临时代理配置。

按上述隔离步骤启动后，打开其配置的开发页面（示例为 `http://127.0.0.1:4174/`），使用刚创建的管理员账号登录；仓库默认 Vite 端口为 4173。新检出的代码不包含现有账号与业务数据；未配置数据库时服务保持不可用。

构建与检查：

```powershell
npm run verify
```

`verify` 包含完整用例数量门禁、增量 React／依赖检查、Node 逻辑、实际组件浏览器、类型与隔离构建、安全扫描及完整接口测试。构建输出为 `.scratch/verify/all/dist`；接口测试要求独立 PostgreSQL 测试库，缺少环境会失败。按影响检查可用 `npm run verify -- --scope sales|procurement|research`（选择一个值），不能替代提交前完整门禁。命令、环境与 CI 边界见 [关键回归地图](docs/agents/workbench-regression.md)。单入口启动见 [运行与维护](docs/运行与维护.md#构建后的单入口运行)。

2026-10-02 本地 W4 报价编辑会话候选承接 W2／W3，拆分业务协调和展示，并修复部分采用保存及旧成本显示；实现与验收见 [W4 记录](docs/history/records/W4-客户报价编辑会话模块化-2026-10-02.md)。源码、CI 与正式发布分别按当前授权推进。

2026-10-03 用户继续批准 W5，独立测算候选分离工作区／请求和面板编辑，修复保存交错及草稿退出保护，校正等级 2 只读测算权限；完整 486 API 及最后修复后的销售范围 20 API 均通过，最终候选见 [W5 记录](docs/history/records/W5-独立测算工作区模块化-2026-10-03.md)。尚未提交、推送或部署。

W6 阶段（2026-10-03）：候选分支 `codex/w6-procurement-ledger`，HEAD 保持 W1，保留 W2—W5。采购原料公开只读展示、查询和编辑会话已拆分，11 个真实消费者场景及完整 487 用例门禁通过。结果见 [W6 记录](docs/history/records/W6-采购台账与原料公开展示模块化-2026-10-03.md)；当时尚未提交、推送或部署。

同日获准继续 W7；当时分支 `codex/w7-research-lifecycle`，HEAD 保持 W1，保留 W2—W6。研发详情、编辑会话与根读取已拆分，18 个真实场景及完整 488 用例门禁通过，见 [W7 记录](docs/history/records/W7-研发编辑试算与读取生命周期-2026-10-03.md)。尚未提交、推送或部署。

## 项目结构

```text
api/        后端服务与数据逻辑
src/        前端界面与共用组件
public/     公共资源
tests/      接口与业务测试
tests_ui/   前端测试
scripts/    数据配置与维护工具
docs/       使用、运维、决策与历史说明
```

运行数据、依赖、构建产物、日志和本地归档不进入仓库。早期设计原件保留在本机，整理后的历史说明位于 `docs/history/`。

## 文档

[文档导航](docs/README.md) 按业务、发布、更新日志和历史记录分类；接续工作从当前交接进入。

[更新日志](docs/changelog/更新日志-2026-09-24至30.md) · [运行与维护](docs/运行与维护.md) · [历史索引](docs/history/README.md)

[产品范围](PRODUCT.md) · [领域模型](CONTEXT.md) · [设计约定](DESIGN.md) · [组件复用](docs/components.md) · [研发成本与授权](docs/business/研发受控成本调整-2026-09-14.md)

2026-10-03 W1–W8 本地验收通过，用户批准进入提交、推送及 PR 评审；当前分支 `codex/w8-app-static-entry`，实际交付状态以实时 Git 和 [#58 进展](https://github.com/gnedhy/honghao-ai-workbench/issues/58)为准。提交前补修研发权限变化时保留输入并刷新授权详情，最终完整门禁为 489 API／52 Node／17 模拟／95 真实场景（App 40），规范与需求两轴复核通过；正式尚未替换。最新证据与恢复准备见[整体交付清单](docs/history/records/W1-W8整体验收与交付准备-2026-10-03.md)，原 W8 的 39 场景为[阶段记录](docs/history/records/W8-App反馈与静态接入收敛-2026-10-03.md)，静态接入见[接入入口](docs/agents/workbench-integration.md)。
