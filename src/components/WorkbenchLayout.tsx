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
