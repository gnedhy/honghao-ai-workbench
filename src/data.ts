export const pinnedConversations = ["跨部门 AI 需求诊断", "个人知识整理"];

export const projectGroups = [
  { title: "宏昊 AI 中台", conversations: ["产品原型与交互", "模型接口验证", "首条工作流", "项目周报更新"] },
  { title: "部门需求治理", conversations: ["跨部门 AI 需求诊断", "客服知识库优化", "部门访谈整理"] },
  { title: "知识与技能", conversations: ["个人知识整理", "知识沉淀规则", "技能使用复盘"] },
];

export const initialConversationProjects = Object.fromEntries(
  projectGroups.flatMap((project) => project.conversations.map((title) => [title, project.title])),
) as Record<string, string>;

export const recentConversations = [
  "客服知识库优化",
  "部门访谈整理",
  "项目周报更新",
  "技能使用复盘",
];

export const runSteps = [
  { label: "材料与数据边界检查", time: "05-20 10:12", detail: "检查通过", state: "done" },
  { label: "检索个人与企业知识", time: "05-20 10:13", detail: "命中 18 条知识", state: "done" },
  { label: "调用需求诊断技能 v1.0", time: "05-20 10:14", detail: "运行中（18s）", state: "done" },
  { label: "生成需求诊断卡", time: "运行中", detail: "", state: "active" },
  { label: "等待修改确认", time: "等待中", detail: "", state: "waiting" },
] as const;

export const knowledgeItems = [
  { title: "AI 需求诊断方法", scope: "个人知识", updated: "今天 10:24", tags: ["需求诊断", "方法"], project: "部门需求治理" },
  { title: "跨部门访谈问题清单", scope: "个人知识", updated: "昨天 17:40", tags: ["访谈", "项目"], project: "部门需求治理" },
  { title: "企业知识发布规范", scope: "公共知识", updated: "8 月 15 日", tags: ["制度", "审核"] },
  { title: "修改确认边界", scope: "公共知识", updated: "8 月 14 日", tags: ["安全", "审批"], project: "宏昊 AI 中台" },
];

export const skills = [
  { title: "需求诊断", version: "v1.0", status: "已发布", description: "将访谈与需求材料整理为结构化诊断卡。", runs: 26 },
  { title: "项目状态更新", version: "v0.4", status: "测试中", description: "从运行记录生成项目状态与下一步建议。", runs: 8 },
  { title: "知识沉淀建议", version: "v0.2", status: "草稿", description: "从任务结果中提出个人知识候选。", runs: 3 },
];

export const workflows = [
  { title: "AI 需求诊断", version: "v1.0", status: "已发布", description: "从材料接收、知识检索到人工确认的完整诊断流程。", runs: 18, updated: "今天 10:14", owner: "AI 项目组", steps: ["接收材料", "数据边界检查", "检索知识", "调用需求诊断", "人工确认修改"] },
  { title: "部门访谈整理", version: "v0.6", status: "测试中", description: "把访谈转写整理为事实、判断、缺口和待确认事项。", runs: 7, updated: "昨天 17:32", owner: "需求治理组", steps: ["接收转写", "敏感信息检查", "提取访谈事实", "生成结构化纪要", "负责人确认"] },
  { title: "个人知识沉淀", version: "v0.3", status: "草稿", description: "从已完成任务中提取个人知识候选，并保留来源。", runs: 3, updated: "8 月 15 日", owner: "知识治理组", steps: ["选择任务结果", "提取知识候选", "来源与重复检查", "个人确认入库"] },
];

export const tasks = [
  { title: "跨部门 AI 需求诊断", status: "等待确认", owner: "张伟", updated: "刚刚", progress: "4 / 5", project: "部门需求治理" },
  { title: "客服知识库优化", status: "运行中", owner: "张伟", updated: "12 分钟前", progress: "2 / 4", project: "部门需求治理" },
  { title: "部门访谈整理", status: "已完成", owner: "张伟", updated: "昨天", progress: "5 / 5", project: "部门需求治理" },
];
