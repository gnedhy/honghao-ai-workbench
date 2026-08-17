import { BookOpen, CheckCircle2, Clock3, FileText, Plus, Search, ShieldCheck, Tags } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "../components/SegmentedControl";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import { knowledgeItems } from "../data";

type KnowledgeScreenProps = ScreenChromeProps & {
  selectedTitle: string;
  onSelectedTitleChange: (title: string) => void;
};

const scopeByTab = { "个人库": "个人知识", "公共库": "公共知识" } as const;

const knowledgeContent = {
  "AI 需求诊断方法": {
    category: "方法库 / 需求治理", status: "已沉淀",
    summary: "把一句话需求、访谈记录或会议纪要，整理成可判断、可拆解、可验证和可分流的 AI 需求诊断卡。",
    overview: "适用于业务需求尚不完整、需要先澄清事实与边界的场景。输出用于支持后续评审，不替代业务负责人做最终判断。",
    structure: [["已确认事实", "只记录材料中能够直接验证的信息，并保留原始出处。"], ["初步 AI 判断", "明确标记推断与假设，避免把模型判断写成既定事实。"], ["缺失信息与风险", "列出权限、数据、流程与验证样本方面仍需补齐的条件。"], ["人工确认与下一步", "指定确认人、验证样本和可执行的后续动作。"]],
    source: "来源于 AI 团队需求诊断实践，经本人确认后沉淀。",
  },
  "跨部门访谈问题清单": {
    category: "项目知识 / 访谈", status: "整理中",
    summary: "用于跨部门 AI 需求访谈的提问框架，帮助区分真实业务问题、既有流程限制和模型能力预期。",
    overview: "访谈按业务目标、当前做法、输入材料、输出责任和风险边界五个部分展开，避免从工具能力倒推需求。",
    structure: [["业务目标", "确认希望改变的结果、衡量方式和实际责任人。"], ["当前流程", "还原任务由谁发起、经过哪些步骤、在哪些节点出现损耗。"], ["材料与权限", "识别可用数据、敏感信息和最小授权范围。"], ["验收方式", "确定样本、人工确认门和失败时的回退方案。"]],
    source: "整理自跨部门访谈记录，仅保留通用提问框架。",
  },
  "企业知识发布规范": {
    category: "企业制度 / 知识治理", status: "已发布",
    summary: "规定个人知识进入公共知识库前的来源校验、内容审查、权限确认和版本发布流程。",
    overview: "公共知识必须具备明确的业务责任人、可追溯来源和适用范围。未经发布确认的内容只作为候选，不进入企业检索范围。",
    structure: [["来源核验", "确认原始材料、作者和有效期限，禁止无来源内容直接发布。"], ["内容审查", "区分事实、判断和建议，检查敏感信息与过期口径。"], ["权限确认", "按部门、岗位和项目范围设置最小可见权限。"], ["版本发布", "记录变更说明、审批人和生效时间，支持回退。"]],
    source: "由 AI 团队与数据安全审查共同维护。",
  },
  "ChangeSet 审批边界": {
    category: "安全规则 / 变更控制", status: "已发布",
    summary: "定义智能体对项目文件、公共知识和业务系统产生写入时，必须经过人工确认的边界。",
    overview: "智能体可以生成变更建议和差异预览，但不能绕过审批直接写入受控目录、公共知识库或外部业务系统。",
    structure: [["生成建议", "智能体输出目标、影响范围和可审阅的差异内容。"], ["安全检查", "检查敏感数据、越权访问和不可逆操作。"], ["人工审批", "由具备权限的业务负责人确认或拒绝变更。"], ["落地与留痕", "执行获批内容，并保存版本、审批人和运行记录。"]],
    source: "适用于工作模式产生的所有受控写入。",
  },
} as const;

