import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  FileText,
  FolderClosed,
  FolderLock,
  GitBranch,
  History,
  PanelRightClose,
  Play,
  Rocket,
  ShieldCheck,
  Tags,
  TestTube2,
  WandSparkles,
} from "lucide-react";
import { useState } from "react";
import { taskStatusLabel } from "../taskPresentation";
import type { KnowledgeItem, Section, SkillItem, TaskItem, WorkflowItem } from "../types";

type ContextSidebarProps = {
  section: Section;
  conversationTitle: string;
  conversationMode: "聊天" | "工作";
  conversationView: "new" | "existing";
  projectTitle: string | null;
  automationTab: "技能" | "工作流";
  open: boolean;
  closing: boolean;
  onClose: () => void;
  onReturnChat: () => void;
  knowledgeItem: KnowledgeItem;
  skill: SkillItem;
  workflow: WorkflowItem;
  task: TaskItem | null;
  conversationTask: TaskItem | null;
};

type Feedback = { section: Section; message: string } | null;

export function ContextSidebar({
  section,
  conversationTitle,
  conversationMode,
  conversationView,
  projectTitle,
  automationTab,
  open,
  closing,
  onClose,
  onReturnChat,
  knowledgeItem,
  skill,
  workflow,
  task,
  conversationTask,
}: ContextSidebarProps) {
  const [knowledgeScope, setKnowledgeScope] = useState("个人与公共知识");
  const [model, setModel] = useState("宏昊企业模型");
  const [feedback, setFeedback] = useState<Feedback>(null);

  const panelTitle = section === "chat" ? (conversationMode === "聊天" ? "对话上下文" : "执行控制") : section === "knowledge" ? "文档工具" : section === "automation" ? (automationTab === "技能" ? "技能工具" : "工作流工具") : "任务详情";
  const panelSubtitle = section === "chat" ? conversationTitle : section === "knowledge" ? knowledgeItem.title : section === "automation" ? (automationTab === "技能" ? skill.title : workflow.title) : task?.objective ?? "未选择任务";
  const showFeedback = (message: string) => setFeedback({ section, message });

  return (
    <>
      {open && <button className={closing ? "context-backdrop is-closing" : "context-backdrop"} type="button" aria-label="关闭右侧工具栏" onClick={onClose} />}
      <aside className={`context-sidebar${open ? " is-open" : ""}${closing ? " is-closing" : ""}`} aria-hidden={!open}>
        <header className="context-sidebar__header">
          <div><span>{panelTitle}</span><strong>{panelSubtitle}</strong></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="收起右侧工具栏"><PanelRightClose size={18} /></button>
        </header>

        <div className="context-sidebar__body">
          {section === "chat" && (
            <>
              {conversationMode === "聊天" ? (
                <>
                  <ToolSection title="本次上下文">
                    <PropertyRow icon={<FolderClosed size={16} />} label="关联项目" value={conversationView === "existing" ? projectTitle ?? "未关联" : "未关联"} />
                    <PropertyRow icon={<Database size={16} />} label="知识访问" value="按需引用" />
                    <PropertyRow icon={<FileText size={16} />} label="当前引用" value={conversationView === "existing" ? "2 条知识" : "暂无"} />
                    <PropertyRow icon={<FolderLock size={16} />} label="本次附件" value={conversationView === "existing" ? "1 个 · 仅当前会话" : "暂无"} />
                  </ToolSection>
                  <ToolSection title="对话边界">
                    <PropertyRow icon={<ShieldCheck size={16} />} label="会话类型" value={conversationView === "existing" && projectTitle ? "项目上下文" : "个人对话"} />
                    <PropertyRow icon={<FolderLock size={16} />} label="写入权限" value="关闭" />
                    <PropertyRow icon={<CheckCircle2 size={16} />} label="知识沉淀" value={conversationView === "existing" ? "确认后保存" : "尚未启用"} />
                  </ToolSection>
                  <div className="tool-safety-note"><ShieldCheck size={16} /><p>对话模式只读取你主动引用的内容，不会执行文件写入或启动任务。</p></div>
                </>
              ) : (
                <>
                  <ToolSection title="执行环境">
                    <PropertyRow icon={<FolderClosed size={16} />} label="项目上下文" value={projectTitle ?? "未选择"} />
                    <ToolSelect icon={<Database size={16} />} label="知识范围" value={knowledgeScope} onChange={setKnowledgeScope} options={["个人与公共知识", "仅个人知识", "仅本次附件"]} />
                    <ToolSelect icon={<WandSparkles size={16} />} label="执行模型" value={model} onChange={setModel} options={["宏昊企业模型", "通用模型", "轻量模型"]} />
                    <div className="tool-setting">
                      <span className="tool-setting__label"><FolderLock size={16} /><small>工作目录</small></span>
                      <span className="tool-setting__value"><strong>{projectTitle ? "项目受控目录" : "临时受控目录"}</strong><span><CheckCircle2 size={14} />已授权</span></span>
                    </div>
                  </ToolSection>
                  {conversationView === "existing" && conversationTask ? (
                    <ToolSection title="当前任务">
                      <PropertyRow icon={<CheckCircle2 size={16} />} label="任务状态" value={taskStatusLabel(conversationTask.status)} />
                      <PropertyRow icon={<History size={16} />} label="最近运行" value={conversationTask.latest_run ?? "尚未运行"} />
                      <PropertyRow icon={<FolderClosed size={16} />} label="项目快照" value={conversationTask.project_id ? "创建时已记录" : "未关联"} />
                    </ToolSection>
                  ) : (
                    <ToolSection title="执行边界">
                      <PropertyRow icon={<FileText size={16} />} label="文件写入" value="需人工确认" />
                      <PropertyRow icon={<ShieldCheck size={16} />} label="外部操作" value="默认禁止" />
                    </ToolSection>
                  )}
                  <div className="tool-safety-note"><ShieldCheck size={16} /><p>项目只提供本次工作的上下文与受控目录。任何写入仍会先生成修改预览，并等待你的确认。</p></div>
                </>
              )}
            </>
          )}

          {section === "knowledge" && (
            <KnowledgeStatusTools item={knowledgeItem} onFeedback={showFeedback} />
          )}

          {section === "automation" && (
            automationTab === "技能"
              ? <SkillStatusTools skill={skill} onFeedback={showFeedback} />
              : <WorkflowStatusTools workflow={workflow} onFeedback={showFeedback} />
          )}

          {section === "tasks" && (task
            ? <TaskStatusTools task={task} onReturnChat={onReturnChat} />
            : <div className="tool-safety-note"><History size={16} /><p>选择一个任务后，这里会显示它的来源与项目快照。</p></div>
          )}

          {feedback?.section === section && <p className="tool-feedback"><CheckCircle2 size={15} />{feedback.message}</p>}
        </div>
      </aside>
    </>
  );
}

