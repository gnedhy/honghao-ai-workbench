export const pinnedConversations = ["跨部门 AI 需求诊断", "个人知识整理"];

export const recentConversations = [
  "客服知识库优化",
  "部门访谈整理",
  "项目周报更新",
  "Skill 使用复盘",
];

export const runSteps = [
  { label: "材料与数据边界检查", time: "05-20 10:12", detail: "检查通过", state: "done" },
  { label: "检索个人与企业知识", time: "05-20 10:13", detail: "命中 18 条知识", state: "done" },
  { label: "调用需求诊断 Skill v1.0", time: "05-20 10:14", detail: "运行中（18s）", state: "done" },
  { label: "生成需求诊断卡", time: "运行中", detail: "", state: "active" },
  { label: "等待 ChangeSet 确认", time: "等待中", detail: "", state: "waiting" },
] as const;

export const knowledgeItems = [
  { title: "AI 需求诊断方法", scope: "个人知识", updated: "今天 10:24", tags: ["需求诊断", "方法"] },
  { title: "跨部门访谈问题清单", scope: "个人知识", updated: "昨天 17:40", tags: ["访谈", "项目"] },
  { title: "企业知识发布规范", scope: "公共知识", updated: "8 月 15 日", tags: ["制度", "审核"] },
  { title: "ChangeSet 审批边界", scope: "公共知识", updated: "8 月 14 日", tags: ["安全", "审批"] },
];

export const skills = [
  { title: "需求诊断", version: "v1.0", status: "已发布", description: "将访谈与需求材料整理为结构化诊断卡。", runs: 26 },
  { title: "项目状态更新", version: "v0.4", status: "测试中", description: "从运行记录生成项目状态与下一步建议。", runs: 8 },
  { title: "知识沉淀建议", version: "v0.2", status: "草稿", description: "从任务结果中提出个人知识候选。", runs: 3 },
];

export const tasks = [
  { title: "跨部门 AI 需求诊断", status: "等待确认", owner: "张伟", updated: "刚刚", progress: "4 / 5" },
  { title: "客服知识库优化", status: "运行中", owner: "张伟", updated: "12 分钟前", progress: "2 / 4" },
  { title: "部门访谈整理", status: "已完成", owner: "张伟", updated: "昨天", progress: "5 / 5" },
];
