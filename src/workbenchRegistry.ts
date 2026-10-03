import {ChartNoAxesCombined,Boxes,FlaskConical,BadgeDollarSign,PenLine,LibraryBig,WandSparkles,PanelsTopLeft,FolderKanban,LayoutDashboard,Database,Columns2,PackageCheck,Coins,Calculator,Sigma,FileText} from "lucide-react";
import {PROCUREMENT_PAGE_LABELS,RESEARCH_PAGE_LABELS,SALES_PAGE_LABELS,type WorkbenchId,type ProcurementPage,type ResearchPage,type SalesPage} from "./types";
export const sectionNavigation=[
 {id:"chat",label:"新聊天",description:"对话、工作模式及会话侧栏",icon:PenLine},
 {id:"knowledge",label:"知识库",description:"个人与公共知识内容",icon:LibraryBig},
 {id:"automation",label:"自动化",description:"技能与工作流管理",icon:WandSparkles},
 {id:"workbench",label:"工作台",description:"企业职能业务工具",icon:PanelsTopLeft},
 {id:"tasks",label:"任务看板",description:"任务管理与运行记录",icon:FolderKanban},
] as const;
export const workbenches = [
  {
    id: "management",
    department: "总经办",
    title: "经营数据分析",
    summary: "汇总销售、采购、成本与费用数据，形成面向经营决策的管理视图。",
    icon: ChartNoAxesCombined,
    metrics: [["本月销售额", "¥486 万", "示例汇总数据"], ["综合毛利率", "18.7%", "较上月提升 0.6%"], ["待关注事项", "3 项", "成本、回款与库存提示"]],
    columns: ["经营指标", "本月", "较上月", "管理提示"],
    rows: [["销售收入", "¥486 万", "+6.8%", "重点产品增长"], ["原料采购", "¥296 万", "+9.4%", "关注采购涨幅"], ["经营费用", "¥64 万", "-2.1%", "当前处于预算内"]],
    modules: ["销售与回款分析", "采购与成本趋势", "部门经营对比"],
    source: "销售、采购、库存及财务系统的已确认数据",
    output: "经营概览、趋势变化与待关注事项",
    owner: "总经办与各数据责任部门",
  },
  {
    id: "procurement",
    department: "采购部",
    title: "原料价格管理",
    summary: "维护原料采购价格，跟踪价格波动与历史版本。",
    icon: Boxes,
    metrics: [["跟踪原料", "18 种", "当前纳入成本基线"], ["待比价", "4 项", "需要补充有效报价"], ["本月波动", "+2.8%", "示例综合变动"]],
    columns: ["原料", "当前参考价", "较上月", "报价状态"],
    rows: [["聚合氯化铝", "¥2,180 / 吨", "+3.2%", "3 家已回价"], ["工业盐酸", "¥620 / 吨", "-1.4%", "待补 1 家"], ["液碱", "¥1,080 / 吨", "+4.6%", "2 家已回价"]],
    modules: ["供应商报价归集", "到厂成本计算", "价格波动提示"],
    source: "供应商报价、采购订单及运输费用",
    output: "经采购确认的原料成本基线",
    owner: "采购员",
  },
  {
    id: "research",
    department: "研发部",
    title: "产品成本计算",
    summary: "按最新价格与库存价格分别核算配方原料成本，计入各层收率。",
    icon: FlaskConical,
    metrics: [["在用配方", "12 个", "按当前配方版本统计"], ["测算成本", "¥6,840", "每吨示例成本"], ["待确认", "2 项", "原料或损耗参数"]],
    columns: ["成本项", "测算口径", "金额 / 吨", "占比"],
    rows: [["配方原料", "最新确认基线", "¥5,720", "83.6%"], ["能源人工", "标准工艺参数", "¥680", "9.9%"], ["包装损耗", "包装规格与损耗率", "¥440", "6.5%"]],
    modules: ["配方版本管理", "批次成本模拟", "成本差异对比"],
    source: "配方 BOM、原料成本基线及工艺参数",
    output: "供研发与财务复核的产品成本估算",
    owner: "研发工程师与财务成本会计",
  },
  {
    id: "sales",
    department: "销售部",
    title: "产品报价管理",
    summary: "查阅产品成本与报价参考，对比不同成本口径并查看价格历史。",
    icon: BadgeDollarSign,
    metrics: [["成本口径", "2 种", "最新优先与库存优先"], ["报价参考", "3 类", "直接厂、中间商与外贸"], ["价格历史", "可追溯", "保留测算参数与版本"]],
    columns: ["产品内编", "最新优先成本", "库存优先成本", "报价参考", "历史版本"],
    rows: [["示例产品 A", "4.99", "5.10", "直接厂 8.22", "2 个版本"], ["示例产品 B", "10.00", "9.80", "中间商 14.96", "3 个版本"], ["示例原料 C", "8.60", "—", "外贸 12.65", "暂无记录"]],
    modules: ["双成本与报价对比", "产品价格历史", "报价系数测算调整"],
    source: "研发产品成本、采购原料价格与报价参数",
    output: "可追溯的产品报价参考与测算记录",
    owner: "销售经理",
  },
] as const;

export type WorkbenchDefinition=(typeof workbenches)[number];
export const workbenchPages={
 procurement:[{id:"dashboard",icon:LayoutDashboard},{id:"materials",icon:Database},{id:"distribution",icon:Columns2},{id:"batches",icon:PackageCheck}],
 research:[{id:"dashboard",icon:LayoutDashboard},{id:"materials",icon:Coins},{id:"products",icon:Database},{id:"formulas",icon:Columns2},{id:"history",icon:PackageCheck}],
 sales:[{id:"dashboard",icon:LayoutDashboard},{id:"calculate",icon:Calculator},{id:"estimator",icon:Sigma},{id:"quotes",icon:FileText}],
} as const;
export const workbenchLabels={management:"总经办工作台",procurement:"采购工作台",research:"研发工作台",sales:"销售工作台"} as const;
export const workbenchSettings=workbenches.map(item=>({id:item.id,label:workbenchLabels[item.id],description:item.id==="management"?"成本经营分析":item.title}));
export function procurementNavigationPage(page:ProcurementPage) {return page==="updates"?"materials":page==="history"?"batches":page;}
export function workbenchContext(id:WorkbenchId,pages:{procurement:ProcurementPage;research:ResearchPage;sales:SalesPage}) {
 const label=id==="procurement"?PROCUREMENT_PAGE_LABELS[pages.procurement]:id==="research"?RESEARCH_PAGE_LABELS[pages.research]:id==="sales"?SALES_PAGE_LABELS[pages.sales]:null;
 return `${workbenches.find(item=>item.id===id)?.title??"工作台"}${label?` / ${label}`:""}`;
}