type StatusAction = { icon: React.ReactNode; title: string; subtitle: string; feedback?: string; onSelect?: () => void };
type StatusProperty = { icon: React.ReactNode; label: string; value: string };

function StatusToolLayout({ actionTitle, actions, infoTitle, properties, note, onFeedback }: { actionTitle: string; actions: StatusAction[]; infoTitle: string; properties: StatusProperty[]; note: string; onFeedback: (message: string) => void }) {
  return <>
    <ToolSection title={actionTitle}>{actions.map((action) => <button className="tool-action" type="button" key={action.title} onClick={() => action.onSelect ? action.onSelect() : onFeedback(action.feedback ?? "")}>{action.icon}<span><strong>{action.title}</strong><small>{action.subtitle}</small></span></button>)}</ToolSection>
    <ToolSection title={infoTitle}>{properties.map((property) => <PropertyRow icon={property.icon} label={property.label} value={property.value} key={property.label} />)}</ToolSection>
    <div className="tool-safety-note"><ShieldCheck size={16} /><p>{note}</p></div>
  </>;
}

function KnowledgeStatusTools({ item, onFeedback }: { item: KnowledgeItem; onFeedback: (message: string) => void }) {
  if (item.scope === "公共知识") return <StatusToolLayout actionTitle="公共知识操作" actions={[
    { icon: <FileText size={16} />, title: "复制到个人库", subtitle: "基于发布版本创建个人副本", feedback: "已创建个人知识副本，公共版本保持不变。" },
    { icon: <History size={16} />, title: "查看版本记录", subtitle: "审查发布人与变更说明", feedback: "已打开公共知识版本记录。" },
    { icon: <Download size={16} />, title: "导出 Markdown", subtitle: "保留正文与来源信息", feedback: "Markdown 导出已准备。" },
  ]} infoTitle="发布属性" properties={[
    { icon: <FileText size={16} />, label: "空间", value: "公共知识库" },
    ...(item.project ? [{ icon: <FolderClosed size={16} />, label: "关联项目", value: item.project }] : []),
    { icon: <CheckCircle2 size={16} />, label: "状态", value: "已发布 · 只读" },
    { icon: <History size={16} />, label: "最后更新", value: item.updated },
    { icon: <ShieldCheck size={16} />, label: "来源", value: "已审查 · 可追溯" },
  ]} note="公共知识不能在阅读页直接修改。更新必须创建候选版本，并重新经过内容与权限审查。" onFeedback={onFeedback} />;

  return <StatusToolLayout actionTitle="个人知识操作" actions={[
    { icon: <Download size={16} />, title: "导出 Markdown", subtitle: "保留正文与来源信息", feedback: "Markdown 导出已准备。原型阶段不会写入本地文件。" },
    { icon: <Rocket size={16} />, title: "提交公共知识候选", subtitle: "进入独立审查，不会直接发布", feedback: "已生成公共知识候选，等待独立发布确认。" },
    { icon: <History size={16} />, title: "查看编辑记录", subtitle: "回看个人沉淀过程", feedback: "已打开个人知识编辑记录。" },
  ]} infoTitle="文档属性" properties={[
    { icon: <FileText size={16} />, label: "空间", value: "个人知识库" },
    ...(item.project ? [{ icon: <FolderClosed size={16} />, label: "关联项目", value: item.project }] : []),
    { icon: <CheckCircle2 size={16} />, label: "状态", value: "本人可编辑" },
    { icon: <History size={16} />, label: "最后更新", value: item.updated },
    { icon: <Tags size={16} />, label: "标签", value: item.tags.join("、") },
  ]} note="个人知识只对本人可见。提交公共候选后仍需来源、内容和权限审查，原文不会被自动覆盖。" onFeedback={onFeedback} />;
}

