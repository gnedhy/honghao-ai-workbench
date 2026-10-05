# 生产监测与持续巡检

本页维护第 5 项的运行检查、处理责任和恢复入口。原始需求是关键任务失败、数据新鲜度、错误率、备份可恢复性与依赖漏洞持续复核。数值以 [operations-policy.json](../../scripts/operations-policy.json) 为准；初始阈值是运维预警设置，不是已经批准的业务 SLA、RPO 或真实用户性能目标。

## 当前执行安排

2026-10-05 用户确认功能完善和发布会持续人工检查，自动巡检暂缓启用；下述定期执行与告警规则为启用后的行为，不代表计划任务已运行，也不作为当前收尾的阻塞项。保留现有巡检脚本及验收证据，后续需要无人值守监测时再启用。人工功能／发布检查不等同于持续运行监测；现有 PR、主线与每周 CI 不受此安排影响。

正式 PDF 依赖升级保留为待完成项：后续发布时重新审计候选并按当前授权执行，启用知识／PDF 上传功能前完成升级。

## 运行检查

[独立巡检](../../scripts/operations-monitor.py)读取现役 active.json，核对 production 身份、版本目录、监听进程／虚拟环境父进程、启动命令和数据目录 .service.pid，再执行下表检查。端口、一次 health 成功或某次 CI 绿灯不能替代实例核验。

| 检查 | 判定与证据 | 处理责任 |
| --- | --- | --- |
| 服务与业务就绪 | health 核对产品和 production 环境；readiness 核对数据库、迁移、角色、配置及已启用任务。超时、503、缺项或失败为 critical；探针超过 1 秒提醒 | 管理员／IT 核对程序、数据库和日志，按现有启动／恢复入口处理 |
| 关键任务积压 | production app 连接设置 default_transaction_read_only=on、3 秒 statement timeout，仅查汇总。研发失败事件或采购到期排期／研发待处理积压超过 5 分钟为 critical | 管理员／IT 查 worker、锁和数据库；采购／研发负责人核对业务基线与结果，不直接改事件状态 |
| 资讯新鲜度 | 独立核对 checked_at、三个来源 last_success、是否有 error 和结果。超过两小时、缺来源或未来时间提醒，与现行每小时采集一致 | IT 查 Node、Chromium、网络和采集；采购负责人核对资讯 |
| 发布与在线资源 | 清单中的本地文件 SHA-256、dist HTTP 内容及前后 active 指纹，不一致为 critical | 管理员／IT 保留现场，对照冻结清单，按授权回退或重新发布 |
| API 错误样本 | 本次新增访问日志最多 1 MiB，只累计 API 请求、4xx、5xx，排除 health/readiness。出现 5xx 提醒；至少 20 个请求且 5xx 达到 5% 为 critical | 开发维护者诊断版本，业务负责人复验受影响场景 |
| 容量 | 程序／数据卷剩余空间低于 5 GiB 提醒，低于 2 GiB 为 critical | IT 按实际占用处理，不自动删业务资料和备份 |
| 备份时效与完整性 | 程序和数据备份根中最新 production 快照超过 24 小时提醒；超过 7 天或缺快照为 critical。首次、换快照及每 24 小时调用现役 verify_snapshot，核验文件、引用、迁移、表清单、原生 TOC 和完整解压 | 管理员／IT 用既有 backup、verify-only 及隔离恢复入口保留完整回执 |
| 依赖漏洞 | [锁文件审计](../../scripts/check-dependencies.py)检查 npm/Python，包括开发依赖；失败、漏审或已知漏洞为 critical。报告超过 8 天或不匹配现役锁文件不能通过 | 开发维护者核对公告、修候选并完整回归；管理员按当前授权替换正式依赖 |

错误率是新增有界日志样本，不称为全站 SLI；首次／换日志含有限历史，标记 baseline，窗口超限标记截断。4xx 包含正常拒绝，不自动当作服务故障。未测完整请求延迟分布和生产 LCP／INP，探针耗时另行解释。队列查询不读配方、成本、人员、原因和错误正文，也不执行重算、启用或业务写入。

