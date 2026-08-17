import { Check, Circle, Info, MoreHorizontal, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { Composer } from "../components/Composer";
import { SegmentedControl } from "../components/SegmentedControl";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import { runSteps } from "../data";
import type { ConversationView, WorkApproval } from "../types";

type ConversationScreenProps = ScreenChromeProps & {
  view: ConversationView;
  conversationTitle: string;
  mode: "聊天" | "工作";
  onModeChange: (mode: "聊天" | "工作") => void;
};

export function ConversationScreen({ contextOpen, onOpenNavigation, onToggleContext, view, conversationTitle, mode, onModeChange }: ConversationScreenProps) {
  const [approval, setApproval] = useState<WorkApproval>("pending");
  const [lastMessage, setLastMessage] = useState("");

  return (
    <main className="app-main conversation-screen">
      <TopBar
        title={view === "new" ? "新聊天" : conversationTitle}
        subtitle={view === "new" ? (mode === "工作" ? "新工作" : "个人智能体") : mode === "工作" ? "正在执行 · 等待确认" : "已有对话"}
        tabs={<SegmentedControl value={mode} options={["聊天", "工作"] as const} onChange={onModeChange} label="会话模式" />}
        minimal={view === "new"}
        contextOpen={contextOpen}
        onOpenNavigation={onOpenNavigation}
        onToggleContext={onToggleContext}
      />

      {view === "new" ? (
        <section key={mode} className={`new-conversation-empty new-conversation-empty--${mode === "工作" ? "work" : "chat"}`}>
          <div className="new-conversation-empty__content">
            <h1>{mode === "工作" ? "我们该处理什么工作？" : "随时可以开始。"}</h1>
            <Composer compact={mode === "聊天"} empty mode={mode} onSubmit={setLastMessage} />
          </div>
        </section>
      ) : mode === "聊天" ? (
        <section className="existing-chat-thread">
          <div className="existing-chat-thread__messages">
            <div className="chat-turn chat-turn--user">
              <p>请帮我梳理这个需求里需要优先确认的关键问题。</p>
            </div>
            <div className="chat-tool-event"><Search size={14} /><span>已检索个人知识与公共知识</span></div>
            <div className="chat-turn chat-turn--assistant">
              <p>围绕“{conversationTitle}”，建议先确认业务目标、知识与数据边界、输出用途，以及最终由谁验收。涉及文件写入或公共知识发布时，仍需单独确认。</p>
            </div>
            {lastMessage && <div className="chat-turn chat-turn--user"><p>{lastMessage}</p></div>}
          </div>
          <Composer compact mode="聊天" onSubmit={setLastMessage} />
        </section>
      ) : (
        <section className="work-thread">
          <div className="work-thread__messages">
            <div className="chat-turn chat-turn--user">
              <p>请根据访谈材料整理 AI 需求诊断卡，并生成项目卡草案。</p>
            </div>

            <div className="work-tool-event"><Sparkles size={14} /><span>已调用需求诊断技能与工作流</span></div>
            <div className="work-turn">
              <div className="assistant-response">
                <p>好的，我已基于访谈材料与企业知识进行分析，正在按流程执行需求诊断。完成后会生成需求诊断卡（草案），并准备项目卡草案。等你的确认。</p>
                <div className="run-summary">
                  <strong>正在执行 · 4/5</strong>
                  <ol className="run-steps">
                    {runSteps.map((step) => (
                      <li className={`run-step run-step--${step.state}`} key={step.label}>
                        <span className="run-step__marker" aria-hidden="true">
                          {step.state === "done" ? <Check size={11} /> : <Circle size={9} />}
                        </span>
                        <span>{step.label}</span>
                        <time>{step.time}</time>
                        <span className="run-step__detail">{step.detail}</span>
                      </li>
                    ))}
                  </ol>
                </div>

              <article className="diagnosis-document">
                <h2>需求诊断卡（草案）</h2>
                <ul>
                  <li><strong>已确认事实：</strong>业务目标明确，需构建统一的 AI 咨询助手，覆盖人力、财务、行政、法务四部门，优先场景为制度查询与流程指引。</li>
                  <li><strong>初步判断：</strong>知识资产可支撑，建议采用 RAG + 权限过滤方案；预计可减少 40% 的重复咨询工单。</li>
                  <li><strong>缺失信息与风险：</strong>部分历史制度文档缺少结构化标签；权限边界需进一步明确，存在越权访问风险。</li>
                  <li><strong>建议下一步：</strong>完成授权范围与 A/B 测试方案设计；补充 OCR 与结构化处理规则；确认验收指标与里程碑计划。</li>
                </ul>
                <p className="citation-line">引用：个人知识 3 条 · 公共知识 15 条 · 需求诊断技能 v1.0 · 工作流 v1.0</p>
              </article>

              <article className={`changeset changeset--${approval}`}>
                <div className="changeset__header">
                  <div>
                    <h2>{approval === "pending" ? "待确认修改" : approval === "approved" ? "修改已应用" : "修改已拒绝"}</h2>
                    <p>将创建项目卡文件（Markdown）：knowledge/diagnosis_cards/20250520_cross_dept.md</p>
                  </div>
                  <button className="icon-button" type="button" aria-label="修改内容更多操作"><MoreHorizontal size={17} /></button>
                </div>
                <div className="diff-view" aria-label="文件差异预览">
                  <span className="diff-view__line-number">1</span><code>@@ -0,0 +1,12 @@</code>
                  <span className="diff-view__line-number">2</span><code>+ # 跨部门 AI 需求诊断卡</code>
                  <span className="diff-view__line-number">3</span><code>+ 版本：v0.1（草案）</code>
                  <span className="diff-view__line-number">4</span><code>+ 生成时间：2025-05-20 10:14:36</code>
                  <span className="diff-view__line-number">5</span><code>+ 生成者：宏昊 AI（需求诊断技能 v1.0）</code>
                  <span className="diff-view__line-number">6</span><code>+ 状态：待人工确认</code>
                </div>
                <div className="changeset__footer">
                  <p><Info size={16} />确认前不会写入项目卡或公共知识库。</p>
                  {approval === "pending" ? (
                    <div className="changeset__actions">
                      <button className="secondary-button" type="button" onClick={() => setApproval("rejected")}>拒绝</button>
                      <button className="primary-button" type="button" onClick={() => setApproval("approved")}>确认并应用</button>
                    </div>
                  ) : (
                    <button className="secondary-button" type="button" onClick={() => setApproval("pending")}>恢复待确认</button>
                  )}
                </div>
              </article>
              </div>
            </div>
          </div>

          <Composer mode="工作" onSubmit={setLastMessage} />
        </section>
      )}
    </main>
  );
}
