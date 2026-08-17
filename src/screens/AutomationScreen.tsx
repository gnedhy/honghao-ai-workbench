import { CheckCircle2, Clock3, FileInput, FileOutput, GitBranch, Play, Plus, Search, ShieldCheck, WandSparkles, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SegmentedControl } from "../components/SegmentedControl";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import { skills, workflows } from "../data";
import type { SkillItem, WorkflowItem } from "../types";

type AutomationScreenProps = ScreenChromeProps & {
  tab: "技能" | "工作流";
  onTabChange: (tab: "技能" | "工作流") => void;
  selectedSkill: SkillItem;
  onSelectedSkillChange: (skill: SkillItem) => void;
  selectedWorkflow: WorkflowItem;
  onSelectedWorkflowChange: (workflow: WorkflowItem) => void;
};

const skillMeta = {
  "需求诊断": { owner: "AI 项目组", updated: "今天 09:48", quality: "24 / 26", lastRun: "12 分钟前", inputs: ["访谈记录", "需求描述", "会议纪要"], outputs: ["需求诊断卡", "风险与缺口", "下一步验证"], review: ["样本验证通过", "数据边界审查通过", "代码审查通过"] },
  "项目状态更新": { owner: "项目运营组", updated: "昨天 16:20", quality: "7 / 8", lastRun: "昨天 17:05", inputs: ["任务运行记录", "人工确认结果"], outputs: ["项目状态", "阻塞项", "下周动作"], review: ["样本验证中", "数据边界审查通过", "等待代码审查"] },
  "知识沉淀建议": { owner: "知识治理组", updated: "8 月 15 日", quality: "3 / 3", lastRun: "8 月 15 日", inputs: ["任务结果", "对话摘要"], outputs: ["个人知识候选", "来源说明"], review: ["小样本验证通过", "仅限个人知识", "发布审查未开始"] },
} as const;

function statusClass(status: string) {
  return status === "已发布" ? "is-published" : status === "测试中" ? "is-testing" : "is-draft";
}

export function AutomationScreen({ contextOpen, onOpenNavigation, onToggleContext, tab, onTabChange, selectedSkill, onSelectedSkillChange, selectedWorkflow, onSelectedWorkflowChange }: AutomationScreenProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSkills = useMemo(() => skills.filter((skill) => !normalizedQuery || `${skill.title} ${skill.description} ${skill.status}`.toLowerCase().includes(normalizedQuery)), [normalizedQuery]);
  const visibleWorkflows = useMemo(() => workflows.filter((workflow) => !normalizedQuery || `${workflow.title} ${workflow.description} ${workflow.status}`.toLowerCase().includes(normalizedQuery)), [normalizedQuery]);

  useEffect(() => {
    if (tab === "技能" && visibleSkills.length > 0 && !visibleSkills.some((skill) => skill.title === selectedSkill.title)) onSelectedSkillChange(visibleSkills[0]);
    if (tab === "工作流" && visibleWorkflows.length > 0 && !visibleWorkflows.some((workflow) => workflow.title === selectedWorkflow.title)) onSelectedWorkflowChange(visibleWorkflows[0]);
  }, [normalizedQuery, onSelectedSkillChange, onSelectedWorkflowChange, selectedSkill.title, selectedWorkflow.title, tab, visibleSkills, visibleWorkflows]);

  return (
    <main className="app-main">
      <TopBar title="自动化" subtitle={tab === "技能" ? "企业能力库" : "流程编排"} tabs={<SegmentedControl value={tab} options={["技能", "工作流"] as const} onChange={(value) => { setQuery(""); onTabChange(value); }} label="自动化类型" />} action={<button className="primary-button header-action" type="button"><Plus size={16} /><span>{tab === "技能" ? "创建技能" : "创建工作流"}</span></button>} contextOpen={contextOpen} onOpenNavigation={onOpenNavigation} onToggleContext={onToggleContext} />
      {tab === "技能" ? <SkillLibrary query={query} onQueryChange={setQuery} visibleSkills={visibleSkills} selectedSkill={selectedSkill} onSelectedSkillChange={onSelectedSkillChange} onOpenTools={onToggleContext} /> : <WorkflowLibrary query={query} onQueryChange={setQuery} visibleWorkflows={visibleWorkflows} selectedWorkflow={selectedWorkflow} onSelectedWorkflowChange={onSelectedWorkflowChange} onOpenTools={onToggleContext} />}
    </main>
  );
}

