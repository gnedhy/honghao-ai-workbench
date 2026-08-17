import { ChevronRight, MoreHorizontal, Play, Plus, Search, WandSparkles, Workflow } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "../components/SegmentedControl";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import { skills } from "../data";
import type { SkillItem } from "../types";

type AutomationScreenProps = ScreenChromeProps & {
  selectedSkill: SkillItem;
  onSelectedSkillChange: (skill: SkillItem) => void;
};

export function AutomationScreen({ contextOpen, onOpenNavigation, onToggleContext, selectedSkill, onSelectedSkillChange }: AutomationScreenProps) {
  const [tab, setTab] = useState<"技能" | "工作流">("技能");

  return (
    <main className="app-main">
      <TopBar
        title="自动化"
        subtitle={tab === "技能" ? "企业能力库" : "流程编排"}
        tabs={<SegmentedControl value={tab} options={["技能", "工作流"] as const} onChange={setTab} label="自动化类型" />}
        action={<button className="primary-button header-action" type="button"><Plus size={16} /><span>{tab === "技能" ? "创建技能" : "创建工作流"}</span></button>}
        contextOpen={contextOpen}
        onOpenNavigation={onOpenNavigation}
        onToggleContext={onToggleContext}
      />
      {tab === "技能" ? (
        <section className="workspace-layout">
          <aside className="workspace-list-panel">
            <div className="workspace-panel-title"><div><h1>技能</h1><p>版本化的企业能力</p></div><button className="icon-button" type="button"><MoreHorizontal size={17} /></button></div>
            <label className="search-field"><Search size={16} /><input aria-label="搜索技能" placeholder="搜索技能" /></label>
            <div className="item-list">
              {skills.map((skill) => (
                <button className={selectedSkill.title === skill.title ? "list-item is-active" : "list-item"} type="button" key={skill.title} onClick={() => onSelectedSkillChange(skill)}>
                  <WandSparkles size={17} />
                  <span><strong>{skill.title}</strong><small>{skill.version} · {skill.status} · {skill.runs} 次运行</small></span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          </aside>
          <article className="skill-detail">
            <div className="detail-heading">
              <div><span className="status-dot status-dot--green" />{selectedSkill.status}</div>
              <h1>{selectedSkill.title}</h1>
              <p>{selectedSkill.description}</p>
            </div>
            <section className="skill-section"><h2>输入与输出</h2><div className="code-surface"><code>输入：访谈记录、需求描述、会议纪要</code><code>输出：需求诊断卡、风险与下一步验证</code></div></section>
          </article>
        </section>
      ) : (
        <section className="workflow-overview">
          <div className="workflow-overview__heading"><div><h1>AI 需求诊断工作流</h1><p>固定流程 · v1.0 · 最近运行于 10 分钟前</p></div><button className="primary-button" type="button"><Play size={16} />运行</button></div>
          <div className="workflow-rail">
            {["接收材料", "数据边界检查", "检索知识", "调用需求诊断", "人工确认 ChangeSet"].map((step, index) => (
              <div className="workflow-node" key={step}><span>{index + 1}</span><div><strong>{step}</strong><small>{index === 4 ? "人工审批节点" : "自动执行节点"}</small></div>{index < 4 && <ChevronRight size={17} />}</div>
            ))}
          </div>
          <article className="workflow-note"><Workflow size={18} /><div><strong>写入边界</strong><p>工作流只生成 ChangeSet。未经人工批准，不会写入项目卡或公共知识。</p></div></article>
        </section>
      )}
    </main>
  );
}