function TaskStatusTools({ task, onReturnChat }: { task: TaskItem; onReturnChat: () => void }) {
  return <>
    <ToolSection title="任务操作">
      <button className="tool-action" type="button" onClick={onReturnChat}><ArrowLeft size={16} /><span><strong>返回来源会话</strong><small>继续查看或补充这项工作</small></span></button>
    </ToolSection>
    <ToolSection title="任务快照">
      <PropertyRow icon={<CheckCircle2 size={16} />} label="状态" value={taskStatusLabel(task.status)} />
      <PropertyRow icon={<FolderClosed size={16} />} label="项目关联" value={task.project_id ? "创建时已记录" : "未关联"} />
      <PropertyRow icon={<History size={16} />} label="最近运行" value={task.latest_run ?? "尚未运行"} />
      <PropertyRow icon={<FolderLock size={16} />} label="写入状态" value="未开始" />
    </ToolSection>
    <div className="tool-safety-note"><ShieldCheck size={16} /><p>当前只创建了持久任务。后续接入受控执行环境后，才会产生真实运行、检查点与停止原因。</p></div>
  </>;
}

function SkillStatusTools({ skill, onFeedback }: { skill: SkillItem; onFeedback: (message: string) => void }) {
  if (skill.status === "已发布") return <StatusToolLayout actionTitle="运行与版本" actions={[
    { icon: <Play size={16} />, title: "验证运行", subtitle: "使用已批准配置", feedback: "已创建一次受控验证运行，不会产生业务写入。" },
    { icon: <GitBranch size={16} />, title: "创建新版本", subtitle: "当前发布版本保持只读", feedback: "已从 " + skill.version + " 派生新的草稿版本。" },
    { icon: <History size={16} />, title: "查看运行记录", subtitle: skill.runs + " 次运行可追溯", feedback: "已打开 " + skill.runs + " 条技能运行记录。" },
  ]} infoTitle="发布信息" properties={[
    { icon: <WandSparkles size={16} />, label: "当前版本", value: skill.version },
    { icon: <CheckCircle2 size={16} />, label: "状态", value: "已发布 · 只读" },
    { icon: <ShieldCheck size={16} />, label: "审查", value: "数据与代码已通过" },
    { icon: <History size={16} />, label: "发布范围", value: "AI 团队" },
  ]} note="已发布版本不能直接修改。任何调整都从新草稿开始，并重新经过测试与审查。" onFeedback={onFeedback} />;

  if (skill.status === "测试中") return <StatusToolLayout actionTitle="测试与发布" actions={[
    { icon: <TestTube2 size={16} />, title: "继续样本测试", subtitle: "对照人工结果验证输出", feedback: "样本测试已启动，输出只保存在隔离测试区。" },
    { icon: <FileText size={16} />, title: "添加验证样本", subtitle: "补充边界与失败案例", feedback: "已创建新的验证样本槽位。" },
    { icon: <Rocket size={16} />, title: "提交发布审查", subtitle: "检查数据边界与代码风险", feedback: "发布审查已提交，等待代码审查完成。" },
  ]} infoTitle="测试进度" properties={[
    { icon: <WandSparkles size={16} />, label: "测试版本", value: skill.version },
    { icon: <CheckCircle2 size={16} />, label: "样本", value: skill.runs + " 次测试" },
    { icon: <ShieldCheck size={16} />, label: "数据审查", value: "已通过" },
    { icon: <History size={16} />, label: "代码审查", value: "等待中" },
  ]} note="测试中的技能仅能使用隔离样本；数据审查与代码审查全部通过后才能发布。" onFeedback={onFeedback} />;

  return <StatusToolLayout actionTitle="草稿配置" actions={[
    { icon: <WandSparkles size={16} />, title: "配置能力定义", subtitle: "设置输入、输出与调用规则", feedback: "已打开输入、输出与提示规则配置。" },
    { icon: <ShieldCheck size={16} />, title: "设置运行边界", subtitle: "知识范围、工具与写入权限", feedback: "已打开权限与数据边界配置。" },
    { icon: <TestTube2 size={16} />, title: "进入样本测试", subtitle: "先验证小样本，再提交审查", feedback: "草稿已进入样本测试阶段。" },
  ]} infoTitle="草稿信息" properties={[
    { icon: <WandSparkles size={16} />, label: "草稿版本", value: skill.version },
    { icon: <CheckCircle2 size={16} />, label: "状态", value: "仅创建者可见" },
    { icon: <History size={16} />, label: "试运行", value: skill.runs + " 次" },
    { icon: <ShieldCheck size={16} />, label: "发布审查", value: "未开始" },
  ]} note="草稿不能用于正式任务。完成能力定义与运行边界后，才能进入测试阶段。" onFeedback={onFeedback} />;
}