function SkillLibrary({ query, onQueryChange, visibleSkills, selectedSkill, onSelectedSkillChange, onOpenTools }: { query: string; onQueryChange: (value: string) => void; visibleSkills: SkillItem[]; selectedSkill: SkillItem; onSelectedSkillChange: (skill: SkillItem) => void; onOpenTools: () => void }) {
  const activeSkill = visibleSkills.find((skill) => skill.title === selectedSkill.title) ?? visibleSkills[0] ?? selectedSkill;
  const meta = skillMeta[activeSkill.title as keyof typeof skillMeta];
  const completedReviews = activeSkill.status === "已发布" ? 3 : activeSkill.status === "测试中" ? 2 : 1;

  return <section className="workspace-layout workspace-layout--skills">
    <aside className="workspace-list-panel skill-index">
      <div className="workspace-panel-title"><div><h1>技能库</h1><p>经过版本管理的企业能力</p></div></div>
      <label className="search-field"><Search size={16} /><input aria-label="搜索技能" placeholder="搜索名称、用途或状态" value={query} onChange={(event) => onQueryChange(event.target.value)} /></label>
      <div className="workspace-list-summary"><span>{visibleSkills.length} 个技能</span><span>{skills.filter((skill) => skill.status === "已发布").length} 个已发布</span></div>
      <div className="item-list skill-item-list">
        {visibleSkills.map((skill) => <button className={activeSkill.title === skill.title ? "list-item skill-list-item is-active" : "list-item skill-list-item"} type="button" key={skill.title} onClick={() => onSelectedSkillChange(skill)}><WandSparkles className="skill-list-item__icon" size={17} /><span className="skill-list-item__copy"><strong>{skill.title}</strong><small>{skill.version} · {skill.description}</small></span><span className="skill-list-item__meta"><em className={statusClass(skill.status)}>{skill.status}</em><small>{skill.runs} 次</small></span></button>)}
        {visibleSkills.length === 0 && <WorkspaceEmpty label="技能" />}
      </div>
    </aside>
    <article className="skill-detail skill-console" key={activeSkill.title}>
      <header className="skill-console__hero"><div className="skill-console__eyebrow"><span className={`skill-status ${statusClass(activeSkill.status)}`}>{activeSkill.status}</span><span>{activeSkill.version}</span><span>{meta.owner}</span></div><div className="skill-console__title-row"><div><h1>{activeSkill.title}</h1><p>{activeSkill.description}</p></div><button className="secondary-button skill-console__test" type="button" onClick={onOpenTools}><Play size={15} />运行设置</button></div><div className="skill-console__updated"><Clock3 size={14} />最近更新于 {meta.updated}</div></header>
      <div className="skill-metrics" aria-label="技能运行概览"><div><small>累计运行</small><strong>{activeSkill.runs}</strong><span>次</span></div><div><small>样本通过</small><strong>{meta.quality}</strong><span>已验证样本</span></div><div><small>最近运行</small><strong>{meta.lastRun}</strong><span>运行记录可追溯</span></div></div>
      <section className="skill-definition"><SectionHeading label="能力定义" title="输入与输出" description="调用前先校验输入，输出只生成候选内容。" /><div className="skill-io-grid"><article><div><FileInput size={17} /><strong>可接收输入</strong></div><ul>{meta.inputs.map((input) => <li key={input}>{input}</li>)}</ul></article><article><div><FileOutput size={17} /><strong>标准化输出</strong></div><ul>{meta.outputs.map((output) => <li key={output}>{output}</li>)}</ul></article></div></section>
      <section className="skill-governance"><SectionHeading label="发布治理" title="验证与审查" description="发布前必须同时满足样本、数据和代码审查。" /><div className="skill-review-list">{meta.review.map((item, index) => <div key={item}><span className={index < completedReviews ? "is-done" : "is-pending"}>{index < completedReviews ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}</span><strong>{item}</strong><small>{index === 0 ? "样本输出与人工结果对照" : index === 1 ? "权限、敏感信息与出站边界" : "依赖、工具调用与写入风险"}</small></div>)}</div><div className="skill-safety-note"><ShieldCheck size={17} /><p>涉及文件或系统写入时，必须生成 ChangeSet 并等待人工确认。</p></div></section>
    </article>
  </section>;
}

