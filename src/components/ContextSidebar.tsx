import {
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  FileText,
  History,
  PanelRightClose,
  ShieldCheck,
  WandSparkles,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Section } from "../types";

type ContextSidebarProps = {
  section: Section;
  open: boolean;
  onClose: () => void;
  onOpenTasks: () => void;
};

type ContextData = {
  title: string;
  subtitle: string;
  status: string;
  statusTone: "active" | "ready" | "waiting";
  groups: Array<{
    label: string;
    items: Array<{ icon: LucideIcon; title: string; detail: string }>;
  }>;
};

const contextBySection: Record<Section, ContextData> = {
  chat: {
    title: "任务上下文",
    subtitle: "跨部门 AI 需求诊断",
    status: "等待确认",
    statusTone: "waiting",
    groups: [
      {
        label: "本次运行",
        items: [
          { icon: Clock3, title: "RUN-003 · 4/5", detail: "停在 ChangeSet 审批节点" },
          { icon: Bot, title: "企业模型", detail: "工作模式 · 受控执行" },
        ],
      },
      {
        label: "已使用资源",
        items: [
          { icon: Database, title: "知识范围", detail: "个人 3 条 · 公共 15 条" },
          { icon: WandSparkles, title: "需求诊断 Skill", detail: "v1.0 · 已校验" },
          { icon: Workflow, title: "需求诊断 Workflow", detail: "v1.0 · 人工审批" },
        ],
      },
      {
        label: "安全边界",
        items: [
          { icon: ShieldCheck, title: "受控工作目录", detail: "写入前必须再次确认" },
        ],
      },
    ],
  },
  knowledge: {
    title: "知识上下文",
    subtitle: "个人知识库",
    status: "可编辑",
    statusTone: "ready",
    groups: [
      {
        label: "当前文档",
        items: [
          { icon: FileText, title: "需求诊断方法", detail: "Markdown · 今天 09:40" },
          { icon: History, title: "版本与来源", detail: "来源可追溯 · 尚未发布" },
        ],
      },
      {
        label: "访问边界",
        items: [
          { icon: Database, title: "个人知识", detail: "仅本人和授权智能体可见" },
          { icon: ShieldCheck, title: "公共发布", detail: "需独立发布确认" },
        ],
      },
    ],
  },
  automation: {
    title: "自动化上下文",
    subtitle: "需求诊断 Skill",
    status: "已发布",
    statusTone: "ready",
    groups: [
      {
        label: "当前版本",
        items: [
          { icon: WandSparkles, title: "Skill v1.0", detail: "AI 团队 · 今天 09:40" },
          { icon: CheckCircle2, title: "测试状态", detail: "最近测试通过 · 无写入" },
        ],
      },
      {
        label: "执行关系",
        items: [
          { icon: Workflow, title: "需求诊断 Workflow", detail: "人工确认后才可写入" },
          { icon: ShieldCheck, title: "代码与数据审查", detail: "发布前检查已启用" },
        ],
      },
    ],
  },
  tasks: {
    title: "任务上下文",
    subtitle: "跨部门 AI 需求诊断",
    status: "等待确认",
    statusTone: "waiting",
    groups: [
      {
        label: "任务状态",
        items: [
          { icon: Clock3, title: "TASK-20250520-001", detail: "当前运行 RUN-003" },
          { icon: WandSparkles, title: "需求诊断 v1.0", detail: "检查点：等待 ChangeSet" },
        ],
      },
      {
        label: "关联信息",
        items: [
          { icon: Bot, title: "来源会话", detail: "跨部门 AI 需求诊断" },
          { icon: ShieldCheck, title: "工作目录", detail: "受控目录 · 未发生写入" },
        ],
      },
    ],
  },
};

export function ContextSidebar({ section, open, onClose, onOpenTasks }: ContextSidebarProps) {
  const context = contextBySection[section];

  return (
    <>
      {open && <button className="context-backdrop" type="button" aria-label="关闭上下文栏" onClick={onClose} />}
      <aside className={open ? "context-sidebar is-open" : "context-sidebar"} aria-hidden={!open}>
        <header className="context-sidebar__header">
          <div>
            <span>{context.title}</span>
            <strong>{context.subtitle}</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="收起上下文栏">
            <PanelRightClose size={18} />
          </button>
        </header>

        <div className="context-sidebar__body">
          <div className="context-status">
            <span className={`context-status__dot context-status__dot--${context.statusTone}`} />
            <div><span>当前状态</span><strong>{context.status}</strong></div>
          </div>

          {context.groups.map((group) => (
            <section className="context-group" key={group.label}>
              <h2>{group.label}</h2>
              <div>
                {group.items.map(({ icon: Icon, title, detail }) => (
                  <div className="context-row" key={title}>
                    <Icon size={16} strokeWidth={1.7} />
                    <span><strong>{title}</strong><small>{detail}</small></span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="context-sidebar__footer">
          <button className="secondary-button" type="button" onClick={onOpenTasks}>
            <History size={16} />查看任务与运行记录
          </button>
        </footer>
      </aside>
    </>
  );
}
