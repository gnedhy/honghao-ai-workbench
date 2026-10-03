# 工作台关键回归地图

用于 #58 专项及后续工作台变更。先按实际变更选择下面用例，提交门禁仍以 `package.json` 和 [运行维护](../运行与维护.md)为准。2026-10-02 W1 的结果、G1、基线和审查见 [任务记录](../history/records/W1-基线与回归-2026-10-02.md)。本页维护入口与口径，不把历史结果当本次通过。

## 变更、消费者与测试

表中 `tests/` 用例在真实专用 PostgreSQL 中执行；`tests_ui/` 是 Node 逻辑检查，不能证明实际组件、数据库或权限。`check-sales-baseline.mjs` 使用模拟 API；`test_sales_recovery.py` 启动的 `check-sales-recovery.mjs` 联通真实测试 API 和 PostgreSQL。

W5 独立测算维护入口为 `salesCalculatorWorkspace.ts`（工作区／请求）、`salesCalculatorModel.ts`（默认和分档）、`SalesCalculatorPanel.tsx`（分档／命名提议及拖拽）和 `SalesCalculator.tsx`（组合）。`tests_ui/salesCalculatorModel.test.ts` 验证纯逻辑；`tests/test_sales_calculator_ui.py` 启动 `scripts/check-sales-calculator.mjs`，核对 8 个真实场景、HTTP 分级／本人隔离／PUT 冲突及业务表前后指纹。统一销售范围和完整门禁自动收集该文件，没有额外过滤模式；运行脚本必须由隔离 fixture 注入随机 API 与测试账号。

W6 原料公开只读入口为 `ProcurementMaterialView.tsx`，采购写入在 `ProcurementMaterialDrawer.tsx`；台账组合、查询和编辑分别在 `ProcurementMaterials.tsx`、`procurementMaterialQuery.ts`、`procurementEditSession.ts`，共同价格核对在 `procurementPriceEditing.tsx`。`tests/test_procurement_ui.py` 启动 `scripts/check-procurement.mjs`，核对 11 个真实消费者场景、旧批次明细及销售表指纹；完整／采购范围自动收集。运行必须由测试 fixture 注入随机 API 和账号。研发范围的原料变更须选采购范围或完整门禁，以覆盖采购及研发共用展示。

W7 研发维护入口为 `researchData.ts`（根读取）、`ResearchProductDrawer.tsx`（身份与详情）、`researchEditSession.ts`（填写、草稿、试算和写动作）、`ResearchFormulaEditor.tsx`（原编辑界面）及 `ResearchProductView.tsx`／`researchModel.ts`（原展示与类型）。`tests/test_research_ui.py` 启动 `scripts/check-research.mjs`，核对 18 个真实场景、冻结历史前缀和销售表指纹；完整／研发／采购范围自动收集。fixture 注入随机 API、合成账号，测试工作线程调用原事件处理验证采购→研发→销售；组合 Host 切页走共享退出契约，不宣称完整 App 覆盖。`W7_RED=1` 仅用于本机原组件复现，统一 verifier 清除该变量；正式门禁总是当前候选。

W8 的 `tests/test_app_ui.py` 通过 `scripts/check-app.mjs` 挂载实际 App 与登录 Root，覆盖静态注册、反馈全生命周期、身份、状态失败及上述四种真实编辑器的公共退出。隔离示例只由该测试 Vite 注入，不进入正式导航。导入检查与确认请求分别验证 busy；启用对话框使用合成待启用 overview，写请求在 API 前返回故障，不代表真实启用事务验证。同 ID 撤权场景仅刷新 currentUser props 并核对前端缓存入口隐藏，不作为服务端会话撤销或授权写入证明。Modal 覆盖下通过 DOM 触发现有 App 回调，只证明契约接线；原生关闭、Escape、刷新提示按实际浏览器操作检查。`W8_RED` 仅复现保存的原源码，JUnit 包装器拒绝该模式，统一 verifier 清除它。

