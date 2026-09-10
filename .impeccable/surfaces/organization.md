# 用户管理组织结构

- primaryTarget: src/components/OrganizationControls.tsx
- relatedTargets: src/components/OrganizationControls.css, src/components/SettingsDialog.tsx, src/components/ProfileDialog.tsx
- evolve / operate / medium；视觉权威为当前SettingsDialog及用户确认的A紧凑树形。
- approvedPlan: .impeccable/mocks/settings/20260910-organization/index.html，用户原文“A可以的，没问题”。不再比较B。
- 使用人员：系统管理员配置组织与账号归属；普通员工只读查看本人资料，姓名与部门均在用户管理维护。
- 部门标题与人员缩进构成层级，无连接线；浅灰选中，黑色按钮。父部门人数包含下级并去重；列表总数按账号去重；兼属标识不代表新增账号。
- 部门维护表单在右侧，不层叠编辑弹窗；删除确认复用系统设置原有原生dialog。资料表单取消直接撤销，切换对象保护草稿。
- 窄屏变为目录在上、详情在下；深层缩进、长名字截断及完整title，字段路径允许换行；菜单提供键盘焦点和Esc局部关闭，减少动态支持保持。
- 保持现有账号ID、密码、权限、业务历史快照；组织数据独立于采购业务部门。
- 候选真实数据链路和桌面/390px截图位于output/organization-candidate；非正式用户变更数据。正式验收见本轮review manifest。
- 无全局视觉规则变更，不新增组件库或依赖。
- 当次组织发布的历史检查：独立代码与四张截图终审、40项目标回归、260项完整后端、26项前端、候选真实链路及正式旧表一致性检查通过。该证据不覆盖后续界面改动；本轮收尾见 [提交准备](../../docs/提交准备-2026-09-10.md)。