function WorkflowStatusTools({ workflow, onFeedback }: { workflow: WorkflowItem; onFeedback: (message: string) => void }) {
  if (workflow.status === "已发布") return <StatusToolLayout actionTitle="运行与版本" actions={[
    { icon: <Play size={16} />, title: "运行工作流", subtitle: "使用已发布步骤与权限", feedback: "已创建一次受控运行，写入仍需人工确认。" },
    { icon: <GitBranch size={16} />, title: "创建新版本", subtitle: "复制步骤、技能与权限", feedback: "已从 " + workflow.version + " 创建工作流草稿。" },
    { icon: <History size={16} />, title: "查看运行记录", subtitle: "检查节点耗时与人工确认", feedback: "已打开 " + workflow.runs + " 条工作流运行记录。" },
  ]} infoTitle="发布信息" properties={[
    { icon: <GitBranch size={16} />, label: "当前版本", value: workflow.version },
    { icon: <CheckCircle2 size={16} />, label: "状态", value: "已发布 · 只读" },
    { icon: <History size={16} />, label: "步骤", value: workflow.steps.length + " 个" },
    { icon: <ShieldCheck size={16} />, label: "写入方式", value: "确认后应用" },
  ]} note="已发布流程的步骤和权限保持锁定。修改必须派生新版本并重新验证每个节点。" onFeedback={onFeedback} />;

  if (workflow.status === "测试中") return <StatusToolLayout actionTitle="流程测试" actions={[
    { icon: <TestTube2 size={16} />, title: "继续试运行", subtitle: "逐步检查输入与输出", feedback: "隔离试运行已启动，不会应用任何修改。" },
    { icon: <GitBranch size={16} />, title: "校验流程步骤", subtitle: "检查技能、权限和人工节点", feedback: "步骤校验完成，发现 1 个待确认节点。" },
    { icon: <Rocket size={16} />, title: "提交发布审查", subtitle: "逐步审查依赖与写入边界", feedback: "工作流发布审查已提交。" },
  ]} infoTitle="测试进度" properties={[
    { icon: <GitBranch size={16} />, label: "测试版本", value: workflow.version },
    { icon: <CheckCircle2 size={16} />, label: "已验证步骤", value: Math.max(workflow.steps.length - 1, 1) + " / " + workflow.steps.length },
    { icon: <History size={16} />, label: "试运行", value: workflow.runs + " 次" },
    { icon: <ShieldCheck size={16} />, label: "发布审查", value: "待完成" },
  ]} note="测试流程只能使用隔离材料。所有技能依赖、权限和人工节点验证完成后才能发布。" onFeedback={onFeedback} />;

  return <StatusToolLayout actionTitle="草稿编排" actions={[
    { icon: <GitBranch size={16} />, title: "编辑执行步骤", subtitle: "添加技能与人工确认节点", feedback: "已打开步骤编排界面。" },
    { icon: <ShieldCheck size={16} />, title: "配置步骤权限", subtitle: "为每个节点设置最小权限", feedback: "已打开逐步权限配置。" },
    { icon: <TestTube2 size={16} />, title: "进入流程测试", subtitle: "验证顺序、回退与人工节点", feedback: "工作流草稿已进入隔离测试。" },
  ]} infoTitle="草稿信息" properties={[
    { icon: <GitBranch size={16} />, label: "草稿版本", value: workflow.version },
    { icon: <CheckCircle2 size={16} />, label: "状态", value: "仅创建者可见" },
    { icon: <History size={16} />, label: "步骤", value: workflow.steps.length + " 个" },
    { icon: <ShieldCheck size={16} />, label: "发布审查", value: "未开始" },
  ]} note="草稿工作流不能用于正式任务。完成步骤、权限和失败回退配置后，才能开始测试。" onFeedback={onFeedback} />;
}

function ToolSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="tool-section"><h2>{title}</h2><div>{children}</div></section>;
}

function ToolSelect({ icon, label, value, options, onChange }: { icon: React.ReactNode; label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={open ? "tool-select is-open" : "tool-select"} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
      <span className="tool-select__label">{icon}<small>{label}</small></span>
      <button className="tool-select__control" type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <strong>{value}</strong>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="tool-select__menu" role="listbox" aria-label={`${label}选项`}>
          {options.map((option) => (
            <button className={option === value ? "is-selected" : ""} type="button" role="option" aria-selected={option === value} key={option} onClick={() => { onChange(option); setOpen(false); }}>
              <span>{option}</span>{option === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PropertyRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="tool-property">{icon}<span><small>{label}</small><strong>{value}</strong></span></div>;
}
