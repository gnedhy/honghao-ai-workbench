# H05 后续 Issue 核对与调整

2026-10-15，按用户要求核对H05迭代中提前实现的能力与后续任务，避免重复建设。本文件维护接续差异和复用索引，具体业务规则以功能合同为准，任务正文以GitHub对应Issue为准。旧文件名保留，避免现有引用失效。

## 状态与证据边界

现场核对：任务分支 `codex/h05-project-task-ui` 的HEAD为 `c0679d092cc57aeaf77886d39228b0004f430e98`，其后大量产品改动尚未提交。PR #94仍指向该旧提交，frontend通过、full失败；功能集成分支为 `4bd8d5ba6dcdeeb7b7c71416672dc51d2e0c2fc8`，main为 `25f030e0a9463d982517508385a64c6d6767b4da`。此处是2026-10-15核对快照，不固定后续分支状态。

“已有”指代码存在且有对应本地／隔离定向证据，不等于已提交、CI通过、集成或正式启用。后续先承接通过最终门禁并集成的精确提交，再实现剩余能力；不能从旧PR取源码后重做当前未提交候选。H05关闭仍需最终门禁、提交与PR集成；H12/H13保留整体候选、main与正式发布职责。

本次读取#72、#77—#88的正文和全部评论，核对代码／迁移／测试入口及既有真实验收记录，更新现有13条Issue正文；不创建、关闭、改名、改标签或解除依赖。原生依赖与正文说明保持；候选已有不构成解除前置的集成事实。

## 已提前实现的复用入口

| 能力 | 代码与消费者 | 接续约束 |
| --- | --- | --- |
| 本人项目、会话、连续任务与逐轮人工验收 | `api/database.py`、`src/chat/`、`src/tasks/`、`tests/test_task_acceptance.py` | 复用owner／taskId／runId、冻结项目、接受回执、验收版本及归档／删除生命周期，不再建任务平台 |
| 个人／项目AGENTS.md | `api/personalization.py`、`native_instruction_file`、`src/personalization/Personalization.tsx`、SettingsDialog／ProjectDrawer | 不可变md文件、revision／SHA256、下一轮生效、项目整体替代、聊天不加载；原生发现，不重复代理注入 |
| 按账号原生个人记忆 | `PersonalizationStore.native_directory/memories`、`CodexRuntime.reset_memory/_native_background`、原生SQLite／Markdown | 原生生成／汇总／使用，开关、只读查看及全部清除；不新增自建提炼、逐条编辑删除、项目记忆或工具记忆 |
| 管理员模型、凭据、预算与请求用量 | `api/ai_control.py`、`AIConfigSettings.tsx`、`src/chat/ModelSelection.tsx`、core16 | 统一受控代理、逐请求预算、费用快照／待核算、后台计费；不再造个人Key、费用口径或配置中心 |
| 运行排队与出站请求限流 | `CodexRuntime.start/_dispatch/_request_slot/stop`、core17、`tests/test_ai_queue.py` | 多人公平、同用户串行、取消／重启／出队鉴权；不等于周期触发或子Agent并行 |
| 原生上下文恢复、压缩及备份 | `api/codex_runtime.py`、`api/operations.py` | 固定0.160.0、resume拒绝后产品历史重建、原生压缩与状态事件、原生路径重定位；不另写压缩／内核恢复器 |
| 菜单、Markdown、空／错误状态与离开保护 | `WorkbenchOptionMenu`、`Drawer`、`MessageBody`、`EmptyState`、`useUnsavedChanges` | 后续文件、工具、技能、分享复用同一组件及业务草稿归属，不重新设计平行控件 |

管理员AI配置是用户已授权的提前扩展，在#72总跟踪中单列；不重编H08，不因验收目录名 `.scratch/h08*` 将其视为#80“业务只读查询”。个性化属于H07已实现部分，不能因此把原H07全部完成或关闭。

## 逐项调整与剩余范围

