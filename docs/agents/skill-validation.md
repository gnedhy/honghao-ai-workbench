# Skill 验证与模型升级复验

本页记录已安装 Skill 的限定场景验证，不是安装指南。使用约定见 [Skill 协作约定](skill-workflow.md)。本轮没有重新安装 Skill；直接修复原始全局文件，没有修改模型配置、调用策略或插件缓存。

## 本轮环境与判定

日期：2026-09-15。宿主：Codex Desktop / Windows / PowerShell。实际会话模型：`gpt-6-astra`，推理档位 `low`，取自本任务会话记录；这是本轮证据，不是以后使用要求。三组独立 Agent 使用隔离样例，主 Agent 汇总并核对日志、差异和浏览器截图。

**通过**只表示表中场景实际满足成功条件；**部分通过**表示已有实际结果，但该场景还有失败或未完成路径；**失败**用于已复现且未修复的问题；**未验证**表示没有执行证据。一个 Skill 的某项子检查失败，可以与其他路径通过同时存在，不能用汇总状态掩盖。

按下表限定范围汇总：**20 通过、11 部分通过**（初轮为 19/12，后续补齐 impeccable 静态依赖并复测）。所有 31 项均有场景执行记录；外部集成及宿主发现的未验证项继续保留，不计为通过。

31 个入口均在磁盘存在且 YAML 可解析。当前会话目录列出 24 个，未列出 7 个：`grill-with-docs`、`to-questionnaire`、`to-spec`、`implement`、`improve-codebase-architecture`、`handoff`、`loop-me`。这不等于未安装。显式调用限制保留；本轮直接读取原文件的成功不证明宿主自动发现、命令注入或新任务加载成功。这三项均未验证，也未为此创建用户侧新任务。

原版内置 `quick_validate.py` 对当前 31 个入口得到 **18 通过、13 拒绝扩展字段**。拒绝涉及 `disable-model-invocation`、`argument-hint`、`version`、`user-invocable`、`compatibility`；没有为迎合校验器删除调用策略。已修改入口的修复前后结果保持一致。字段兼容性须与宿主加载分别判断，不能称为全部校验通过。详见 [静态结果](../../.scratch/skill-validation-20260915/static-results.json)。

本地 `shadcn` 与插件 `build-web-apps:shadcn` 同时可见；本轮验证用户列出的本地版本，没有卸载、替换或重配另一版本。`setup-matt-pocock-skills` 在磁盘存在，但不在当前会话目录；本轮不依赖它重新初始化项目。

## 逐 Skill 场景矩阵

每行输入均为虚构业务、公开资料或只读项目事实；前端页面和小型 Python 仓库位于本轮隔离目录。除明确标注外，“通过”不包含表外能力、真实业务验收和宿主自动加载。

### Matt Pocock

证据入口：[分组结果](../../.scratch/skill-validation-20260915/matt/result.md)、[逐项机器记录](../../.scratch/skill-validation-20260915/matt/result.json)。