| 变更／业务不变量 | 实际消费者与入口 | 复用用例／命令 |
| --- | --- | --- |
| 保存后才采用；部分采用只处理待采用项 | `SalesWorkbench` 编辑器、报价历史、看板；`salesModel` 与 `api/sales.py` | `tests_ui/salesModel.test.ts`；`tests/test_sales.py::test_partial_adoption_missing_cost_and_unadopted_edits`、`test_quote_products_can_be_added_and_pending_removed_without_deleting_adopted` |
| 调整、编码补录、作废保持冻结历史，成本不静默漂移 | 报价编辑器／详情，研发、采购正式成本读取；`SalesStore` | `test_frozen_snapshots_revision_void_code_and_copy`、`test_stale_cost_requires_explicit_choice_and_refresh`、`test_manual_price_reason_reconfirm_and_break_even` |
| Decimal、特殊公摊、零／缺价／回退；客户端不能伪造金额 | 报价参考／采用、产品选取；销售计算与成本目录 | `test_formulas_boundaries_precision_and_validation`、`test_server_ignores_forged_amounts_and_defaults_follow_basis`、`test_cost_fallback_and_zero_sources`、`tests_ui/salesModel.test.ts` |
| 个人记录、服务端分级权限、失效会话、版本冲突 | 销售／测算写接口和历史；前端按钮仅辅助 | `test_http_scope_owner_and_revoked_session`、`test_concurrent_adoption_same_revision_has_one_winner`、`test_http_and_store_authorization_and_mode` |
| 独立测算可手工成本／反推；不产生正式报价或成本写回 | `SalesCalculator`、`CalculatorStore`；测算历史 | `test_calculator_custom_steps_and_reverse_tiers`、`test_calculator_private_saved_workspace_and_source`；浏览器 smoke 的实际测算消费者检查。写入范围补查见下文 |
| 退出取消保留输入、忙碌阻止离开、监听清理 | `App` 调度、`interactionNavigation`、`Interaction`、`Drawer`；采购／研发／销售／测算编辑器 | `node --test tests_ui/interactionNavigation.test.ts`；`node scripts/check-sales-baseline.mjs --scenario smoke`；`--scenario exits`。Node 用例不是实际编辑器证据 |
| 三阶段保存中断保留输入、ID／版本；重试避免重复对象 | `SalesQuoteEditor` → `salesQuoteSession.saveQuote` → 创建／草稿／测算；HTTP 客户端及销售 API | `node scripts/check-sales-baseline.mjs --scenario interruptions`；`tests/test_sales_recovery.py` 的真实浏览器事务／响应丢失、幂等绑定、权限及版本检查 |
| 采用后加产品、部分采用续报、旧成本与调整版本 | 同一会话及真实工作台／历史详情；`salesModel.quoteDraftItems` | 实库脚本新增 5 组合场景：冻结输入及批量例外、部分采用保存、成本目录 4→12 后旧报价重开、dirty／重开／调整／编码补录／作废、未测算草稿重开直接保存采用；Node 检查冻结输入序列化及手填零价 |
| 采购跨页输入统一保存，失败不部分写入；启用前正式价不变 | 采购台账／更新页、公共台账控件；研发只读复用 | `tests_ui/procurementWorkflow.test.ts`、`procurementLedger.test.ts`、`procurementApi.test.ts`；`tests/test_procurement_bulk.py`、`tests/test_procurement_save_confirmation.py`；`tests/test_procurement_ui.py` 固定真实跨页／排序／失败重试／409 回归 |
| 研发试算、草稿和正式版本分离；成本链、锁定与恢复 | `ResearchFormulaEditor`／`researchEditSession`、`ResearchProductDrawer`／`researchData`／成本导出；采购价格与销售成本读取 | `tests/test_research_workbench.py` 中 `test_draft_persists_isolated_then_activation_updates_dependents`、`test_optimistic_draft_revision_prevents_overwrite_discard_and_old_activation`、`test_changed_source_invalidates_saved_simulation_without_losing_draft`；`tests/test_research_revision.py::test_saved_draft_can_be_resimulated_and_restored_after_own_product_is_deactivated`；`tests/test_research_ui.py` 实际 18 场景：重复保存、失败／冲突保留、token 过期、取消试算／保存、忙碌退出、身份、晚回包与只读导出及正式成本引用链 |
| 公开原料展示保持只读字段及范围；加载／失败不同于空结果 | `ProcurementMaterialView` → 采购排行、研发 `ResearchMaterialPrices`；采购台账和分流共用正文；资讯、销售、独立测算 | `tests/test_research_workbench.py::test_research_material_prices_show_only_formal_values_and_active_formula_scope`；`tests/test_procurement_ui.py` 真实组件 11 场景；`node scripts/check-workbench-loading.mjs` 共 7 模拟场景 |
| 客户端编号兼容普通 HTTP；模块关停保留历史；恢复完整 | 测算面板、销售持久化、模块配置与原生快照 | `node scripts/check-client-ids.mjs`；`test_restart_sales_modes_preserves_all_data`、`test_snapshot_restore_preserves_sales_tables`；恢复用例另需测试建库权限 |

