# Harness 运行接口与技术验证规格

日期：2026-08-19
状态：接口规格，尚未实施
依赖：Issue #4 完成后进入 Issue #5；DeepSeek Harness Adapter 的运行验证属于 Issue #6。

## 目标

在宏昊 AI 产品层与具体智能体内核之间建立一个小而稳定的 seam。产品层只表达“执行一次任务运行”和“取消一次任务运行”，不学习 DeepSeek Harness 的 Cordis、Profile、Agent 或 SessionEvent 细节。

该 seam 需要至少两个 Adapter 才成立：

- `MockHarnessAdapter`：确定性执行，用于 V0.1 自动化验收。
- `DeepSeekHarnessAdapter`：把相同接口映射到锁定版本的 DeepSeek Harness。

## 模块与接口

模块暂定名为 `HarnessRuntime`。建议只有两个操作：

```text
run(request) -> 按顺序产生 HarnessEvent；正常结束时产生 run_stopped
cancel(task_run_id) -> 请求取消；结果由 run_stopped 或产品层失联检测确认
```

恢复不另设第三个操作。恢复是对既有 `task_run_id` 再次调用 `run`，并在请求中携带已保存检查点和本次补充输入。这样暂停、恢复和首次执行共享同一条路径。

### RunRequest

产品层传入不可变的任务运行快照：

- `task_run_id`、`task_id`、`conversation_id`。
- 创建任务时的可选 `project_id`。
- 材料引用与受控工作目录授权，不传任意文件系统访问权。
- 个人与公共知识范围，不传未经许可的知识正文。
- Provider、技能版本、工作流版本。
- 工具白名单与每项工具的参数约束。
- 步骤、时间、模型调用、工具调用和费用预算。
- 可选检查点与本次补充输入。

### HarnessEvent

所有事件具有 `task_run_id`、单调递增 `sequence`、`occurred_at` 和结构化 `payload`。V0.1 只稳定以下事件类型：

- `run_started`：运行已接受。
- `phase_changed`：理解、计划、执行、观察或判断阶段变化。
- `tool_started`：白名单工具开始执行，只记录工具和脱敏参数摘要。
- `tool_completed`：工具返回边界校验后的摘要。
- `checkpoint_saved`：存在可恢复检查点。
- `run_waiting`：等待补充信息、诊断审阅或修改确认。
- `run_stopped`：运行终止并携带唯一停止原因。

模型请求、流式 token 和 DeepSeek Harness 内部事件可以作为 Adapter 内部证据，但不直接成为前端长期合约。确有产品价值时，再通过新的宏昊 AI 事件显式加入。

### 停止原因

Adapter 正常结束时以 `run_stopped` 作为最终事件；若内核进程硬崩溃或连接丢失，产品层必须检测未闭合运行并补记 `failed`，保证持久记录最终只有一个停止原因。停止原因只能是：

- `completed`
- `waiting_for_user`
- `waiting_for_confirmation`
- `policy_blocked`
- `budget_exhausted`
- `failed`
- `cancelled`

等待原因继续使用领域文档定义的三类原因，不能用一个模糊的“等待审批”替代。

## 运行时职责

`HarnessRuntime` 模块内部负责：

- 根据运行请求组装模型上下文和工具能力。
- 执行有界 Loop，并在预算内决定继续、等待或停止。
- 串行化并转换内核事件，保证事件顺序稳定。
- 把取消请求传播到模型、工具和子进程。
- 生成检查点并在恢复时验证其运行归属。
- 把内核错误转换为有限且不泄密的失败原因。

产品层负责：

- 创建任务和任务运行。
- 持久化标准化事件与当前状态。
- 发放受控工作目录、知识范围和工具白名单。
- 展示执行过程、等待原因与停止原因。
- 执行待确认修改、安全审查和代码审查。

## DeepSeek Harness Adapter 约束

- 锁定精确 npm 版本或 Git 提交，不跟随浮动最新版。
- 初期运行在独立 Node 进程，不嵌入 FastAPI 进程。
- 不采用 DeepSeek Harness Web UI。
- 不允许前端直接调用其 API Gateway。
- DeepSeek Harness Session ID 只作为任务运行的外部执行标识。
- 只加载验证过的 Profile、Plugin、模型 Adapter 和工具。
- `ctx.fs`、`ctx.sandbox`、子进程与网络出口必须受宏昊 AI 策略约束。
- 原始提示词、知识正文、敏感材料和完整工具结果不得进入普通运行日志。

## 第一条技术验证

场景使用 Issue #6 的 Mock 需求诊断主路径：

1. 产品层创建一个任务运行快照。
2. `MockHarnessAdapter` 依次产生预检、知识检索、技能调用、诊断生成和等待审阅事件。
3. 产品层持久化事件并把任务运行更新为等待诊断审阅。
4. 用相同的 `RunRequest` 契约替换为 `DeepSeekHarnessAdapter`，先使用只读 Mock 工具。
5. 对比两个 Adapter 的外部事件和最终停止原因，而不是对比内部实现。

## 预先确认的测试 seam

进入 TDD 后只从以下两个 seam 测试，不测试 Adapter 私有函数或 DeepSeek Harness 内部对象：

1. `HarnessRuntime.run`：给定固定运行请求，观察标准化事件序列和唯一停止原因。
2. `HarnessRuntime.cancel`：取消已开始运行，观察最终 `cancelled`，并确认不会再产生工具副作用。

端到端测试另从现有 HTTP 接口观察任务运行状态和事件，不绕过接口查询内部临时状态。

## 验收标准

- Mock 与 DeepSeek Harness 两个 Adapter 使用同一接口。
- 产品层与前端不出现 Cordis、Profile、Agent、SessionEvent 等内核类型。
- 每次运行的事件序号稳定，且只有一个最终停止原因。
- 重复提交、取消、进程中断与恢复不会产生重复工具副作用。
- Windows、中文路径和 UTF-8 材料通过验证。
- 越界文件、未授权工具、敏感数据出站与未批准网络访问会以 `policy_blocked` 停止。
- Harness 不能直接写入项目卡、个人知识或公共知识。

## 暂缓

- 不导入或 Fork 整个 DeepSeek Harness Monorepo。
- 不实现通用多智能体编排。
- 不开放任意第三方 Plugin 安装。
- 不把全部流式 token 作为永久业务事件。
- 不在本规格阶段安装 DeepSeek Harness 或改变现有 UI。