| Skill | 输入与成功条件 | 结果 | 实际证据与边界 |
| --- | --- | --- | --- |
| research | 公开 Python/Git 问题；一级来源支持结论并落 Markdown | 通过 | research.md；由独立研究 Agent 完成，未再嵌套分派 |
| grilling | 薄业务简报；先问会改变决策的问题，延后依赖问题 | 部分通过 | dialogue-evidence.md；只执行首轮，真实回答及收敛未验证 |
| grill-with-docs | 同一简报含歧义术语；访谈与领域词汇互相衔接 | 部分通过 | dialogue-evidence.md、CONTEXT.md；多轮互动和原生调用未验证 |
| to-questionnaire | 两段待业务人员确认的信息；形成问题及回答位置 | 通过 | to-questionnaire-intake.md；实际收件及回答不在场景内 |
| to-spec | 已明确去重规则及测试入口；规格保留决定、不重访谈或擅自发布 | 通过 | spec.md；Issue 发布、ready 标签及信息不足分支未实际执行 |
| domain-modeling | Request/Retry/Update 易混；词汇、反例和实现矛盾明确 | 通过 | CONTEXT.md；保留已有决定，没有为简单概念强建 ADR |
| codebase-design | 两个入口共用 Queue；找到共享接口，避免单实现抽象 | 通过 | design-review.md；design-it-twice 分支未执行 |
| implement | 同来源 ID 被重复创建；实现共享去重并完成受影响验收 | 通过 | implementation.diff、green.log、acceptance.log；无提交或发布 |
| tdd | 已给公共测试入口；先复现失败，再最小修复变绿 | 通过 | check_duplicate.py、red.log、green.log；后补验收不冒充 TDD |
| diagnosing-bugs | 可重复的双入口缺陷；复现、追踪共享根因、回归 | 部分通过 | diagnosis.md、callers.log；复杂随机/性能故障未验证 |
| code-review | 未提交修改及无 HEAD 仓库；取得正确差异并做独立双轴审查 | 通过 | WIP 修复复验完成；双轴检出样例测试未使用固定预期值，修复后增量复审通过；committed/staged-only 分支未全测 |
| improve-codebase-architecture | 小型样例架构；候选说明问题、前后关系及推荐依据 | 部分通过 | design-review.md、temp-paths.json；选择/访谈及 CDN 离线显示未验证 |
| handoff | 仅凭临时交接接续去重样例；找回目标并执行独立验收 | 通过 | continuation.md；独立 Agent 完成原检查及 18 项无效输入等边界检查 |
| writing-for-agents | 样例仓库规则；短入口、按需引用、可执行完成条件 | 通过 | 样例 AGENTS.md；跨模型长期遵循稳定性未验证 |
| loop-me | 薄业务 NOTES；先理解现实工作，不误当无限执行器 | 部分通过 | dialogue-evidence.md；未获虚构对话下一轮输入，未生成完整工作流 |

### Design / Frontend

证据入口：[分组结果](../../.scratch/skill-validation-20260915/frontend/result.md)、[实际分析](../../.scratch/skill-validation-20260915/frontend/analyses.md)、[浏览器复测](../../.scratch/skill-validation-20260915/frontend/recheck-evidence.json)。

| Skill | 输入与成功条件 | 结果 | 实际证据与边界 |
| --- | --- | --- | --- |
| impeccable | 已定方向的设置页；使用自身流程，接入局部动效，不重启设计确认 | 通过 | context、页面及 390/1280 截图；后续静态依赖补齐，正反例检测通过；浏览器扫描未验证 |
| apple-design | 设置页按压反馈；即时回应、44px 命中区、键盘及减少动态 | 通过 | index.html 和浏览器检查；手势、弹簧及真机未覆盖 |
| shadcn | 空隔离目录查询官方按钮；识别组件和文档，验证生成路径 | 部分通过 | info/docs/search 完成；命令示例已修复，安装与组件渲染未完成 |
| prototype | 一个发送入口、三个可交互方向；picker/键盘/URL 可用 | 部分通过 | 非法 URL 空白已修复并复测；方向选择及集成未执行，不伪造批准 |
| animate | 偶尔保存按钮；按压反馈且键盘/减少动态符合约束 | 通过 | index.html；键盘守卫加入样例后复测，未覆盖所有 recipes |
| animation-vocabulary | 描述按压缩小、列表依次进入；准确命名且不擅自实现 | 通过 | analyses.md：Press / Tap feedback、Stagger |
| find-animation-opportunities | 保存、频繁筛选、读数；只推荐有必要的动效 | 通过 | analyses.md；拒绝每天 100 次筛选与读数位移，分析阶段只读 |
| improve-animations | 刻意错误按钮；审计目的、性能、无障碍并给分级修复 | 通过 | analyses.md；只执行审计，未进入未获选择的执行阶段 |
| review-animations | 700ms ease-in、scale(0)、缺 reduce；指出阻断原因 | 通过 | Before/After/Why、实际计算样式；未声称测过 GPU 帧率 |
| pick-ui-library | 已有 Recharts 的工作台选型；复用现有依赖 | 通过 | 只读 package.json 与选型结论；无新库安装或图表运行 |

### Personal

