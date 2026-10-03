import { WorkbenchLoading } from "../components/WorkbenchLayout";
import { CheckCircle2, ChevronRight, Database, FlaskConical, ShieldCheck,  } from "lucide-react";
import { useEffect } from "react";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import { WorkbenchModuleSlot } from "../workbenches/WorkbenchModuleSlot";
import { PROCUREMENT_PAGE_LABELS, RESEARCH_PAGE_LABELS, SALES_PAGE_LABELS, type ResearchPage, type SalesPage, type CurrentUser, type ProcurementPage, type WorkbenchId, type WorkbenchStatus } from "../types";


import {workbenches,workbenchLabels,type WorkbenchDefinition} from "../workbenchRegistry";

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

  const opened=openedWorkbenchId===selected?.id && dataState==="ready" && modes.get(selected.id)==="active"?openedWorkbenchId:null;
  const procurementOpen = opened === "procurement";

  return (
    <main className="app-main">
      <TopBar {...chrome} title={opened?workbenchLabels[opened]:"工作台"} subtitle={procurementOpen ? PROCUREMENT_PAGE_LABELS[procurementPage] : opened === "research" ? RESEARCH_PAGE_LABELS[researchPage] : opened === "sales" ? SALES_PAGE_LABELS[salesPage] : subtitle} tabs={null} contextEnabled={false} />
      <section className={`workspace-layout workspace-layout--workbench${opened ? " is-module-open" : ""}`}>
        {!opened && <aside className="workspace-list-panel workbench-index">
          <div className="workspace-panel-title">
            <div>
              <h1>职能工作台</h1>
              <p>按部门进入日常业务工具</p>
            </div>
          </div>
          <div className="workbench-list" role="list" aria-label="职能工作台">
            {dataState === "loading" && <WorkbenchState title="正在载入工作台" detail="正在确认各职能模块的运行状态。" />}
            {dataState === "error" && <div><WorkbenchState title="模块状态不可用" detail="未能读取工作台状态，请重新加载页面后重试。" /><button className="secondary-button" onClick={() => window.location.reload()}>重新加载页面</button></div>}
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
