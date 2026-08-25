import { Menu, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { ModuleMode } from "../types";

export type ScreenChromeProps = {
  contextOpen: boolean;
  onOpenNavigation: () => void;
  onToggleContext: () => void;
  moduleMode: ModuleMode;
};

type TopBarProps = ScreenChromeProps & {
  title: string;
  subtitle?: string;
  tabs: ReactNode;
  action?: ReactNode;
  minimal?: boolean;
  contextEnabled?: boolean;
};

export function TopBar({
  title,
  subtitle,
  tabs,
  action,
  minimal = false,
  contextEnabled = true,
  contextOpen,
  onOpenNavigation,
  onToggleContext,
  moduleMode,
}: TopBarProps) {
  return (
    <header className={minimal ? "screen-header screen-header--minimal" : "screen-header"}>
      <div className="screen-header__identity">
        <button className="icon-button mobile-nav-trigger" type="button" onClick={onOpenNavigation} aria-label="打开导航">
          <Menu size={19} />
        </button>
        <div className="screen-header__title">
          <strong>{title}</strong>
          {(subtitle || moduleMode === "prototype") && <span>{moduleMode === "prototype" ? `功能原型 · 演示数据${subtitle ? ` · ${subtitle}` : ""}` : subtitle}</span>}
        </div>
      </div>
      <div className="screen-header__tabs">{tabs}</div>
      <div className="screen-header__actions">
        {action}
        {contextEnabled && (
          <button
            className={`icon-button context-toggle${contextOpen ? " is-context-open" : ""}`}
            type="button"
            onClick={onToggleContext}
            aria-label="打开右侧工具栏"
            aria-expanded={contextOpen}
            aria-hidden={contextOpen}
            tabIndex={contextOpen ? -1 : 0}
          >
            <PanelRightOpen size={18} />
          </button>
        )}
      </div>
    </header>
  );
}