| Issue | 已有／应复用 | 仍需做及本次补充 |
| --- | --- | --- |
| [#72 H00 总跟踪](https://github.com/gnedhy/honghao-ai-workbench/issues/72) | H01—H04已集成，H05及提前扩展有候选 | 分开记录H05、H07已做部分和管理员AI配置；纠正旧CI正在运行描述，保留H06/H08/H10等未完成 |
| [#77 H05](https://github.com/gnedhy/honghao-ai-workbench/issues/77) | 当前聊天默认模式、项目／连续任务、三视图／五阶段、验收／归档、稳定性修复 | 用最终合同替代旧默认工作、单表看板等过程描述；冻结范围、审查、完整门禁、提交与PR #94集成 |
| [#78 H06 文件与成果](https://github.com/gnedhy/honghao-ai-workbench/issues/78) | 本人对象、运行、人工验收、草稿／忙碌保护、费用／队列与恢复 | 选定文件／文件夹上传、只读原件、工作副本、不可变成果版本及实际下载仍未做；Word/Excel结构内容、部分失败／重试／删除与恢复组合验收 |
| [#79 H07 项目规则与技能](https://github.com/gnedhy/honghao-ai-workbench/issues/79) | 个人／项目规则编辑、版本冻结、原生发现、个人原生记忆已有 | 规则导入导出、版本历史界面、SKILL包／模板／选择／自动匹配／实际调用仍未做；当前自动发现技能全部禁用，不重做规则与记忆 |
| [#80 H08 业务只读查询](https://github.com/gnedhy/honghao-ai-workbench/issues/80) | 采购／研发／销售GET逻辑、运行事件／侧栏、受控代理和预算／队列 | AI可调用业务工具、逐次身份／部门／参数鉴权、来源／时间／版本和写入负例仍未做；人工页面验收不能代替AI工具验收 |
| [#81 H09 本地目录](https://github.com/gnedhy/honghao-ai-workbench/issues/81) | 以后复用H06资料／成果版本与下载 | 仍暂缓，无持久浏览器目录句柄；原生服务器home/cwd不是员工目录授权，不列入当前H12/H13前置 |
| [#82 H10 分享](https://github.com/gnedhy/honghao-ai-workbench/issues/82) | owner鉴权、runId、验收与H06成果版本 | 指定账号授权、固定成果版本、撤销／停用／猜测ID等仍未做；验收通过不自动授权分享，下载不重新调用模型 |
| [#83 H11 内核升级回退](https://github.com/gnedhy/honghao-ai-workbench/issues/83) | 二进制校验、固定配置、原生resume／压缩／记忆、费用和队列 | 候选内核兼容、空闲切换、真实失败回退仍未做；补原生state／记忆／指令／技能／账本／排队冻结版本兼容，不把关于系统版本行当升级功能 |
| [#84 H12 整体验收](https://github.com/gnedhy/honghao-ai-workbench/issues/84) | 已有阶段与真实模型／业务页面证据 | 最终组合矩阵加入指令／记忆、预算／队列、后续文件／工具／分享；core17迁移／新安装／恢复和真实目标身份／容量，旧通过数不外推 |
| [#85 H13 主线与试点](https://github.com/gnedhy/honghao-ai-workbench/issues/85) | 现有管理员／个性化界面、备份恢复和试点操作入口 | 最新main差异、最终CI、真实部署、四项启用审查分开；Flash／Pro关闭／执行1、预算未设置及预估软截止说明，不能复制合成数据 |
| [#86 F01 自动调度](https://github.com/gnedhy/honghao-ai-workbench/issues/86) | 持久队列、公平性、停止、预算与请求限流已有 | 时间规则／时区、触发幂等、暂停／恢复及无人值守授权未做；触发后进已有队列，不另建worker／历史／计费系统 |
| [#87 F02 多Agent](https://github.com/gnedhy/honghao-ai-workbench/issues/87) | 企业执行名额、出站请求、账本与取消已有 | 父子关系／权限继承／取消树／真实协作协议／写冲突仍未做；multi_agent=false，2／4名额不是子Agent能力，agents.max_threads不是企业上限 |
| [#88 F03 插件](https://github.com/gnedhy/honghao-ai-workbench/issues/88) | 账号原生隔离、管理员密钥／预算、H07未来技能接口 | 插件／MCP发布分发、凭据委托、安装升级卸载和实际调用未做；plugins/apps=false，不继承桌面宿主账号或权限，不新增空入口 |

## 不可误判为完成的现成代码

- 知识库PDF上传有自身来源校验、哈希、隔离与模块权限；不是个人项目文件批次。复用校验思路前核对owner与范围，不能直接移用知识库对象权限。
- 研发Excel导出、采购报表导入属于业务工作台；不能代替AI任意Word/Excel成果生成与H06生命周期。
- 当前前台工具被代理移除／拒绝；记忆后台只允许本人记忆根的受限文件工具，不代表用户工具、技能、业务查询或联网已开放。
- 原生记忆“六小时”是原生筛选／冷却条件，已有真实验证老化了合成时间戳；不证明自然等待六小时，也不是F01周期任务。
- 采购定时启价／资讯抓取、研发核算、队列 `_schedule` 与遗留工作流元数据不是用户配置的AI自动任务。宿主自身Skill和H01技术探针也不等于产品技能／插件。

## 验证、依赖与交付

核对源码／迁移及测试断言，不在本次文档审计重跑真实模型或完整门禁。对应入口包括 `tests/test_personalization.py`、`tests/test_personalization_runtime.py`、`tests/test_ai_control.py`、`tests/test_ai_queue.py`、`tests/test_task_acceptance.py`。新阶段只补新增能力与必要组合验证，不以去重为由删旧保护样本或降低预算。

H07规则／记忆可独立于H06工作，不因阶段顺序重做；H06只约束它实际依赖的技能包／文件导入部分。Issue原生依赖不在本次提前解除，待相应前置集成后按事实处理。H09与F01/F02/F03维持暂缓／评估；不新增“为收尾必须做完后续全部功能”的前置。

完整门禁、业务／安全／代码／回退审查、最终提交、CI及集成仍pending；本轮只改Issue与一致性文档，不修改产品、运行配置、业务数据、规则或个人机器记忆，不清场。源文件与Issue正文副本、逐项回读收据保存在仓库外验收目录 `issue-audit-20261015`，接续从本文件和当前交接进入。

## 新 Issue 草案：受控联网搜索与来源引用（后续评估）

**Parent**：#72。**状态**：needs-triage，非 ready-for-agent。**前置**：工具接入方式、搜索服务及权限／预算经详细设计确认；不阻塞 H05/H06/H12 的已确认范围。

**问题与目标**：文本聊天当前无法获取实时网络信息。模型 API 的内置搜索不等于产品已具备搜索执行能力；评估复用既有受控工具入口和外部搜索服务，将结果、时间及来源链接交给模型。

**验收草案**：实际搜索及可核对引用；没有结果、超时、来源不可读和服务不可用如实显示；逐次鉴权、停止、请求预算；防止网页内容被当成用户指令；不抓取内部地址或泄露密钥／业务资料；重试不重复不可确认的操作。先明确聊天与工作各自入口，不换内核或自动安装额外框架。

**本轮动作**：仅保存草案，未新增 GitHub Issue，也未接入搜索。