function WorkflowLibrary({ query, onQueryChange, visibleWorkflows, selectedWorkflow, onSelectedWorkflowChange, onOpenTools }: { query: string; onQueryChange: (value: string) => void; visibleWorkflows: WorkflowItem[]; selectedWorkflow: WorkflowItem; onSelectedWorkflowChange: (workflow: WorkflowItem) => void; onOpenTools: () => void }) {
  const activeWorkflow = visibleWorkflows.find((workflow) => workflow.title === selectedWorkflow.title) ?? visibleWorkflows[0] ?? selectedWorkflow;

  return <section className="workspace-layout workspace-layout--workflows">
    <aside className="workspace-list-panel workflow-index">
      <div className="workspace-panel-title"><div><h1>工作流库</h1><p>可复用的多步骤执行流程</p></div></div>
      <label className="search-field"><Search size={16} /><input aria-label="搜索工作流" placeholder="搜索名称、用途或状态" value={query} onChange={(event) => onQueryChange(event.target.value)} /></label>
      <div className="workspace-list-summary"><span>{visibleWorkflows.length} 条工作流</span><span>{workflows.reduce((total, workflow) => total + workflow.runs, 0)} 次运行</span></div>
      <div className="item-list workflow-item-list">
        {visibleWorkflows.map((workflow) => <button className={activeWorkflow.title === workflow.title ? "list-item workflow-list-item is-active" : "list-item workflow-list-item"} type="button" key={workflow.title} onClick={() => onSelectedWorkflowChange(workflow)}><GitBranch className="workflow-list-item__icon" size={17} /><span className="workflow-list-item__copy"><strong>{workflow.title}</strong><small>{workflow.steps.length} 个步骤 · {workflow.description}</small></span><span className="workflow-list-item__meta"><em className={statusClass(workflow.status)}>{workflow.status}</em><small>{workflow.runs} 次</small></span></button>)}
        {visibleWorkflows.length === 0 && <WorkspaceEmpty label="工作流" />}
      </div>
    </aside>
    <article className="workflow-console" key={activeWorkflow.title}>
      <header className="skill-console__hero"><div className="skill-console__eyebrow"><span className={`skill-status ${statusClass(activeWorkflow.status)}`}>{activeWorkflow.status}</span><span>{activeWorkflow.version}</span><span>{activeWorkflow.owner}</span></div><div className="skill-console__title-row"><div><h1>{activeWorkflow.title}</h1><p>{activeWorkflow.description}</p></div><button className="secondary-button skill-console__test" type="button" onClick={onOpenTools}><Play size={15} />运行设置</button></div><div className="skill-console__updated"><Clock3 size={14} />最近更新于 {activeWorkflow.updated}</div></header>
      <div className="skill-metrics" aria-label="工作流运行概览"><div><small>流程步骤</small><strong>{activeWorkflow.steps.length}</strong><span>个节点</span></div><div><small>累计运行</small><strong>{activeWorkflow.runs}</strong><span>次</span></div><div><small>写入方式</small><strong>ChangeSet</strong><span>人工确认后应用</span></div></div>
      <section className="workflow-definition"><SectionHeading label="流程编排" title="执行路径" description="步骤按顺序执行，人工确认节点不会自动跳过。" /><ol className="workflow-path">{activeWorkflow.steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{step}</strong><small>{index === activeWorkflow.steps.length - 1 ? "人工确认节点" : index === 1 ? "安全检查节点" : "自动执行节点"}</small></div>{index < activeWorkflow.steps.length - 1 && <i />}</li>)}</ol></section>
      <section className="workflow-governance"><SectionHeading label="运行边界" title="发布与执行规则" description="工作流负责串联能力，不扩大任何技能的原有权限。" /><div className="workflow-rule-list"><div><ShieldCheck size={17} /><span><strong>最小权限</strong><p>每个步骤只获得完成当前操作所需的知识和目录权限。</p></span></div><div><CheckCircle2 size={17} /><span><strong>人工确认</strong><p>公共知识、项目文件与外部系统写入都必须经过确认。</p></span></div></div></section>
    </article>
  </section>;
}

function SectionHeading({ label, title, description }: { label: string; title: string; description: string }) {
  return <div className="skill-section-heading"><div><span>{label}</span><h2>{title}</h2></div><p>{description}</p></div>;
}

function WorkspaceEmpty({ label }: { label: string }) {
  return <div className="workspace-empty"><Search size={18} /><strong>没有匹配{label}</strong><p>换一个名称或用途试试。</p></div>;
}