以上未带完整路径的 `test_*` 均在 `tests/test_sales.py`，研发行已注明来源。W2 的实际 `App` 检查覆盖报价抽屉可达出口、刷新取消、导航取消及测算页面切换、监听卸载；抽屉打开时背景导航被原生 modal 阻断，程序触发实际 App 回调只证明契约接线。W3 当时未覆盖真实采购跨页；W6 已补组合 Host 中的跨页、409、旧 overview 和详情晚回包。仍未覆盖所有请求乱序或全部 App 功能出口，不能扩大已覆盖口径。

## 固定样本、角色与边界

- 浏览器样本在 `scripts/check-sales-baseline.mjs`：产品 `research:recipe:W1`／`W1-Q1`，最新成本 `4`、库存成本 `12`、版本 `w1-fixed-1`；客户／业务员均为“合成…甲”，普通国内直接厂，不使用原始业务数据。合成经理 `w1-manager`／销售等级 4 只是组件 props，不能作为身份认证或权限证明。
- 后端复用 `tests/test_sales.py` 的 `sales` fixture 和 `new/save/prepared/adopt` 入口：合成 `recipe:Q`、复配样本及每例新建临时附件目录。管理员用于准备；`test_http_scope_owner_and_revoked_session` 建立经理、另一经理、编辑、其他范围账号；测算用例另验证等级 2 只读试算与等级 3 保存门槛。密码是现有测试常量，不能用于业务服务。
- Node：运行 `node --test tests_ui/*.test.ts`。只用内存样本，无数据库连接。
- 浏览器：运行 `node scripts/check-sales-baseline.mjs --scenario smoke|exits|interruptions|all`（一次选一个值）。由脚本创建随机本机端口、独立 Vite 缓存；不加载根代理配置。所有 API 请求拦截，服务器侧 API 另返回 503，意外 API／外部请求导致检查失败。浏览器结束即销毁模拟数据；不启动后端、不使用附件目录、不访问正式服务。失败返回非零，不跳过已知风险。
- 实库浏览器：运行 `uv run python -m pytest tests/test_sales_recovery.py`，仍先完成下文测试库检查。复用 `sales` fixture 合成 `recipe:Q`（成本 4／12）及测试管理员，在同一测试进程的数据库锁和服务 lease 内启动随机 API 端口、临时附件目录及隔离 Vite。真实登录、API 和事务参与验证；前端代理未加载。脚本无默认后端地址，并校验健康接口环境为 `test`；不手工启动常驻测试库服务。输出只包含合成对象 ID、revision、请求阶段和计数。
- 后端：由受保护环境配置注入 `HONGHAO_TEST_DATABASE_URL`、`HONGHAO_TEST_MIGRATION_URL`，Windows 设置 `PYTHONUTF8=1`。只允许 `127.0.0.1/honghao_test` 的 `honghao_test_app`／`honghao_test_migration`。先核对库内 `test` 身份、服务锁未占用、没有其他服务连接；`tests/conftest.py` 每例重建 public，整个测试进程持独占测试锁。该库不能存业务或交互验收数据，不并发运行两套后端测试。
- 恢复：另注入 `HONGHAO_TEST_CLUSTER_URL`（本机维护库及现有 `honghao_cluster_admin`），并配置 PostgreSQL 18 原生工具。fixture 只创建生成名称的临时恢复库。没有权限时记录阻塞，不创建管理员或改权限。
- 交互开发另用 `development` 库／独立附件目录；不拿自动重建的 `honghao_test` 启动交互服务。配置方法见运行维护。锁文件安装，不升级依赖。

