import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import type { CurrentUser, ProcurementPage, WorkbenchId } from "../types";

const ProcurementWorkbench = lazy(() => import("./ProcurementWorkbench").then((module) => ({ default: module.ProcurementWorkbench })));

type Props = {
  workbenchId: WorkbenchId;
  title: string;
  currentUser: CurrentUser;
  view: "preview" | "full";
  procurementPage: ProcurementPage;
  onProcurementPageChange: (page: ProcurementPage) => void;
  onEnter: () => void;
};

export function WorkbenchModuleSlot(props: Props) {
  const accessLevel = props.currentUser.is_system_admin ? 4 : props.currentUser.scope_levels[props.workbenchId] ?? 0;
  return (
    <ModuleBoundary title={props.title}>
      {props.workbenchId === "procurement"
        ? <Suspense fallback={<Loading title={props.title} />}><ProcurementWorkbench accessLevel={accessLevel} view={props.view} page={props.procurementPage} onPageChange={props.onProcurementPageChange} onEnter={props.onEnter} /></Suspense>
        : <Pending title={props.title} />}
    </ModuleBoundary>
  );
}

function Loading({ title }: { title: string }) {
  return <article className="workbench-detail workspace-detail-empty"><strong>正在加载{title}</strong></article>;
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
