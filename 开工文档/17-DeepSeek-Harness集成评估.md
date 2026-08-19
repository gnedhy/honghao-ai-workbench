# DeepSeek Harness 集成评估

日期：2026-08-19
范围：只评估技术定位与集成边界，不替换现有界面，不实施运行时接入。

## 结论

可以基于 DeepSeek Harness 继续建设宏昊 AI，但应把它定位为**可替换的智能体执行内核**，而不是整个平台的产品底座，也不采用它自带的 Web UI。

宏昊 AI 已完成的 React 界面、会话与轻项目语义、FastAPI 产品 API、SQLite 业务数据、知识空间、技能与工作流、待确认修改及安全审查边界都应保留。DeepSeek Harness 只负责一次任务运行中的模型调用、工具调用、会话事件、执行循环、停止和恢复等底层能力。

## 官方能力与适配依据

- DeepSeek Harness 是 DeepSeek AI 发布的开源 Agent Harness，采用“Everything is a Plugin”的 Cordis 插件架构；当前仍是 Developer Preview，并明确提示会发生兼容性破坏。[官方 README](https://github.com/deepseek-ai/deepseek-harness)
- 官方架构把模型适配器、工具注册、会话日志、Agent Loop、文件系统、沙箱和审批策略做成可替换能力；同时明确给出自定义 UI 的扩展方式：驱动 `ctx.agents`，并从 `session/event` 渲染。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- `headless` Profile 不启动 HTTP Server 或 Web UI，只执行一个任务并退出；它适合一次性技术验证，但因为没有交互式追问表面，不能直接承担宏昊 AI 的持续会话、等待确认和恢复体验。[Headless 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- 官方 API Gateway 是 Harness 自身 Host/Client 插件体系的一部分，依赖生成式 TypeScript Remote 合约和 Connection RPC；它不是一个已经稳定承诺、可让现有 FastAPI 直接长期绑定的通用外部 API。[API Gateway 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/api-gateway.md)
- 源码开发需要 Node.js 22.19+ 或 24+、固定版本 pnpm，并采用 Host/Client 两套 TypeScript 聚合构建，工程复杂度明显高于当前项目。[开发指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md)
- 项目采用 MIT License；正式集成时仍需保留许可证并审查第三方依赖声明。[LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)

## 建议的目标结构

```text
宏昊 AI React UI
        │
        ▼
FastAPI 产品 API
  ├─ 会话 / 轻项目 / 任务 / 任务运行
  ├─ 知识空间 / 技能 / 工作流
  ├─ 待确认修改 / 安全与代码审查
  └─ HarnessRuntime（稳定的内部接口）
                    │
                    ▼
       DeepSeek Harness Adapter
       （独立 Node 进程或自定义 Profile）
                    │
                    ▼
     模型 / 工具 / 文件系统 / Sandbox
```

FastAPI 与 SQLite 继续作为产品业务事实源。前端只识别宏昊 AI 自己的任务运行事件，不直接依赖 DeepSeek Harness 的内部事件结构。

## 领域映射

| 宏昊 AI 概念 | DeepSeek Harness 对应能力 | 边界 |
| --- | --- | --- |
| 会话 | Session / SessionEvent | 宏昊 AI 保存产品会话；只记录外部运行会话 ID |
| 任务 | 无需一一对应 | 仍是宏昊 AI 的持久业务对象 |
| 任务运行 | Agent 的一次执行尝试 | 一个任务可有多次运行，每次运行可绑定一个 Harness Session |
| 智能体执行器 | Agent、Agent Loop、Context | 可复用的核心部分 |
| 执行循环 | turn / step / tool pipeline | 内核事件转换为宏昊 AI 的停止原因；任务状态由产品层据此更新 |
| 技能 | 由 Adapter 落实为内核能力调用 | 技能仍是宏昊 AI 的版本化定义，不与 Tool 或 Plugin 混称 |
| 工作流 | 不等于 Agent Loop | 工作流仍是外层固定业务流程和人工关口 |
| 受控工作目录 | `ctx.fs`、`ctx.sandbox` | 授权范围由宏昊 AI 发放，Harness 不得自行扩大 |
| 待确认修改 | 无直接替代 | 正式写入仍必须经过宏昊 AI 的独立确认流程 |

## 不应交给 DeepSeek Harness 的部分

- 个人与公共知识空间、RAG 权限和公共知识发布审核。
- 轻项目、会话、任务及任务运行的产品语义和业务数据。
- 技能与工作流的企业发布、版本和责任人管理。
- 待确认修改、数据安全审查、代码审查和审计策略。
- 宏昊 AI 的现有前端信息架构与交互体验。

## 主要风险

1. **兼容风险**：Developer Preview 会发生破坏性变更，必须锁定精确版本或提交，并通过 Adapter 隔离。
2. **双运行时复杂度**：当前后端是 Python，Harness 是 Node/TypeScript；不要把两套业务模型混在一起。
3. **恢复与幂等**：需验证进程中断、重复提交、工具执行后崩溃、等待人工确认后的恢复。
4. **安全边界**：只启用白名单插件和工具；文件系统、子进程、网络出口、日志脱敏和审批全部默认收紧。
5. **事件耦合**：Harness SessionEvent 可作为执行证据来源，但宏昊 AI 的 TaskRunEvent 必须使用自己的稳定合约。
6. **复杂度收益比**：V0.1 只验证一条真实闭环，不复制或改造整个 Harness Monorepo。

## 最小技术验证

先做一个独立 Spike，不改现有 UI 和业务数据库：

1. 锁定一个 DeepSeek Harness 版本或提交。
2. 在独立 Node 进程运行一个固定的“需求诊断”任务，初期只允许只读 Mock 工具。
3. 由 FastAPI 通过一个最小 Adapter 启动、取消并接收运行事件。
4. 把事件转换为宏昊 AI 的任务运行状态、步骤、工具调用和停止原因。
5. 在现有工作界面显示真实进度，不直接渲染 Harness 原始协议。
6. 验证后再决定是否接入真实模型、受控工作目录和等待确认恢复。

### 验收标准

- 现有 UI 不需要重写。
- Harness 关闭或升级失败时，宏昊 AI 业务数据仍可读取。
- 同一提交不会重复创建任务或重复执行。
- Windows、中文路径、UTF-8、取消、超时、崩溃恢复可验证。
- 工具不能访问未授权目录或未批准的网络出口。
- 每次运行都有明确停止原因，正式写入仍只能通过待确认修改完成。

## 决策建议

**采用其执行内核思想并开展隔离验证；不把宏昊 AI 整体迁移到 DeepSeek Harness，不使用其 Web UI，不直接绑定其内部 API。**

通过 Spike 后，再决定是长期使用 DeepSeek Harness Adapter，还是仅吸收其插件、事件日志和 Agent Loop 设计，自研更小的执行器。
