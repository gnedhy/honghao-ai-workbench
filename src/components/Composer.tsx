import { ArrowUp, Check, ChevronDown, FilePlus2, FolderClosed, ListChecks, Plus, Route, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { skills } from "../data";

const chatWorkflows = ["AI 需求诊断工作流", "项目状态更新工作流"];

type ComposerProps = {
  compact?: boolean;
  empty?: boolean;
  mode?: "聊天" | "工作";
  onSubmit?: (message: string) => void;
};

export function Composer({ compact = false, empty = false, mode = "工作", onSubmit }: ComposerProps) {
  const [message, setMessage] = useState("");
  const [project, setProject] = useState<string | null>("宏昊 AI 中台");
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [planningMode, setPlanningMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const compactComposerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chatMenuOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!compactComposerRef.current?.contains(event.target as Node)) setChatMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChatMenuOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [chatMenuOpen]);

  const submit = () => {
    if (!message.trim()) return;
    onSubmit?.(message.trim());
    setMessage("");
  };

  if (compact) {
    return (
      <div className={`composer composer--compact${empty ? " composer--empty" : ""}`} ref={compactComposerRef}>
        {chatMenuOpen && (
          <div className="composer__add-menu" role="menu" aria-label="添加与调用">
            <button
              className="composer__menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setChatMenuOpen(false);
                fileInputRef.current?.click();
              }}
            >
              <FilePlus2 size={15} />
              <span>添加文件</span>
            </button>
            <button
              className="composer__menu-item"
              type="button"
              role="menuitemcheckbox"
              aria-checked={planningMode}
              onClick={() => {
                setPlanningMode((value) => !value);
                setChatMenuOpen(false);
              }}
            >
              <ListChecks size={15} />
              <span>计划模式</span>
              {planningMode && <Check className="composer__menu-check" size={14} />}
            </button>

            <div className="composer__menu-divider" role="separator" />
            <div className="composer__menu-section" aria-label="技能列表">
              <span className="composer__menu-label">技能</span>
              {skills.map((skill) => (
                <button className="composer__menu-item composer__menu-item--nested" type="button" role="menuitem" key={skill.title} onClick={() => setChatMenuOpen(false)}>
                  <WandSparkles size={14} />
                  <span>{skill.title}</span>
                </button>
              ))}
            </div>

            <div className="composer__menu-divider" role="separator" />
            <div className="composer__menu-section" aria-label="工作流列表">
              <span className="composer__menu-label">工作流</span>
              {chatWorkflows.map((workflow) => (
                <button className="composer__menu-item composer__menu-item--nested" type="button" role="menuitem" key={workflow} onClick={() => setChatMenuOpen(false)}>
                  <Route size={14} />
                  <span>{workflow}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="composer__compact-row">
          <button
            className={`icon-button composer__add-trigger${planningMode ? " is-planning" : ""}`}
            type="button"
            aria-label="打开添加菜单"
            aria-haspopup="menu"
            aria-expanded={chatMenuOpen}
            onClick={() => setChatMenuOpen((value) => !value)}
          >
            <Plus size={18} />
          </button>
          <input className="composer__file-input" ref={fileInputRef} type="file" aria-label="选择文件" onChange={() => setChatMenuOpen(false)} />
          <textarea
            aria-label="输入聊天消息"
            placeholder="向宏昊 AI 发送消息"
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button className="composer__model" type="button">企业模型<ChevronDown size={13} /></button>
          <button className="round-action composer__submit" type="button" aria-label="发送消息" onClick={submit} disabled={!message.trim()}>
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`composer${empty ? " composer--empty composer--work-empty" : ""}`}>
      <textarea
        aria-label={mode === "工作" ? "输入工作要求" : "输入聊天消息"}
        placeholder={mode === "工作" ? "补充信息，或输入下一步要求…" : "向宏昊 AI 发送消息"}
        rows={2}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__toolbar">
        <div className="composer__tools">
          <button className="icon-button" type="button" aria-label="添加内容"><Plus size={18} /></button>
          {mode === "工作" && (project ? (
            <button
              className="composer__project composer__project--selected"
              type="button"
              aria-label={`移除项目：${project}`}
              title="移除项目"
              onClick={() => setProject(null)}
            >
              <span className="composer__project-icon" aria-hidden="true">
                <span className="project-mark project-mark--1 composer__project-icon-default"><FolderClosed size={14} /></span>
                <span className="composer__project-icon-remove"><X size={10} /></span>
              </span>
              <span>{project}</span>
            </button>
          ) : (
            <button
              className="composer__project composer__project--empty"
              type="button"
              aria-label="选择项目"
              onClick={() => setProject("宏昊 AI 中台")}
            >
              <FolderClosed size={14} />
              <span>选择项目</span>
            </button>
          ))}
        </div>
        <button className="round-action composer__submit" type="button" aria-label="交给智能体执行" onClick={submit} disabled={!message.trim()}>
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}