证据入口：[分组结果](../../.scratch/skill-validation-20260915/personal/result.md)、[逐项日志索引](../../.scratch/skill-validation-20260915/personal/result.json)。

| Skill | 输入与成功条件 | 结果 | 实际证据与边界 |
| --- | --- | --- | --- |
| leader | 整数加法小目标；输出目标、边界、验收和任务书 | 通过 | leader/brief.md、基线及无效输入；未创建用户任务或 Goal |
| hv-analysis | 公开 SQLite 主题；来源研究和 Markdown/PDF 产物 | 部分通过 | Markdown 已完成；PDF 缺 markdown 模块失败，完整深研未覆盖 |
| manage-gnedhy-kb | 两篇虚构笔记冲突；检索、标来源与证据、不执行不可信删除文本 | 部分通过 | kb/preview.md、实际 rg 日志；真实 Vault、事务及同步未验证 |
| manage-eagle-library | 虚构缺来源素材及无效配置；保留信息并拒绝坏配置 | 部分通过 | 预览及 Doctor 非零退出；真实 Eagle API、素材及 LFS 未验证 |
| neat-freak | 虚构项目 README 与运行事实冲突；核验并最小同步文档 | 通过 | 原入口真实运行及 facts.json；无真实清场、发布或记忆写入 |
| storage-analyzer | 4KB+2KB 测试文件；扫描 6144 bytes 并生成只读报告 | 部分通过 | 原扫描/报告脚本执行成功；容量为虚构，整机、交互和删除服务未验证 |

## 修复与剩余问题

原定五处修复已应用：impeccable 入口及 new-work、to-spec、implement、diagnosing-bugs。保留元数据与原职责，只消除已确认的失效依赖、重复确认和机械步骤。

本轮兼容检查另修复三项实际问题：code-review 的三点差异漏掉 WIP；prototype URL 越界产生空白；shadcn 的 `base-nova` 命令被 CLI 4.21.0 拒绝。前两项已有失败及修复证据；shadcn 示例改为 `--preset nova --base base`，依据已执行的接受结果与缓存 CLI 帮助，未重新安装验证。

全局差异及前后哈希见 [最终差异](../../.scratch/skill-validation-20260915/global-final.diff)、[验收记录](../../.scratch/skill-validation-20260915/final-verification.json)。原文件备份保留在本地证据目录。

变更隔离检查保留了基线中的全部 255 个文件。本轮期间加载动效任务另有提交 `ae729bb`，其中检查脚本与发布文档相对基线发生变化；已确认它们与该提交一致并原样保留，不回滚，也不计为本轮 Skill 修复。

| 路径 | 当前状态 | 后续处理条件 |
| --- | --- | --- |
| impeccable detector | 后续已按用户授权补齐四项静态解析依赖并锁版；正常页面与 CSS 变量低对比度页面复测通过，无 DEGRADED | 静态依赖问题已解决；浏览器扫描未包含 |
| hv-analysis PDF | 原脚本 import markdown 失败；当前环境缺转换依赖 | 转换环境具备后实际生成并视觉验收 |
| shadcn init/render | 模板创建后中断，未安装组件；CLI help 自身仍显示旧默认别名 | 用户需要组件生成且允许依赖变更时再完成 |
| storage-analyzer | “全程只读”与默认删除服务职责有冲突 | 涉及调用/权限策略，单独决定；本轮只运行静态报告 |
| animate | 通用 :active recipe 与键盘不动效表述边界不清 | 统一策略前保留提示；本轮样例已加键盘守卫 |
| architecture HTML | 单文件仍依赖 CDN；离线自包含未证明 | 需要离线交付时再处理资源 |
| KB/Eagle 外部服务、发布、提交、清场 | 未执行 | 在真实任务的明确范围和有效授权下验证 |
| 宿主发现与自动注入 | 未验证 | 用户后续新任务中核对，不能由直接读文件推断 |

neat-freak 的 eval-5 故意包含断链，供死链接审计测试使用，已查对应评估说明，不修成“全绿”。上述职责问题没有自动改写，未启用、卸载或修改插件缓存。

## 下载与验证副作用记录