export function KnowledgeScreen({ contextOpen, onOpenNavigation, onToggleContext, selectedTitle, onSelectedTitleChange }: KnowledgeScreenProps) {
  const [scopeTab, setScopeTab] = useState<keyof typeof scopeByTab>("个人库");
  const [query, setQuery] = useState("");
  const scope = scopeByTab[scopeTab];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = knowledgeItems.filter((item) => item.scope === scope && (!normalizedQuery || `${item.title} ${item.tags.join(" ")}`.toLowerCase().includes(normalizedQuery)));
  const activeItem = visibleItems.find((item) => item.title === selectedTitle) ?? visibleItems[0];
  const activeContent = activeItem ? knowledgeContent[activeItem.title as keyof typeof knowledgeContent] : null;

  return (
    <main className="app-main">
      <TopBar title="知识库" subtitle={`${knowledgeItems.filter((item) => item.scope === scope).length} 条内容`} tabs={<SegmentedControl value={scopeTab} options={["个人库", "公共库"] as const} onChange={(value) => { setScopeTab(value); setQuery(""); onSelectedTitleChange(knowledgeItems.find((item) => item.scope === scopeByTab[value])?.title ?? ""); }} label="知识范围" />} action={<button className="primary-button header-action" type="button"><Plus size={16} /><span>新建知识</span></button>} contextOpen={contextOpen} onOpenNavigation={onOpenNavigation} onToggleContext={onToggleContext} />
      <section className="workspace-layout workspace-layout--knowledge">
        <aside className="workspace-list-panel knowledge-index">
          <div className="workspace-panel-title"><div><h1>知识目录</h1><p>{scope === "个人知识" ? "只对你可见的沉淀" : "经审查发布的企业知识"}</p></div></div>
          <label className="search-field"><Search size={16} /><input aria-label="搜索知识" placeholder="搜索标题或标签" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="workspace-list-summary"><span>{visibleItems.length} 条结果</span><span>按更新时间排序</span></div>
          <div className="item-list knowledge-item-list">
            {visibleItems.map((item) => <button className={activeItem?.title === item.title ? "list-item knowledge-list-item is-active" : "list-item knowledge-list-item"} type="button" key={item.title} onClick={() => onSelectedTitleChange(item.title)}><FileText className="knowledge-list-item__icon" size={17} /><span className="knowledge-list-item__copy"><strong>{item.title}</strong><small><time>{item.updated}</time><span>{item.tags[0]}</span></small></span></button>)}
            {visibleItems.length === 0 && <div className="workspace-empty"><Search size={18} /><strong>没有匹配内容</strong><p>换一个标题或标签试试。</p></div>}
          </div>
        </aside>
        {activeItem && activeContent ? <article className="document-editor knowledge-reader" key={activeItem.title}>
          <header className="knowledge-reader__header"><div className="knowledge-reader__kicker"><span>{activeItem.scope}</span><span>{activeContent.category}</span></div><h1>{activeItem.title}</h1><p>{activeContent.summary}</p><div className="knowledge-reader__meta"><span><Clock3 size={14} />更新于 {activeItem.updated}</span><span><CheckCircle2 size={14} />{activeContent.status}</span><span><ShieldCheck size={14} />来源可追溯</span></div></header>
          <div className="knowledge-reader__layout">
            <nav className="document-outline" aria-label="本文目录"><span>本文目录</span><a href="#knowledge-overview">适用范围</a><a href="#knowledge-structure">知识结构</a><a href="#knowledge-source">来源与标签</a></nav>
            <div className="document-body document-body--knowledge">
              <section id="knowledge-overview" className="knowledge-lead"><BookOpen size={18} /><div><h2>适用范围</h2><p>{activeContent.overview}</p></div></section>
              <section id="knowledge-structure" className="knowledge-section"><div className="knowledge-section__heading"><span>结构</span><h2>知识结构</h2></div><ol className="knowledge-structure">{activeContent.structure.map(([title, body], index) => <li key={title}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{title}</strong><p>{body}</p></div></li>)}</ol></section>
              <section id="knowledge-source" className="knowledge-source"><div><ShieldCheck size={17} /><span><strong>来源说明</strong><p>{activeContent.source}</p></span></div><div className="knowledge-tags"><Tags size={15} />{activeItem.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></section>
            </div>
          </div>
        </article> : <div className="workspace-detail-empty"><BookOpen size={22} /><strong>选择一条知识开始阅读</strong></div>}
      </section>
    </main>
  );
}