备份完整性不等于目标服务器恢复成功。每月至少一次，以及迁移／恢复逻辑变化后，由管理员／IT 在新的空隔离数据库和附件目录恢复最新生产快照，核对逐表、附件、登录和业务，保留演练回执。正式数据恢复仍遵守 [运行与维护](../运行与维护.md#运维备份与恢复)的授权和新空目标边界；本轮不自动复制生产数据到测试库。每周完整 CI 使用合成数据执行已有真实恢复测试，保护恢复程序持续可用。

## 告警与处理

每五分钟巡检；critical 立即登记，warning 连续三次登记，恢复追加 recovered，严重性上升追加 escalated。快照报告、日历史和告警转移只保存固定检查 ID、状态和数值，不保存 SQL、参数、连接、正文、访问路径、堆栈或凭据。监测输出保留 30 天，不清理业务或备份目录。

计划任务结果 0/1/2 对应 ok/warning/critical。reports/index.html 每 30 秒刷新，报告超过 15 分钟显示“巡检已过期”。维护者每天查看任务最近结果和告警页；告警保存在本机记录与任务结果，不声称已发送飞书、邮件或有人接单。外部通知需另有明确授权与接收人。

告警后核实当前实例与时间，按表指派责任角色，保存安全收据；跨轮修复按 [任务跟踪](issue-tracker.md)记录影响、责任和恢复入口。修复后执行受影响范围及必要业务核验，确认后续探针恢复；自动 recovered 只代表探针恢复，问题记录由责任人复核后关闭。监测不会重启服务、换版本、修数据库、清缓存、升级依赖或建立 Issue。

## 安装与定期执行

[安装脚本](../../scripts/install-operations-monitor.ps1)默认只输出计划；-Apply 冻结脚本及策略到 C:/ProgramData/HonghaoAI/operations-monitor/versions/内容哈希，建立私有 reports 目录，注册本机五分钟巡检和每周日 04:00 现役依赖审计。任务用当前账号 S4U、有限权限，不保存密码，参见 [Microsoft LogonType](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element)。账号需批处理登录权及目录权限；不支持时由 IT 配置服务账号，不能把交互运行称为无人值守已启用。

```powershell
powershell.exe -NoProfile -File scripts/install-operations-monitor.ps1
powershell.exe -NoProfile -File scripts/install-operations-monitor.ps1 -Apply
Get-ScheduledTaskInfo -TaskName HonghaoAI-ProductionMonitor
Get-ScheduledTaskInfo -TaskName HonghaoAI-DependencyAudit
```

注册后确认两任务实际执行、报告时间更新、依赖收据匹配现役锁文件及监测文件哈希；仅注册成功不算启用完成。首次审计尚未完成时巡检提醒，下次读取新收据。系统休眠／关机期间无法采样，恢复后补执行，不称为 24×7 可用性证明。版本包和运行时在仓库外，不依赖开发工作区；正式发布后复核新模块、运行时与权限的监测兼容性。

现有 [完整工作流](../../.github/workflows/frontend-checks.yml)每周日北京时间 04:17 在 GitHub 主线跑 frontend/full、锁文件审计及合成完整恢复／回归。PR 和主线 push 同样审计依赖，审计失败和新漏洞不会被忽略或自动修补。固定使用 pip-audit 2.10.1，方法见 [官方说明](https://github.com/pypa/pip-audit)；应用依旧按 npm/uv 锁文件安装。

## 后续扩展

新增已实现模块须在 moduleChecks 声明实际可执行的监测项；[接入检查](../../scripts/check-operations-contracts.py)随所有 verifier 范围执行，缺模块、空项、未知检查和非法阈值失败。新增关键任务、异步写入或外部来源时，补实际读取、失败／积压／新鲜度判定、责任、恢复入口及合成故障验证。现役 active 模块没有实际报告不能通过。公共 health/readiness 仅覆盖实际反映的行为，审查者仍须核对业务完整性。

策略、日志格式和发布结构变化后，先跑 scripts/ci 合成负例和受影响实测，再跑统一门禁。验证覆盖备份破损、错误实例、worker 失败／静默积压、资讯过期、未知模块、漏审／过期审计、日志隐私、告警确认与恢复。监测包启用和正式程序替换分别留证，不复用历史发布授权。
