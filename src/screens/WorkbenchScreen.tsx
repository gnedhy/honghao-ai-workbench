import { WorkbenchLoading } from "../components/WorkbenchLayout";
import {
  BadgeDollarSign,
  Boxes,
  ChartNoAxesCombined,
  CheckCircle2,
  ChevronRight,
  Database,
  FlaskConical,
  ShieldCheck,
} from "lucide-react";
import { useEffect } from "react";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import { WorkbenchModuleSlot } from "../workbenches/WorkbenchModuleSlot";
import { PROCUREMENT_PAGE_LABELS, RESEARCH_PAGE_LABELS, SALES_PAGE_LABELS, type ResearchPage, type SalesPage, type CurrentUser, type ProcurementPage, type WorkbenchId, type WorkbenchStatus } from "../types";

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

type WorkbenchDefinition = (typeof workbenches)[number];

type WorkbenchScreenProps = ScreenChromeProps & {
  currentUser: CurrentUser;
  statuses: WorkbenchStatus[];
  dataState: "loading" | "ready" | "error";
  selectedId: WorkbenchId;
  onSelectedIdChange: (id: WorkbenchId) => void;
  openedWorkbenchId: WorkbenchId | null;
  onOpenedWorkbenchIdChange: (id: WorkbenchId | null) => void;
  salesPage: SalesPage;
  onSalesPageChange: (page: SalesPage) => void;
  researchPage: ResearchPage;
  onResearchPageChange: (page: ResearchPage) => void;
  procurementPage: ProcurementPage;
  onProcurementPageChange: (page: ProcurementPage) => void;
};

export function WorkbenchScreen({ currentUser, statuses, dataState, selectedId, onSelectedIdChange, openedWorkbenchId, onOpenedWorkbenchIdChange, procurementPage, onProcurementPageChange, salesPage, onSalesPageChange, researchPage, onResearchPageChange, ...chrome }: WorkbenchScreenProps) {
  const modes = new Map(statuses.map((status) => [status.id, status.mode]));
  const visibleWorkbenches = dataState === "ready"
    ? workbenches.filter((item) => {
        const mode = modes.get(item.id);
        return mode === "prototype" || mode === "active";
      })
    : [];
  const selected = visibleWorkbenches.find((item) => item.id === selectedId) ?? visibleWorkbenches[0] ?? null;

  useEffect(() => {
    if (selected && selected.id !== selectedId) onSelectedIdChange(selected.id);
  }, [onSelectedIdChange, selected, selectedId]);

  const subtitle = dataState === "loading"
    ? "正在读取模块状态"
    : dataState === "error"
      ? "模块状态暂不可用"
      : `${visibleWorkbenches.length} 个职能工作台`;

  const procurementOpen = openedWorkbenchId === "procurement" && selected?.id === "procurement";

  return (
    <main className="app-main">
      <TopBar {...chrome} title={procurementOpen ? "采购工作台" : openedWorkbenchId === "research" ? "研发工作台" : openedWorkbenchId === "sales" ? "销售工作台" : "工作台"} subtitle={procurementOpen ? PROCUREMENT_PAGE_LABELS[procurementPage] : openedWorkbenchId === "research" ? RESEARCH_PAGE_LABELS[researchPage] : openedWorkbenchId === "sales" ? SALES_PAGE_LABELS[salesPage] : subtitle} tabs={null} contextEnabled={false} />
      <section className={`workspace-layout workspace-layout--workbench${openedWorkbenchId ? " is-module-open" : ""}`}>
        {!openedWorkbenchId && <aside className="workspace-list-panel workbench-index">
          <div className="workspace-panel-title">
            <div>
              <h1>职能工作台</h1>
              <p>按部门进入日常业务工具</p>
            </div>
          </div>
          <div className="workbench-list" role="list" aria-label="职能工作台">
            {dataState === "loading" && <WorkbenchState title="正在载入工作台" detail="正在确认各职能模块的运行状态。" />}
            {dataState === "error" && <WorkbenchState title="模块状态不可用" detail="未连接本地服务，已停止加载真实功能。" />}
            {dataState === "ready" && visibleWorkbenches.length === 0 && <WorkbenchState title="暂无已启用模块" detail="可在服务端配置中恢复需要的职能工作台。" />}
            {dataState === "ready" && visibleWorkbenches.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={`workbench-list-item${selected.id === item.id ? " is-active" : ""}`}
                  type="button"
                  key={item.id}
                  onClick={() => onSelectedIdChange(item.id)}
                  aria-pressed={selected.id === item.id}
                >
                  <Icon size={17} />
                  <span>
                    <small>{item.department}</small>
                    <strong>{item.title}</strong>
                    <em>{item.summary}</em>
                  </span>
                  <ChevronRight size={15} />
                </button>
              );
            })}
          </div>
        </aside>}
        {dataState === "loading" ? <WorkbenchLoading /> : dataState !== "ready" || !selected
          ? <article className="workbench-detail workspace-detail-empty"><ShieldCheck size={22} /><strong>职能工作台未加载</strong></article>
          : modes.get(selected.id) === "active"
            ? <WorkbenchModuleSlot
                workbenchId={selected.id}
                title={selected.title}
                currentUser={currentUser}
                view={openedWorkbenchId === selected.id ? "full" : "preview"}
                salesPage={salesPage}
                onSalesPageChange={onSalesPageChange}
                researchPage={researchPage}
                onResearchPageChange={onResearchPageChange}
                procurementPage={procurementPage}
                onProcurementPageChange={onProcurementPageChange}
                onEnter={() => onOpenedWorkbenchIdChange(selected.id)}
              />
            : <PrototypeWorkbenchDetail selected={selected} />}
      </section>
    </main>
  );
}

