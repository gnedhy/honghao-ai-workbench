# 工作台关键回归地图

用于 #58 专项及后续工作台变更。先按实际变更选择下面用例，提交门禁仍以 `package.json` 和 [运行维护](../运行与维护.md)为准。2026-10-02 W1 的结果、G1、基线和审查见 [任务记录](../history/records/W1-基线与回归-2026-10-02.md)。本页维护入口与口径，不把历史结果当本次通过。

## 变更、消费者与测试

表中 `tests/` 用例在真实专用 PostgreSQL 中执行；`tests_ui/` 是 Node 逻辑检查，不能证明实际组件、数据库或权限。浏览器脚本的请求全部模拟。

| 变更／业务不变量 | 实际消费者与入口 | 复用用例／命令 |
| --- | --- | --- |
| 保存后才采用；部分采用只处理待采用项 | `SalesWorkbench` 编辑器、报价历史、看板；`salesModel` 与 `api/sales.py` | `tests_ui/salesModel.test.ts`；`tests/test_sales.py::test_partial_adoption_missing_cost_and_unadopted_edits`、`test_quote_products_can_be_added_and_pending_removed_without_deleting_adopted` |
| 调整、编码补录、作废保持冻结历史，成本不静默漂移 | 报价编辑器／详情，研发、采购正式成本读取；`SalesStore` | `test_frozen_snapshots_revision_void_code_and_copy`、`test_stale_cost_requires_explicit_choice_and_refresh`、`test_manual_price_reason_reconfirm_and_break_even` |
| Decimal、特殊公摊、零／缺价／回退；客户端不能伪造金额 | 报价参考／采用、产品选取；销售计算与成本目录 | `test_formulas_boundaries_precision_and_validation`、`test_server_ignores_forged_amounts_and_defaults_follow_basis`、`test_cost_fallback_and_zero_sources`、`tests_ui/salesModel.test.ts` |
| 个人记录、服务端分级权限、失效会话、版本冲突 | 销售／测算写接口和历史；前端按钮仅辅助 | `test_http_scope_owner_and_revoked_session`、`test_concurrent_adoption_same_revision_has_one_winner`、`test_http_and_store_authorization_and_mode` |
| 独立测算可手工成本／反推；不产生正式报价或成本写回 | `SalesCalculator`、`CalculatorStore`；测算历史 | `test_calculator_custom_steps_and_reverse_tiers`、`test_calculator_private_saved_workspace_and_source`；浏览器 smoke 的实际测算消费者检查。写入范围补查见下文 |
| 退出取消保留输入、忙碌阻止离开、监听清理 | `App` 调度、`interactionNavigation`、`Interaction`、`Drawer`；采购／研发／销售／测算编辑器 | `node --test tests_ui/interactionNavigation.test.ts`；`node scripts/check-sales-baseline.mjs --scenario smoke`；`--scenario exits`。Node 用例不是实际编辑器证据 |
| 三阶段保存中断保留输入、ID／版本；重试避免重复对象 | `QuoteEditorDrawer.save` → 创建 → 保存草稿 → 测算；HTTP 客户端及销售 API | `node scripts/check-sales-baseline.mjs --scenario interruptions`；真实事务／响应丢失联通验证由 #60 补充 |
| 采购跨页输入统一保存，失败不部分写入；启用前正式价不变 | 采购台账／更新页、公共台账控件；研发只读复用 | `tests_ui/procurementWorkflow.test.ts`、`procurementLedger.test.ts`、`procurementApi.test.ts`；`tests/test_procurement_bulk.py`、`tests/test_procurement_save_confirmation.py`。实际跨页浏览器操作尚缺固定回归 |
| 研发试算、草稿和正式版本分离；成本链、锁定与恢复 | `ResearchWorkbench` 编辑器／成本导出；采购价格读取、销售成本读取 | `tests/test_research_workbench.py` 中 `test_draft_persists_isolated_then_activation_updates_dependents`、`test_optimistic_draft_revision_prevents_overwrite_discard_and_old_activation`、`test_changed_source_invalidates_saved_simulation_without_losing_draft`；`tests/test_research_revision.py::test_saved_draft_can_be_resimulated_and_restored_after_own_product_is_deactivated` |
| 公开原料展示保持只读字段及范围；加载／失败不同于空结果 | 采购 `MaterialDrawer`／`ledgerCell` → 研发 `ResearchMaterialPrices`；资讯、分流 | `test_research_material_prices_show_only_formal_values_and_active_formula_scope`；`node scripts/check-workbench-loading.mjs`，涵盖采购、研发、资讯、分流及研发走势；销售／测算加载失败待 #61 补入 |
| 客户端编号兼容普通 HTTP；模块关停保留历史；恢复完整 | 测算面板、销售持久化、模块配置与原生快照 | `node scripts/check-client-ids.mjs`；`test_restart_sales_modes_preserves_all_data`、`test_snapshot_restore_preserves_sales_tables`；恢复用例另需测试建库权限 |

以上未带完整路径的 `test_*` 均在 `tests/test_sales.py`，研发行已注明来源。当前没有真实销售 Shell 全出口、请求乱序、组件卸载清理、实际跨页采购浏览器自动化，不能将逻辑／模拟用例当这些检查已覆盖。

## 固定样本、角色与边界