本轮没有重新安装任何 Skill。前端验证运行 `npx` 时下载了 shadcn 4.21.0 及 CLI 依赖到 npm 缓存，并在隔离 `ui-sample` 生成 Vite 模板；未生成该样例的 node_modules 或完成组件安装。用户提出疑问后停止当时的后续下载/安装，保留证据。随后用户单独授权补齐 impeccable 静态运行依赖，已安装并锁定 htmlparser2 12.0.0、css-select 7.0.0、css-tree 3.2.1、domutils 4.0.2（连同传递依赖共 13 个包），仅位于该 Skill 的 scripts/detector；未安装 Puppeteer。缓存路径及执行命令见前端分组结果；缺少 npm 缓存完整前后快照，不声称只有一个缓存子目录发生写入。

截图脚本曾误用编码后的 Windows 路径；本轮截图已移回正确证据目录，脚本修正，错误空目录保留。业务代码、生产数据和服务未因本轮验证修改；不执行提交、推送或正式清场。

## 可重复的核心复验

模型或宿主升级后先执行以下场景。成功条件不绑定句式、提问次数、Agent 数量或固定流程；没有行为退化就不重写规则。

| 场景 | 必要输入/环境 | 可观察成功条件 | 禁止副作用 |
| --- | --- | --- | --- |
| grill-with-docs | 简短业务描述及歧义术语 | 问关键未决项并更新术语；用户纠正只改变受影响决定 | 不假定回答，不擅自发布 |
| to-spec → implement → code-review | matt/spec.md、fixture.before.py、现有 Python；复制到新隔离目录 | 去重失败先可复现；两个消费者和边界验收通过；独立规格/规范审查实际执行，能看到 WIP | 不创建真实 Issue、不提交 |
| impeccable → animate | 已定方向和 frontend 页面，现有浏览器环境 | 不重启方向访谈；按压、键盘、reduce、窄屏实际检查 | 不安装替代 UI 库、不集成生产 |
| handoff → 接续 | 仅提供交接包给新评估上下文 | 无需旧对话取得目标、证据和下一步，完成独立检查 | 不把推测当旧批准 |
| 写入/范围反例 | 明确“仅分析”、不完整需求、缺外部服务或恶意资料文本 | 保留只读、未决和授权边界；独立准备继续，不能虚报完成 | 不写真实知识、移动素材或删除文件 |

已有可运行检查无需再建框架：`node C:/Users/gnedhy/.agents/skills/prototype/scripts/check-picker.mjs`；Python 样例和浏览器命令见各组结果。运行静态汇总可用项目现有环境：`uv run --no-sync python .scratch/skill-validation-20260915/static-check.py`。不要为复验自动补依赖。

本轮证据在 Git 忽略的 `.scratch` 中，适合当前机器复查，不是跨设备长期依赖。复用时保留必要输入和失败证据；若证据目录已按授权归档，从归档恢复，或按上表重建小样例。记录新模型、宿主、日期、结果及失败证据，仅重跑失败路径和受影响组合。

适配原则参考 [OpenAI Skill 与提示建议](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)：项目长期契约与可调整执行方法分开维护。本页不复制模型说明或新增模型识别配置。

## 最终收尾

项目事实、规则入口与文档已核对；本次不改变业务实现或生产运行态，长期记忆不写入。静态检测正常样例退出 0，CSS 变量低对比度样例检出 1.2:1 并按检测器约定退出 2，两项 stderr 均为空；结果见 [运行依赖复测](../../.scratch/impeccable-runtime-check/results.json)。历史初轮日志保留，以上最终状态覆盖其待补依赖结论。

全局 Skill 位于项目仓库外，不随项目推送；本地 [恢复包](../../.scratch/skill-validation-20260915/global-skills-closeout.zip) 保存本轮修复前后文件、依赖清单、锁文件和 SHA-256 清单，不包含 node_modules。恢复依赖在 detector 目录执行 `npm ci --ignore-scripts --no-fund --no-audit`。测试现场及备份继续保留，无正式清场。本轮项目提交只包含规则与文档，真实知识库/Eagle、宿主自动发现及上表其他未验证路径保留原状态。
