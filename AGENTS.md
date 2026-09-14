# AGENTS.md

## 当前产品范围

优先实现职能工作台，当前采购与研发五部工作台已上线；其他模块后续再评估，不主动扩建或删除。参见 `docs/adr/0008-工作台优先与候选验收边界.md`；运行状态以 `README.md` 和实际数据目录、服务为准，不能用端口判断正式环境。

## Agent skills

### Issue tracker

本仓库使用 GitHub Issues 跟踪规格与开发任务。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五类任务分流标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

采用单上下文结构：根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。

## 界面复用

新增界面、调整同类控件或动效前，先查 [公共组件与交互约定](docs/components.md)，复用实现入口并验证实际消费者。权限、请求、计算及草稿由业务层负责；隔离验收通过后再申请正式替换。
