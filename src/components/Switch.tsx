import type { ButtonHTMLAttributes } from "react";

/** Controlled: the caller decides when a confirmed change actually takes effect. */
export function Switch({ children, className = "settings-mode-switch", disabled, busy = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button type="button" role="switch" {...props} className={className} disabled={disabled || busy} aria-busy={busy || undefined}>{children ?? <span/>}</button>;
}