- 浏览器样本在 `scripts/check-sales-baseline.mjs`：产品 `research:recipe:W1`／`W1-Q1`，最新成本 `4`、库存成本 `12`、版本 `w1-fixed-1`；客户／业务员均为“合成…甲”，普通国内直接厂，不使用原始业务数据。合成经理 `w1-manager`／销售等级 4 只是组件 props，不能作为身份认证或权限证明。
- 后端复用 `tests/test_sales.py` 的 `sales` fixture 和 `new/save/prepared/adopt` 入口：合成 `recipe:Q`、复配样本及每例新建临时附件目录。管理员用于准备；`test_http_scope_owner_and_revoked_session` 建立经理、另一经理、编辑、其他范围账号；测算用例另验证等级 2 只读试算与等级 3 保存门槛。密码是现有测试常量，不能用于业务服务。
- Node：运行 `node --test tests_ui/*.test.ts`。只用内存样本，无数据库连接。
- 浏览器：运行 `node scripts/check-sales-baseline.mjs --scenario smoke|exits|interruptions|all`（一次选一个值）。由脚本创建随机本机端口、独立 Vite 缓存；不加载根代理配置。所有 API 请求拦截，服务器侧 API 另返回 503，意外 API／外部请求导致检查失败。浏览器结束即销毁模拟数据；不启动后端、不使用附件目录、不访问正式服务。失败返回非零，不跳过已知风险。
- 后端：由受保护环境配置注入 `HONGHAO_TEST_DATABASE_URL`、`HONGHAO_TEST_MIGRATION_URL`，Windows 设置 `PYTHONUTF8=1`。只允许 `127.0.0.1/honghao_test` 的 `honghao_test_app`／`honghao_test_migration`。先核对库内 `test` 身份、服务锁未占用、没有其他服务连接；`tests/conftest.py` 每例重建 public，整个测试进程持独占测试锁。该库不能存业务或交互验收数据，不并发运行两套后端测试。
- 恢复：另注入 `HONGHAO_TEST_CLUSTER_URL`（本机维护库及现有 `honghao_cluster_admin`），并配置 PostgreSQL 18 原生工具。fixture 只创建生成名称的临时恢复库。没有权限时记录阻塞，不创建管理员或改权限。
- 交互开发另用 `development` 库／独立附件目录；不拿自动重建的 `honghao_test` 启动交互服务。配置方法见运行维护。锁文件安装，不升级依赖。

最小实库入口（先完成上面检查）：

```powershell
uv run python -m pytest tests/test_sales.py
```

扩大到采购／研发时添加地图中的对应文件；最终仍执行完整现行门禁。构建输出必须隔离，W1 使用 `npm run build -- --outDir .scratch/w1-20261002/dist`，与原 `build` 相同地执行类型和 Vite 构建；其他 verify 项保持原命令。

## 故障注入与剩余联通检查

| 场景 | 当前可执行入口／采集 | 限制或后续归属 |
| --- | --- | --- |
| 创建成功、草稿失败 | interruptions 的 `draft-failed`：500 在草稿写入前；采集批次 ID、版本、写请求及重试数 | 模拟服务端状态，#60 需真实库联通验证 |
| 草稿成功、测算失败 | `calculate-failed`：草稿保存后测算 500 | 同上；核对草稿版本与下一次重试 |
| 提交成功、响应丢失 | `create-response-lost`、`calculate-response-lost`：先改变模拟状态再 `route.abort` | 明确为模拟提交；#60 另验证真实服务端提交后的断网与状态对账，补草稿响应丢失 |
| 保存中离开 | exits 的 `unified-busy-exit`：阻塞创建响应，调用实际统一调度 | 挂载真实编辑器，但不是完整 App 的用户可达出口遍历 |
| 取消、关闭 | smoke 实际抽屉关闭后“继续编辑”、实际测算统一调度后取消 | 继续遍历取消按钮、Esc、背景、返回／切换及刷新；卸载清理、重复确认由 #60 补 |
| 重复点击、保存中改输入 | #60 在同一注入门闩内重复点击／改字段，记录快照、请求数与恢复输入 | W1 未执行；不把 busy 调度等同于此覆盖 |
| 失效会话、已有版本冲突 | 已有真实 `test_http_scope_owner_and_revoked_session` 及版本／并发用例；#60 对实际编辑器注入 401／409 | 后端权限已覆盖，浏览器恢复行为未覆盖 |
| 测算不写正式报价或成本 | smoke 只允许测算请求；`test_calculator_private_saved_workspace_and_source` 比较除 `sales_calculator_saved` 外全部 sales／procurement／research 表的前后指纹 | 实库用例验证产品／手工成本测算与私有工作区／模板保存；完整浏览器 API 联通仍待 #60/#61，不能以模拟计数证明数据库无写入 |

## W2／W3 文件协调与启动

G1 证据登记在任务记录及 #59 评论，不能仅以本文存在判断达成。此次只有 W1 执行线，W2/W3 尚未开始：

- #60 负责 `SalesWorkbench.tsx`、`Interaction.tsx`、`interactionNavigation.ts` 及保存／退出业务回归；接手本次 `check-sales-baseline.mjs` 的业务断言。API 改动若需要扩大契约或迁移，先另行审查。
- #61 负责 `package.json`、现有加载脚本、检查命令及依赖边界；直接复用 #60 的销售回归。需要改同一浏览器脚本时先交接该文件，W2 主修改线完成后再接线，不并发编辑。
- #59 完整关闭、#60/#61 启动、源码推送及生产发布是不同状态。G1 不自动开始后续任务，也不改变仓库设置、总经办状态或正式配置。
