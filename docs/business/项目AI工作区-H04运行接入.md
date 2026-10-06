# H04 Codex 运行接入

2026-10-06；从 H03 集成提交 `b83c90bd6b64a8297fb725d3d52bf38ef12bea5e` 建立 `codex/h04-codex-runtime`，对应 [#76](https://github.com/gnedhy/honghao-ai-workbench/issues/76)。沿用 [H03 数据合同](项目AI工作区-H03数据与权限.md)和[领域与交互](项目AI工作区-领域与交互.md)。本项是候选代码接入，不部署或启用正式模块。

## 接口、身份与执行

消息接受保留 H03 的原子接口和幂等回执。另用 `POST /api/conversations/{id}/messages/{messageId}/execution` 明确启动已接受的本人 user 消息，空请求体，不接受 RPC、目录、模型、权限或配置。GET 同一入口对账，POST 重复返回原运行；已失败／停止的输入不再次执行，用户明确继续任务并提交新消息才新增运行。读取与停止经所属会话入口校验所有者与当前授权。

普通聊天也有真实运行，但 `task_id` 为 NULL，不生成任务。保留既有 `task_runs` 表名，扩充会话、内核上下文及事件关系；任务读取只返回所属 work 运行。一个会话同时只有一个活动运行，含 chat/work，数据库唯一索引保护；未执行消息按接受顺序启动，不跳过较早待执行输入。H03 的工作提交校验同步覆盖会话活动运行。

接受启动先持久化运行及上下文，后发起后台执行。浏览器请求或订阅断开不取消后台；启动响应未知时 GET／同输入 POST 对账，不能制造第二次执行。启动前健康检查失败保留消息待执行，返回安全错误；已创建运行中的错误记录为真实终态。

## 内核与状态

固定官方 Codex 0.160.0 Linux x86_64 二进制、同官方包的 bubblewrap 摘要及 H01 模型目录。通过隔离 stdio 使用稳定 `initialize/initialized`、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`；启用 `experimentalApi=false`。只允许控制器构造请求，不转发浏览器原生参数。协议以该二进制生成的 schema 和 H01 实测为准，[官方通信文档](https://developers.openai.com/codex/app-server/)供交叉检查。

| 内部事件 | 持久产品状态／公开内容 |
| --- | --- |
| 控制器接受启动 | running；phase=starting，不称模型已回复 |
| turn/start 回执、turn/started | running；phase=generating，保存原生 turn ID |
| item/agentMessage/delta | 累积助手正文；事件正文只含本次实际增量 |
| turn/completed completed | completed；原子保存终态、实际正文和完成事件 |
| turn/completed interrupted | stopped；保留部分正文，记录中断原因 |
| turn/completed failed／进程或通信异常 | failed；固定安全原因，不返回原始错误／本机路径 |
| 权限、预算、异常工具请求 | blocked；停止进程并保留已确认正文 |
| 停止 POST | 先持久化 stop_requested；回执只表示停止请求已接受；原生确认或强制停止后才进入 stopped |

H04 不开放交互审批或等待输入能力；遇到内核服务端请求安全拒绝并阻断，不伪造 waiting。等待状态保留 H02 枚举，未来有实际消费者与协议验证才启用。聊天禁工具；H04 工作同样只接入文本运行，文件、显式技能、业务 MCP 分别归 H06/H07/H08。模型请求禁用工具，意外函数调用不交给内核执行，不能以提示词代替权限。

## 持久事件、取消和恢复

`GET /api/conversations/{id}/executions/{runId}/events?after=N` 提供同源 cookie SSE，公开事件为 `state`／`delta`，只含 runId、递增 seq、状态／阶段／安全原因、模型流已开始的实际布尔标记或 delta。数据库按运行分配 seq，与正文／终态在同一事务提交；重连按确认位置读取，客户端重复 seq 忽略。不能返回原生事件、命令、内核路径、环境或凭据。输入 cursor 为非负整数；逐批限制读取，当前账号与会话权限每次轮询重新校验，失效即结束流。GET 不创建运行。

`POST .../executions/{runId}/stop` 幂等，标记请求后由控制器 interrupt，超过停止宽限杀掉该运行进程树／scope，未确认期间仍为活动运行。取消页面订阅只清理请求。服务停机主动关闭模型连接、进程及 scope，并等待后台真正结束后释放现有数据库 lease；终态持久化失败会阻断新 AI 执行，保留未确认记录。服务停机收敛所有本控制器运行；非正常重启时，在既有单服务数据库 lease 下先停止同服务身份的残留 scope，再将残留活动运行标记 stopped/controller_restart；无法确认 OS 清理时阻断 AI，不假称已停止，保留输入、部分回复和事件，不自动重放 turn 或文件操作。后续明确消息可继续同一产品任务。

内核上下文按 owner、会话、mode／task、冻结项目来源、项目 revision 和有效内核配置绑定，CODEX_HOME 与受控 cwd 分开。同上下文正常完成后以 thread/resume（excludeTurns=true，避免返回整段原生历史）延续；失败、不确定中断、授权／项目／配置变化时废弃绑定并新建原生上下文，不将旧资料自动重放。产品 taskId 保持。H06/H07/H08 在实际接口存在时把文件／规则／技能版本和来源权限加入绑定，不能提前写空对象冒充支持。

## 部署配置、隔离与预算

使用受保护的管理员配置文件路径 `HONGHAO_CODEX_CONFIG`；未配置时 AI 执行不可用，既有业务就绪不受影响。配置列明独立 runtime_root、固定 binary/catalog/key_file 及资源预算；禁止读取员工个人 CODEX_HOME。内核目录、配置、密钥与控制器目录不在执行 cwd 内；H06 原件和上传文件也不得进入规则／技能发现目录。普通上传 AGENTS.md/SKILL.md 是资料，只有明确规则／技能接口才能启用。

Linux非 root 服务身份不得有 sudo/docker 等宿主管理能力，capabilities 为零。通过配置好的 systemd 用户管理器创建每次执行的独立 scope；cgroup 限制内存、swap、CPU 和进程数，prlimit 限制文件大小／描述符。任何资源控制或 Codex bubblewrap 沙箱不可用均阻断，无无沙箱回退。Windows 开发可运行模拟协议测试，不能作为企业 Linux 隔离验收。

默认并发 1、不自动排队；每运行 MemoryMax=768 MiB、MemorySwapMax=0、TasksMax=48、CPUQuota=100%、文件 64 MiB、描述符 256；墙钟 180 秒、模型请求 8 次、单次输出上限 4096 tokens、累计模型 token 预算 24000、可见正文 65536 字符、原生消息 1 MiB；单上下文缓存启动前限制 64 MiB，超限阻断并保留记录，由维护者处理。管理员可在受保护配置内调整有界预算，配置指纹变化重建上下文。预算超限先阻止下一模型请求，当前 token 使用事件超限立即中断；按请求 UTF-8 大小预留保守预算，超量请求不发往模型；reported_model_tokens 仅累计 provider 已返回的 usage，取消或失败未报告的用量保持未知，不能把 0 当收费为零。记录实测用量，不称 provider 生成边界为绝对收费上限。

模型 API key 仅控制器内存持有；每运行短期 loopback 转发端点，使用随机访问凭证并校验 run、owner 当前有效授权、截止时间、请求／token 预算。转发只允许固定 DeepSeek HTTPS Responses 路径，系统 CA 验证，无重定向、任意目标或自动重试。内核只持短期转发凭证；工具环境／stdin无模型密钥。H04 工具及网络受 native 权限限制；后续 MCP/文件动作必须逐次授权，不复用启动授权替代当前权限。

启动验证版本／摘要、权限、资源控制、协议、沙箱读写及网络负例；模型网络可用性以实际请求记录，不把无凭据 health 当真实模型验证。`GET /api/conversations/runtime-status` 仅安全状态、固定版本和可处理原因，不回显配置路径。模型或内核故障仅阻断执行，项目、任务、成果读取及采购／研发／销售仍可用。

## 验证和交付

定向实库覆盖本人／他人／管理员／撤权、chat 无任务、work 连续任务、幂等启动、会话并发、按序输入、事件去重、取消未知／终态、启动失败、预算及重启无重放；模拟 stdio 覆盖 malformed/EOF/延迟、错误事件、异常工具、token 和正文限额。通过所属聊天 hook 的实际 App 消费者验证原始协议不进 UI、增量／停止／重连、身份清理及订阅释放，H05 再细化视觉和交互。

独立 Ubuntu 22.04 虚机的合成资料验证使用本项实际运行入口和固定二进制，实测真实 DeepSeek、stream、cancel、process restart、scope 限额、无管理权限身份与沙箱；与模拟／Windows PostgreSQL／CI证据分别记录。正式服务器 5.15.0-43/KVM 和最终运维身份仍由 H12/H13 对照，不能冒称已上线验证。

跨模块、权限及公共类型改动完成原有完整门禁，保持样本及性能预算；模型网络、控制器／数据库和浏览器计时分别记录。同步静态 chat/tasks 合同、变更声明和回归地图，不创建运行时注册。经规格／规范审查后提交任务 PR 到功能集成分支；不向 main 合并、不部署、不启用。运行数据与内核会话不在 CI 上传，安全回执不含原始错误、数据库或凭据。