最小实库入口（先完成上面检查）：

```powershell
uv run python -m pytest tests/test_sales.py
```

统一入口选择一个范围：

```powershell
npm run verify
npm run verify -- --scope sales
npm run verify -- --scope procurement
npm run verify -- --scope research
npm run verify -- --scope frontend
```

| 范围 | API 文件范围 | 适用边界 |
| --- | --- | --- |
| all（默认） | 全部 `tests/` | 提交前完整门禁，不按改动缩减 |
| sales | `test_sales*.py`（含真实浏览器恢复） | 销售／测算局部变更 |
| procurement | `test_procurement*.py`、`test_research*.py`、`test_sales*.py` | 采购成本改变会影响研发和销售 |
| research | `test_research*.py`、`test_procurement_rd5.py`、`test_sales*.py` | 研发成本、只读原料及下游销售 |
| frontend | 无实库执行 | 无测试库时可做的前端检查、CI 前端 job；不构成完整通过 |

每个范围都执行完整用例收集及现有数量底线、`check:frontend`、全部 Node 逻辑和 17 个模拟浏览器场景、类型／隔离构建及安全扫描。构建位于 `.scratch/verify/<scope>/dist`，实库结果位于同目录 `api-results.xml`。业务写入、权限、公共类型及跨模块变更仍以完整门禁收尾；范围检查只加快开发反馈。未知范围、依赖／浏览器缺失、检查错误、测试库身份错误均非零退出，无跳过后算通过。

Node 24、Python 3.12、uv、PostgreSQL 18 及 Chromium 按 README 锁文件准备。`npm run check:frontend` 使用 Oxlint 4 条基础 React 规则及本地模块 AST 图；10 条保留的既有 Hook 诊断按具体 Hook 哈希（W4 修复 1 条、W6 台账修复 6 条、W7 研发修复 4 条、W8 修复 2 条）而非总数容忍，新增／编辑／过期项均失败。PriceMovers 与采购分页 Hook 同哈希、同缺失依赖集合仅校正诊断排列。临时例外、维护角色及退出条件在 [历史基线](../../scripts/react-lint-baseline.json)及 [依赖清单](../../scripts/frontend-boundaries.json)，不能自动扩表或用内联禁用规避；处理旧项需复验实际消费者。公共控件的请求／权限／金额逻辑仍由业务层承担，自动图不代替动态反射、别名调用及业务语义审查。文件长度、Hook 数只作审查提示，不作硬门槛。

[CI 候选](../../.github/workflows/frontend-checks.yml)仅以同一 `--scope frontend` 命令运行前端 job，无生产凭据，不声明已运行 Linux 或已成为强制门禁。完整实库／恢复检查在本机现有隔离环境执行；远端工作流生效需另行推送，分支保护及必须检查须管理员授权。当前执行证据与 G3 状态见 [W3 记录](../history/records/W3-统一自动检查与影响范围验证-2026-10-02.md)。人工复核仍承担业务口径、原生模态不可达出口及自动检查未覆盖部分。

## 故障注入与剩余联通检查

