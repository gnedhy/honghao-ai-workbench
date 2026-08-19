import { ArrowUp, Check, ChevronDown, FilePlus2, FolderClosed, LibraryBig, ListChecks, Plus, Route, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { skills } from "../data";
import type { Project } from "../types";

const workWorkflows = ["AI 需求诊断工作流", "项目状态更新工作流"];

type ComposerProps = {
  compact?: boolean;
  empty?: boolean;
  mode?: "聊天" | "工作";
  onSubmit?: (message: string, requestId: string) => Promise<boolean>;
  projects?: Project[];
  projectId?: string | null;
  onProjectChange?: (projectId: string | null) => void;
};

export function Composer({ compact = false, empty = false, mode = "工作", onSubmit, projects = [], projectId = null, onProjectChange }: ComposerProps) {
  const [message, setMessage] = useState("");
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [workMenuOpen, setWorkMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [knowledgeContextEnabled, setKnowledgeContextEnabled] = useState(false);
  const [planningMode, setPlanningMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submissionIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChatMenuOpen(false);
    setWorkMenuOpen(false);
    setProjectMenuOpen(false);
  }, [compact, mode]);

  useEffect(() => {
    if (!chatMenuOpen && !workMenuOpen && !projectMenuOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setChatMenuOpen(false);
        setWorkMenuOpen(false);
        setProjectMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setChatMenuOpen(false);
        setWorkMenuOpen(false);
        setProjectMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [chatMenuOpen, projectMenuOpen, workMenuOpen]);

  const submit = async () => {
    const content = message.trim();
    if (!content || submittingRef.current) return;
    const requestId = submissionIdRef.current ?? crypto.randomUUID();
    submissionIdRef.current = requestId;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const accepted = await onSubmit?.(content, requestId) ?? true;
      if (accepted) {
        setMessage("");
        submissionIdRef.current = null;
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (compact) {
    return (
      <div className={`composer composer--compact${empty ? " composer--empty" : ""}`} ref={composerRef}>
        {chatMenuOpen && (
          <div className="composer__add-menu composer__add-menu--chat" role="menu" aria-label="聊天添加菜单">
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
              aria-checked={knowledgeContextEnabled}
              onClick={() => {
                setKnowledgeContextEnabled((value) => !value);
                setChatMenuOpen(false);
              }}
            >
              <LibraryBig size={15} />
              <span>引用知识库</span>
              {knowledgeContextEnabled && <Check className="composer__menu-check" size={14} />}
            </button>
          </div>
        )}
        <div className="composer__compact-row">
          <button
            className="icon-button"
            type="button"
            aria-label="打开聊天添加菜单"
            aria-haspopup="menu"
            aria-expanded={chatMenuOpen}
            onClick={() => setChatMenuOpen((value) => !value)}
          >
            <Plus size={18} />
          </button>
          {knowledgeContextEnabled && (
            <button
              className="composer__context-control"
              type="button"
              aria-label="关闭知识库引用"
              aria-pressed="true"
              title="关闭知识库引用"
              onClick={() => setKnowledgeContextEnabled(false)}
            >
              <span className="composer__context-icon" aria-hidden="true">
                <span className="composer__context-icon-default"><LibraryBig size={14} /></span>
                <span className="composer__context-icon-remove"><X size={10} /></span>
              </span>
              <span>知识库</span>
            </button>
          )}
          <input className="composer__file-input" ref={fileInputRef} type="file" aria-label="选择文件" />
          <textarea
            aria-label="输入聊天消息"
            placeholder="向宏昊 AI 发送消息"
            rows={1}
            value={message}
            disabled={submitting}
            onChange={(event) => {
              setMessage(event.target.value);
              submissionIdRef.current = null;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button className="composer__model" type="button">企业模型<ChevronDown size={13} /></button>
          <button className="round-action composer__submit" type="button" aria-label="发送消息" aria-busy={submitting} onClick={() => { void submit(); }} disabled={submitting || !message.trim()}>
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    );
  }

  const projectIndex = projects.findIndex((item) => item.id === projectId);
  const project = projectIndex >= 0 ? projects[projectIndex] : null;

  return (
    <div className={`composer${empty ? " composer--empty composer--work-empty" : ""}`} ref={composerRef}>
      {workMenuOpen && (
        <div className="composer__add-menu" role="menu" aria-label="工作工具">
          <button
            className="composer__menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              setWorkMenuOpen(false);
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
            aria-checked={knowledgeContextEnabled}
            onClick={() => {
              setKnowledgeContextEnabled((value) => !value);
              setWorkMenuOpen(false);
            }}
          >
            <LibraryBig size={15} />
            <span>引用知识库</span>
            {knowledgeContextEnabled && <Check className="composer__menu-check" size={14} />}
          </button>
          <button
            className="composer__menu-item"
            type="button"
            role="menuitemcheckbox"
            aria-checked={planningMode}
            onClick={() => {
              setPlanningMode((value) => !value);
              setWorkMenuOpen(false);
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
              <button className="composer__menu-item composer__menu-item--nested" type="button" role="menuitem" key={skill.title} onClick={() => setWorkMenuOpen(false)}>
                <WandSparkles size={14} />
                <span>{skill.title}</span>
              </button>
            ))}
          </div>

          <div className="composer__menu-divider" role="separator" />
          <div className="composer__menu-section" aria-label="工作流列表">
            <span className="composer__menu-label">工作流</span>
            {workWorkflows.map((workflow) => (
              <button className="composer__menu-item composer__menu-item--nested" type="button" role="menuitem" key={workflow} onClick={() => setWorkMenuOpen(false)}>
                <Route size={14} />
                <span>{workflow}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <input className="composer__file-input" ref={fileInputRef} type="file" aria-label="选择文件" />
      <textarea
        aria-label={mode === "工作" ? "输入工作要求" : "输入聊天消息"}
        placeholder={mode === "工作" ? "补充信息，或输入下一步要求…" : "向宏昊 AI 发送消息"}
        rows={2}
        value={message}
        disabled={submitting}
        onChange={(event) => {
          setMessage(event.target.value);
          submissionIdRef.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer__toolbar">
        <div className="composer__tools">
          <button
            className="icon-button composer__add-trigger"
            type="button"
            aria-label="打开工作工具菜单"
            aria-haspopup="menu"
            aria-expanded={workMenuOpen}
            onClick={() => {
              setProjectMenuOpen(false);
              setWorkMenuOpen((value) => !value);
            }}
          >
            <Plus size={18} />
          </button>
          {mode === "工作" && (project ? (
            <button
              className="composer__project composer__project--selected"
              type="button"
              aria-label={`移除项目：${project.title}`}
              title="移除项目"
              onClick={() => onProjectChange?.(null)}
            >
              <span className="composer__project-icon" aria-hidden="true">
                <span className={`project-mark project-mark--${(projectIndex % 3) + 1} composer__project-icon-default`}><FolderClosed size={14} /></span>
                <span className="composer__project-icon-remove"><X size={10} /></span>
              </span>
              <span>{project.title}</span>
            </button>
          ) : (
            <div className="composer__project-picker">
              <button
                className="composer__project composer__project--empty"
                type="button"
                aria-label="选择项目"
                aria-haspopup="menu"
                aria-expanded={projectMenuOpen}
                onClick={() => {
                  setWorkMenuOpen(false);
                  setProjectMenuOpen((value) => !value);
                }}
              >
                <FolderClosed size={14} />
                <span>选择项目</span>
              </button>
              {projectMenuOpen && (
                <div className="composer__project-menu" role="menu" aria-label="选择项目">
                  <span className="composer__menu-label">项目上下文</span>
                  {projects.length === 0 && <span className="composer__menu-empty">暂无可选项目</span>}
                  {projects.map((item, index) => (
                    <button
                      className="composer__project-option"
                      type="button"
                      role="menuitem"
                      key={item.id}
                      onClick={() => {
                        onProjectChange?.(item.id);
                        setProjectMenuOpen(false);
                      }}
                    >
                      <span className={`project-mark project-mark--${(index % 3) + 1}`}><FolderClosed size={14} /></span>
                      <span>{item.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {knowledgeContextEnabled && (
            <button
              className="composer__context-control"
              type="button"
              aria-label="关闭知识库引用"
              aria-pressed="true"
              title="关闭知识库引用"
              onClick={() => setKnowledgeContextEnabled(false)}
            >
              <span className="composer__context-icon" aria-hidden="true">
                <span className="composer__context-icon-default"><LibraryBig size={14} /></span>
                <span className="composer__context-icon-remove"><X size={10} /></span>
              </span>
              <span>知识库</span>
            </button>
          )}
          {planningMode && (
            <button
              className="composer__context-control"
              type="button"
              aria-label="关闭计划模式"
              aria-pressed="true"
              title="关闭计划模式"
              onClick={() => setPlanningMode(false)}
            >
              <span className="composer__context-icon" aria-hidden="true">
                <span className="composer__context-icon-default"><ListChecks size={14} /></span>
                <span className="composer__context-icon-remove"><X size={10} /></span>
              </span>
              <span>计划模式</span>
            </button>
          )}
        </div>
        <button className="round-action composer__submit" type="button" aria-label="交给智能体执行" aria-busy={submitting} onClick={() => { void submit(); }} disabled={submitting || !message.trim()}>
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}
