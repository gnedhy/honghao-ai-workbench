# 持续质量保障

本页维护新增模块与功能扩展的自动验收入口。本次范围为完整 CI 与主线必需检查、回归资产保护、扩展接入一致性；性能预算及上线后监测留待后续工作，不宣称已完成。业务约定沿用 [开发流程](skill-workflow.md)、[静态接入](workbench-integration.md)和[回归地图](workbench-regression.md)。

## 开发、集成与合并

开发时使用 `npm run verify -- --scope sales` 等定向范围；业务、权限、公共类型或跨模块改动以 `npm run verify` 完整验收收尾。只修改文档或日志字面内容时按项目规则做相应检查，远端 PR 检查仍执行。所有范围先检查完整测试收集、回归清单和接入契约，再检查前端质量、Node、模拟浏览器、类型/构建及安全；完整范围再运行专用 PostgreSQL、实库浏览器和恢复检查。

比较基线默认 `origin/main`，先 `git fetch origin`；显式基线使用 `npm run verify -- --base-ref <commit>`。CI 使用 PR 的 base SHA 或 push 的 before SHA，checkout 保留历史。不存在的基线直接失败，不省略比较。已合并本地工作树与当前主线一致时，仍检查清单和接入一致性；开发分支及未提交产品变更另检查当前变更声明。

[工作流](../../.github/workflows/frontend-checks.yml)在 PR、main push 和手动触发时执行 `frontend` 快速范围和 `full` 完整范围。full 使用 GitHub-hosted 临时 PostgreSQL 18、匹配版本原生工具、受限应用账号、迁移账号和仅测试建库的恢复账号；不引用本机或生产凭据。失败不能跳过、重试后吞掉或记为通过。报告只保留去掉参数值和错误正文的合成用例 JUnit；数据库、附件、凭据和原始业务内容不上传。

主线目标规则为必须通过 `frontend`、`full`，合并前保持主线最新；管理员同样受约束，禁止强制推送和删除主线，变更通过 PR。单维护者仓库不要求不可自行完成的第二人批准；业务语义和安全审查仍需对应责任人完成，自动检查不代替业务批准。仓库规则以 GitHub 实际配置为准，生效与运行证据记入交接。

## 回归资产保护

[数量门禁](../../api/test_count_gate.py)和[回归清单](../../scripts/regression-contract.json)同时保护用例数量与原有 nodeid；新增用例不能掩盖关键用例删除。[前端资产门禁](../../scripts/check-regression-assets.mjs)按 AST 检查具名 Node 与浏览器场景，注释中的名称不算测试。动态场景按门禁支持的静态循环展开及现有实跑包装断言核对，不把名称检查称为断言语义或行为覆盖证明。

首次引入只允许固定提交 `1c57482eb41f48f5acd6fcd36395d38e84086948` 的旧底线升级；其他比较基线缺少清单一律失败。以后不允许降低数量底线或静默删除保护项。测试合并、重命名或退役必须登记原 ID、明确原因和仍被收集/执行的替代项，并在 PR 中复核业务断言；清单和测试一起审查。新增关键场景由维护者审核后登记，不由通过一次测试自动扩大例外。

历史 Hook 例外仍按具体锚点和退出条件管理，不扩大全局豁免。门禁自身的负例必须证明缺少关键场景、凑数量、注册不一致及缺变更声明会失败；只验证正常通过不能证明门禁有效。

统一验收清除 `PYTEST_ADDOPTS` 并覆盖根 `addopts`，避免本地选择条件缩减执行范围。[执行收据](../../scripts/check-api-execution.py)将 JUnit 中实际完成的每个用例与本次收集、选定范围逐项比对，漏跑、重复、失败以及运行时 skip/xfail 都不能通过。

## 工作台接入一致性

[接入清单](../../scripts/workbench-contracts.json)只描述已有静态接入和验证，不作为运行时注册平台，不批准任何模块启用。[检查入口](../../scripts/check-workbench-contracts.mjs)比对前端工作台类型、静态元数据、设置名称、lazy import、slot 适配与导航，以及服务端工作台 ID、授权 scope。已实现模块必须有页面类型/名称、责任角色、数据/权限/生命周期/退出/兼容/恢复边界、实际消费者和实库浏览器验证。总经办保持未实现占位。

新增模块先更新原接入位置，再补对应契约。`apiPatterns` 声明该模块定向验收的 API 文件范围及受影响下游，登记的 API 与实际浏览器包装必须都在该范围内；新模块 ID 可作为统一 verifier 的 scope，未知或空范围失败。默认完整门禁仍执行全部 tests，范围检查不替代完整验收。

## 每次产品变更声明

修改前端产品 TS/TSX/CSS 或后端业务 Python/SQL 时，在 `docs/changes/<事项>.json` 添加或更新本次声明，覆盖比较基线以来的全部产品文件。普通治理脚本、门禁代码及 Markdown 修改不要求虚构业务变更。旧声明未在本次 diff 中变化，不能冒充本次验收。

声明字段为 `schema: 1`、`kind`（`presentation` 或 `business`）、`summary`、`modules`、`files`、`consumers`、`permissions`、`data`、`lifecycle`、`exits`、`compatibility`、`recovery`、`verification`。无变化的边界写具体“沿用哪项约定”，不留空或用待定占位。数据字段说明对象、版本、写入及是否迁移；兼容字段说明旧记录、请求和部署先后关系。

`verification` 包含 `api` nodeid 列表、`node` 和 `browser` 的 `{file, id}` 列表。业务变更必须包含 API 和实际浏览器项；浏览器项另填 `apiTest`，关联被完整门禁执行的 pytest 包装，且该包装进入本次 `verification.api`。Node 项必须位于统一收集的 `tests_ui/*.test.ts`。展示变更至少列出一项对应的已收集验证。

例如销售测算业务声明可引用 `tests/test_sales_calculator_ui.py::test_browser_sales_calculator`，并用 `{ "file": "scripts/check-sales-calculator.mjs", "id": "save-slow-keeps-newer-input-and-busy-exit", "apiTest": "tests/test_sales_calculator_ui.py::test_browser_sales_calculator" }` 指向实跑场景。填写本次真实涉及的文件和场景，不照抄不相关的示例。

自动检查能证明条目齐全、注册一致、引用有效及选定用例已执行；是否正确分类、测试是否对应新需求、权限和金额是否符合业务，仍由需求与规范审查判断。不能用一份写满字段的声明代替新增业务断言，也不能修改工作流或清单掩盖检查失败。
