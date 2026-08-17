import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  FileText,
  FolderLock,
  GitBranch,
  History,
  PanelRightClose,
  Pause,
  Play,
  Rocket,
  ShieldCheck,
  Tags,
  TestTube2,
  WandSparkles,
} from "lucide-react";
import { useState } from "react";
import type { KnowledgeItem, Section, SkillItem, TaskItem } from "../types";

type ContextSidebarProps = {
  section: Section;
  open: boolean;
  onClose: () => void;
  onOpenTasks: () => void;
  onReturnChat: () => void;
  knowledgeItem: KnowledgeItem;
  skill: SkillItem;
  task: TaskItem;
};

type Feedback = { section: Section; message: string } | null;

export function ContextSidebar({
  section,
  open,
  onClose,
  onOpenTasks,
  onReturnChat,
  knowledgeItem,
  skill,
  task,
}: ContextSidebarProps) {
  const [knowledgeScope, setKnowledgeScope] = useState("个人与公共知识");
  const [model, setModel] = useState("宏昊企业模型");
  const [taskPaused, setTaskPaused] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const panelTitle = section === "chat" ? "工作设置" : section === "knowledge" ? "文档工具" : section === "automation" ? "技能工具" : "任务详情";
  const panelSubtitle = section === "chat" ? "跨部门 AI 需求诊断" : section === "knowledge" ? knowledgeItem.title : section === "automation" ? skill.title : task.title;
  const showFeedback = (message: string) => setFeedback({ section, message });

  return (
    <>
      {open && <button className="context-backdrop" type="button" aria-label="关闭右侧工具栏" onClick={onClose} />}
      <aside className={open ? "context-sidebar is-open" : "context-sidebar"} aria-hidden={!open}>
        <header className="context-sidebar__header">
          <div><span>{panelTitle}</span><strong>{panelSubtitle}</strong></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="收起右侧工具栏"><PanelRightClose size={18} /></button>
        </header>

        <div className="context-sidebar__body">
          {section === "chat" && (
            <>
              <ToolSection title="执行设置">
                <ToolSelect icon={<Database size={16} />} label="知识范围" value={knowledgeScope} onChange={setKnowledgeScope} options={["个人与公共知识", "仅个人知识", "仅本次附件"]} />
                <ToolSelect icon={<WandSparkles size={16} />} label="执行模型" value={model} onChange={setModel} options={["宏昊企业模型", "通用模型", "轻量模型"]} />
                <div className="tool-setting">
                  <span className="tool-setting__label"><FolderLock size={16} /><small>工作目录</small></span>
                  <span className="tool-setting__value"><strong>受控项目目录</strong><span><CheckCircle2 size={14} />已授权</span></span>
                </div>
              </ToolSection>
              <ToolSection title="任务控制">
                <button className="tool-action" type="button" onClick={() => { setTaskPaused((paused) => !paused); showFeedback(taskPaused ? "任务已继续执行。" : "任务已暂停，可随时继续。"); }}>
                  {taskPaused ? <Play size={16} /> : <Pause size={16} />}<span><strong>{taskPaused ? "继续任务" : "暂停任务"}</strong><small>保留当前检查点</small></span>
                </button>
                <button className="tool-action" type="button" onClick={onOpenTasks}><History size={16} /><span><strong>打开任务看板</strong><small>查看运行与审批记录</small></span></button>
              </ToolSection>
              <div className="tool-safety-note"><ShieldCheck size={16} /><p>任何文件写入都会先生成 ChangeSet，并等待你的确认。</p></div>
            </>
          )}

          {section === "knowledge" && (
            <>
              <ToolSection title="文档操作">
                <button className="tool-action" type="button" onClick={() => showFeedback("Markdown 导出已准备。原型阶段不会写入本地文件。")}><Download size={16} /><span><strong>导出 Markdown</strong><small>保留正文与来源信息</small></span></button>
                <button className="tool-action" type="button" onClick={() => showFeedback("已生成公共知识候选，等待独立发布确认。")}><Rocket size={16} /><span><strong>提交公共知识候选</strong><small>不会直接发布</small></span></button>
              </ToolSection>
              <ToolSection title="文档属性">
                <PropertyRow icon={<FileText size={16} />} label="空间" value={knowledgeItem.scope} />
                <PropertyRow icon={<History size={16} />} label="最后更新" value={knowledgeItem.updated} />
                <PropertyRow icon={<Tags size={16} />} label="标签" value={knowledgeItem.tags.join("、")} />
                <PropertyRow icon={<ShieldCheck size={16} />} label="来源" value="可追溯" />
              </ToolSection>
            </>
          )}

          {section === "automation" && (
            <>
              <ToolSection title="版本操作">
                <button className="tool-action" type="button" onClick={() => showFeedback("测试通过：已生成样本输出，未触发写入。")}><TestTube2 size={16} /><span><strong>运行测试</strong><small>使用当前样本输入</small></span></button>
                <button className="tool-action" type="button" onClick={() => showFeedback(`已从 ${skill.version} 创建草稿版本。`)}><GitBranch size={16} /><span><strong>创建新版本</strong><small>从当前版本复制</small></span></button>
                <button className="tool-action" type="button" onClick={() => showFeedback("发布检查已启动，需要代码与数据审查通过。")}><Rocket size={16} /><span><strong>提交发布检查</strong><small>进入审查流程</small></span></button>
              </ToolSection>
              <ToolSection title="当前版本">
                <PropertyRow icon={<WandSparkles size={16} />} label="版本" value={skill.version} />
                <PropertyRow icon={<CheckCircle2 size={16} />} label="状态" value={skill.status} />
                <PropertyRow icon={<History size={16} />} label="运行" value={`${skill.runs} 次`} />
                <PropertyRow icon={<ShieldCheck size={16} />} label="发布范围" value="AI 团队" />
              </ToolSection>
            </>
          )}

          {section === "tasks" && (
            <>
              <ToolSection title="执行详情">
                <PropertyRow icon={<History size={16} />} label="当前运行" value="RUN-003" />
                <PropertyRow icon={<WandSparkles size={16} />} label="使用技能" value="需求诊断 v1.0" />
                <PropertyRow icon={<CheckCircle2 size={16} />} label="检查点" value={task.status} />
                <PropertyRow icon={<FolderLock size={16} />} label="工作目录" value="受控目录" />
              </ToolSection>
              <ToolSection title="任务操作">
                <button className="tool-action" type="button" onClick={onReturnChat}><ArrowLeft size={16} /><span><strong>返回来源会话</strong><small>{task.title}</small></span></button>
                <button className="tool-action" type="button" onClick={() => { setTaskPaused((paused) => !paused); showFeedback(taskPaused ? "任务已恢复。" : "任务已暂停在当前检查点。"); }}>
                  {taskPaused ? <Play size={16} /> : <Pause size={16} />}<span><strong>{taskPaused ? "恢复任务" : "暂停任务"}</strong><small>不会丢失当前进度</small></span>
                </button>
              </ToolSection>
            </>
          )}

          {feedback?.section === section && <p className="tool-feedback"><CheckCircle2 size={15} />{feedback.message}</p>}
        </div>
      </aside>
    </>
  );
}

function ToolSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="tool-section"><h2>{title}</h2><div>{children}</div></section>;
}

function ToolSelect({ icon, label, value, options, onChange }: { icon: React.ReactNode; label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="tool-select">
      <span className="tool-select__label">{icon}<small>{label}</small></span>
      <span className="tool-select__control">
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select>
        <ChevronDown size={15} />
      </span>
    </label>
  );
}

function PropertyRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="tool-property">{icon}<span><small>{label}</small><strong>{value}</strong></span></div>;
}
