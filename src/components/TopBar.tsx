import { Menu, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";

export type ScreenChromeProps = {
  contextOpen: boolean;
  onOpenNavigation: () => void;
  onToggleContext: () => void;
};

type TopBarProps = ScreenChromeProps & {
  title: string;
  subtitle?: string;
  tabs: ReactNode;
  action?: ReactNode;
};

export function TopBar({
  title,
  subtitle,
  tabs,
  action,
  contextOpen,
  onOpenNavigation,
  onToggleContext,
}: TopBarProps) {
  return (
    <header className="screen-header">
      <div className="screen-header__identity">
        <button className="icon-button mobile-nav-trigger" type="button" onClick={onOpenNavigation} aria-label="打开导航">
          <Menu size={19} />
        </button>
        <div className="screen-header__title">
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
      </div>
      <div className="screen-header__tabs">{tabs}</div>
      <div className="screen-header__actions">
        {action}
        <button
          className={contextOpen ? "icon-button context-toggle is-active" : "icon-button context-toggle"}
          type="button"
          onClick={onToggleContext}
          aria-label={contextOpen ? "收起右侧工具栏" : "打开右侧工具栏"}
          aria-expanded={contextOpen}
        >
          {contextOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
      </div>
    </header>
  );
}
