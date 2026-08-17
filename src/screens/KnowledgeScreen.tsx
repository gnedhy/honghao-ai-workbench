import { BookOpen, FileText, MoreHorizontal, Plus, Search, ShieldCheck, UserRound } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "../components/SegmentedControl";
import { knowledgeItems } from "../data";

export function KnowledgeScreen() {
  const [scope, setScope] = useState<"个人知识" | "公共知识">("个人知识");
  const [selected, setSelected] = useState(knowledgeItems[0].title);
  const visibleItems = knowledgeItems.filter((item) => item.scope === scope);
  const activeItem = knowledgeItems.find((item) => item.title === selected) ?? visibleItems[0];

  return (
    <main className="app-main">
      <header className="screen-header screen-header--centered-tabs">
        <SegmentedControl value={scope} options={["个人知识", "公共知识"] as const} onChange={(value) => { setScope(value); setSelected(knowledgeItems.find((item) => item.scope === value)?.title ?? ""); }} label="知识范围" />
        <button className="primary-button header-action" type="button"><Plus size={16} />新建知识</button>
      </header>
      <section className="workspace-layout">
        <aside className="workspace-list-panel">
          <div className="workspace-panel-title"><div><h1>知识</h1><p>{visibleItems.length} 条内容</p></div><button className="icon-button" type="button"><MoreHorizontal size={17} /></button></div>
          <label className="search-field"><Search size={16} /><input aria-label="搜索知识" placeholder="搜索标题、正文或标签" /></label>
          <div className="item-list">
            {visibleItems.map((item) => (
              <button className={activeItem?.title === item.title ? "list-item is-active" : "list-item"} type="button" key={item.title} onClick={() => setSelected(item.title)}>
                <FileText size={17} />
                <span><strong>{item.title}</strong><small>{item.updated} · {item.tags.join(" / ")}</small></span>
              </button>
            ))}
          </div>
        </aside>
        <article className="document-editor">
          <div className="document-editor__topline">
            <span>{scope === "个人知识" ? <UserRound size={16} /> : <ShieldCheck size={16} />}{scope}</span>
            <div><button className="secondary-button" type="button">导出 Markdown</button><button className="icon-button" type="button"><MoreHorizontal size={17} /></button></div>
          </div>
          <h1>{activeItem?.title}</h1>
          <p className="document-meta">最后更新：{activeItem?.updated} · 来源可追溯 · Markdown 正文</p>
          <div className="document-body">
            <h2>适用范围</h2>
            <p>用于将业务人员提供的一句话需求、访谈记录或会议纪要整理为可判断、可拆解、可验证和可分流的 AI 需求诊断卡。</p>
            <h2>诊断结构</h2>
            <ul><li>已确认事实</li><li>初步 AI 判断</li><li>缺失信息与风险</li><li>人工确认门与下一步验证</li></ul>
            <aside className="document-note"><BookOpen size={17} /><p>个人知识可由本人确认沉淀；公共知识必须经过独立发布确认。</p></aside>
          </div>
        </article>
      </section>
    </main>
  );
}
