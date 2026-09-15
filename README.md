# 宏昊 AI 工作台

面向企业日常业务的本地工作台，当前聚焦采购价格管理与研发产品成本。

2026 年 9 月 15 日已完成 PostgreSQL 正式切换，原账号与业务数据保留。[发布与恢复记录](docs/releases/正式发布-2026-09-15.md) · [当前交接](docs/当前交接.md)。

## 已实现

| 工作台 | 主要能力 |
| --- | --- |
| 采购 | 原料价格与库存台账、共同录价、核对启用、部门分流、价格历史 |
| 研发 | 双成本核算、配方与投料编辑、草稿试算、受控手动调整、引用链成本更新 |
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

`verify` 包含测试、类型检查、构建与安全扫描；接口测试要求独立 PostgreSQL 测试库，不能指向业务数据库。隔离构建和单入口启动见 [运行与维护](docs/运行与维护.md#构建后的单入口运行)。

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

[更新日志](docs/changelog/更新日志-2026-09-15.md) · [运行与维护](docs/运行与维护.md) · [历史索引](docs/history/README.md)

[产品范围](PRODUCT.md) · [领域模型](CONTEXT.md) · [设计约定](DESIGN.md) · [组件复用](docs/components.md) · [研发成本与授权](docs/business/研发受控成本调整-2026-09-14.md)