function WorkbenchState({ title, detail }: { title: string; detail: string }) {
  return <div className="workspace-empty"><ShieldCheck size={20} /><strong>{title}</strong><p>{detail}</p></div>;
}

function PrototypeWorkbenchDetail({ selected }: { selected: WorkbenchDefinition }) {
  return (
    <article className="workbench-detail">
      <header className="workbench-detail__header">
        <div className="workbench-detail__eyebrow">
          <span>{selected.department}</span>
          <span>功能原型</span>
        </div>
        <h1>{selected.title}</h1>
        <p>{selected.summary}</p>
        <div className="workbench-prototype-note"><FlaskConical size={14} /><span>当前为界面与业务结构原型，页面数值均为示例数据。</span></div>
      </header>

      <div className="workbench-metrics">
        {selected.metrics.map(([label, value, note]) => (
          <div key={label}><small>{label}</small><strong>{value}</strong><span>{note}</span></div>
        ))}
      </div>

      <section className="workbench-section">
        <div className="workbench-section__heading">
          <div><span>业务视图</span><h2>{selected.title}明细</h2></div>
          <small>示例数据</small>
        </div>
        <div className="workbench-table-wrap">
          <table className="workbench-table">
            <thead><tr>{selected.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>{selected.rows.map((row) => <tr key={row[0]}>{row.map((cell, index) => <td key={`${row[0]}-${selected.columns[index]}`}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </section>

      <div className="workbench-detail-grid">
        <section className="workbench-section">
          <div className="workbench-section__heading"><div><span>功能范围</span><h2>核心模块</h2></div></div>
          <ul className="workbench-module-list">
            {selected.modules.map((module) => <li key={module}><CheckCircle2 size={15} /><span>{module}</span></li>)}
          </ul>
        </section>
        <section className="workbench-section workbench-boundary">
          <div className="workbench-section__heading"><div><span>迁移准备</span><h2>数据与确认边界</h2></div></div>
          <dl>
            <div><Database size={15} /><dt>数据来源</dt><dd>{selected.source}</dd></div>
            <div><ShieldCheck size={15} /><dt>形成结果</dt><dd>{selected.output}</dd></div>
            <div><CheckCircle2 size={15} /><dt>最终确认</dt><dd>{selected.owner}</dd></div>
          </dl>
        </section>
      </div>
    </article>
  );
}
