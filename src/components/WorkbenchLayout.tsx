import { LoaderCircle } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import styles from "./WorkbenchSurface.module.css";

export function LedgerFrame({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`${styles.ledgerTableFrame} ${className}`}/>;
}
export function LedgerToolbar({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`${styles.toolbar} ${className}`}/>;
}
export function DashboardPanel({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} className={`${styles.dashboardPanel} ${className}`}/>;
}
export function FormFooter({ status, children, className = "" }: { status: ReactNode; children: ReactNode; className?: string }) {
  return <footer className={`ui-form-footer ${className}`}><div className="ui-form-footer__status">{status}</div><div className="ui-form-footer__actions">{children}</div></footer>;
}
export function PageState({ children, error = false, className = "", onRetry }: { children: ReactNode; error?: boolean; className?: string; onRetry?: () => void }) {
  return <div role={error ? "alert" : "status"} className={className}>{children}{onRetry && <button type="button" className="secondary-button" onClick={onRetry}>重试</button>}</div>;
}

export function WorkbenchLoading({ title = "正在加载工作台", local = false }: { title?: string; local?: boolean }) {
  return <PageState className={local ? "workspace-detail-empty" : "workbench-detail workspace-detail-empty"}><LoaderCircle className={styles.loadingSpinner} size={26} aria-hidden="true"/><strong>{title}</strong><p>数据加载中，请稍候…</p></PageState>;
}