| 场景 | 当前可执行入口／采集 | 限制或后续归属 |
| --- | --- | --- |
| 创建成功、草稿失败 | Mock interruptions 与实库 `draft-failed`；草稿写前返回 500，采集真实创建及重试 | 真实批次／事件计数与版本由 Python SQL 复核 |
| 草稿成功、测算失败 | 实库 `calculate-failed`；另检查已有批次中断后回退输入不能开放采用 | 不提前建立完整保存指纹，重试沿用成功草稿版本 |
| 提交成功、响应丢失 | 实库 `create-response-lost`、`draft-response-lost`、`calculate-response-lost` 在真实 API 返回 200 后丢弃响应 | 原请求幂等重放；同内容恢复为一个批次、一次测算，不增加事件；故障后改输入另保存新版本 |
| 保存中离开 | Mock unified-busy-exit；实库创建门闩检查统一退出 false、Esc 保留抽屉、关闭按钮禁用、beforeunload 拦截 | 刷新由浏览器提示，用户仍可主动确认离开；恢复不跨卸载 |
| 取消、关闭 | 实际 App 抽屉取消／关闭／Esc／遮罩及刷新取消保留输入；测算页实际切换取消／放弃和监听清理 | 抽屉后台导航不可达；程序点击实际 App 回调验证报价历史／返回主页接线，不称为人工出口 |
| 重复点击、保存中改输入 | 实库同一事件周期两次 DOM click 仅一次创建；编辑区原生 inert | 检查真实请求数、保存后版本及输入保留；不强制改写 inert 内的 DOM 值 |
| 失效会话、已有版本冲突 | 后端权限／并发用例；实库浏览器注销实际会话后重试 401，另一个写入制造已有批次 409 | 保留当前输入，不自动创建或覆盖；检查实际数据版本不变 |
| 测算不写正式报价或成本 | `test_calculator_private_saved_workspace_and_source` 与 `test_sales_calculator_ui.py` 比较除 `sales_calculator_saved` 外全部 sales／procurement／research 表前后指纹 | 真实组件联通验证手工／产品／快照、私有方案／模板及退出；等级 2 仅可 evaluate，保存仍 ≥3，PUT 冲突为既有 HTTP 路径。当前结果见 [W5 记录](../history/records/W5-独立测算工作区模块化-2026-10-03.md) |

## W2／W3 文件协调与启动

W4 在用户继续授权后承接已通过的 W2／W3，仍由主修改线协调编辑器、模型及实库脚本。当前实现与结果见 [W4 记录](../history/records/W4-客户报价编辑会话模块化-2026-10-02.md)。真实联通现为原 13 加 5，共 18 场景；编码补录通过既有 API 准备，随后实际详情验证作废，不声明 UI 补录覆盖。`W4_QUOTE_ONLY=1` 仅定位五个本地场景，统一 verifier 清除此变量，JUnit 门禁拒绝过滤模式；包装器核对 18／5 个唯一场景。质量基线因完整修复一个 effect 由 23 减至 22，其余记录不变。下面为 W2／W3 当时的分工。

G1 证据登记在 W1 任务记录及 #59 评论，不能仅以本文存在判断达成。用户已依次批准 W2 与 W3；保存恢复结果见 [W2 记录](../history/records/W2-销售退出与保存恢复-2026-10-02.md)，统一检查结果与 G3 见 [W3 记录](../history/records/W3-统一自动检查与影响范围验证-2026-10-02.md)：

- #60 负责 `SalesWorkbench.tsx`、`Interaction.tsx`、`interactionNavigation.ts` 及保存／退出业务回归；接手本次 `check-sales-baseline.mjs` 的业务断言。API 改动若需要扩大契约或迁移，先另行审查。
- #61 负责 `package.json`、现有加载脚本、检查命令及依赖边界；直接复用 #60 的销售回归。需要改同一浏览器脚本时先交接该文件，W2 主修改线完成后再接线，不并发编辑。
- #59 完整关闭、#60/#61 启动、源码推送及生产发布是不同状态。G1 不自动开始后续任务，也不改变仓库设置、总经办状态或正式配置。
