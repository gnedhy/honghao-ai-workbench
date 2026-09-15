import { WorkbenchLoading } from "../components/WorkbenchLayout";
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import type { CurrentUser, ResearchPage, ProcurementPage, WorkbenchId } from "../types";

const ProcurementWorkbench = lazy(() => import("./ProcurementWorkbench").then((module) => ({ default: module.ProcurementWorkbench })));

const ResearchWorkbench = lazy(() => import("./ResearchWorkbench").then(module => ({ default: module.ResearchWorkbench })));

type Props = {
  workbenchId: WorkbenchId;
  title: string;
  currentUser: CurrentUser;
  view: "preview" | "full";
  researchPage: ResearchPage;
  onResearchPageChange: (page: ResearchPage) => void;
  procurementPage: ProcurementPage;
  onProcurementPageChange: (page: ProcurementPage) => void;
  onEnter: () => void;
};

export function WorkbenchModuleSlot(props: Props) {
  const accessLevel = props.currentUser.is_system_admin ? 4 : props.currentUser.scope_levels[props.workbenchId] ?? 0;
  return (
    <ModuleBoundary title={props.title}>
      {props.workbenchId === "procurement"
        ? <Suspense fallback={<WorkbenchLoading title={`正在加载${props.title}`} />}><ProcurementWorkbench accessLevel={accessLevel} view={props.view} page={props.procurementPage} onPageChange={props.onProcurementPageChange} onEnter={props.onEnter} /></Suspense>
        : props.workbenchId === "research" ? <Suspense fallback={<WorkbenchLoading title={`正在加载${props.title}`} />}><ResearchWorkbench accessLevel={accessLevel} userId={props.currentUser.id} view={props.view} page={props.researchPage} onPageChange={props.onResearchPageChange} onEnter={props.onEnter} /></Suspense> : <Pending title={props.title} />}
    </ModuleBoundary>
  );
}

function Pending({ title }: { title: string }) {
  return (
    <article className="workbench-detail workspace-detail-empty">
      <ShieldCheck size={24} />
      <strong>{title}已进入受保护接入状态</strong>
      <p>真实模块尚未注册，当前不会展示示例数据或执行正式写入。</p>
    </article>
  );
}

class ModuleBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Workbench module failed", error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <Pending title={`${this.props.title}加载失败`} />;
  }
}
